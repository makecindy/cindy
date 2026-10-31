/**
 * piIdleReleaseWatcher —— 桌面普通及插件 pi 会话的空闲运行时回收。
 *
 * 背景(2026-10 实测 + upstream #5830)：`pi --mode rpc` 子进程每个约 150~300MB，
 * 普通会话此前没有任何 Idle TTL/LRU —— 只有退出应用、切换 Agent 或 Orca 工人
 * 走各自路径才会回收，长时间使用后进程数与内存持续累积、整机变卡、重启才恢复。
 * 这里为「本机、桌面普通或插件来源、非 Orca/bot」的 pi 会话补一个与
 * `orcaIdleReleaseWatcher` 同构的 watcher。
 *
 * 候选由 SQL 给出(闲置起点取 max(updated_at, last_turn_ended_at, user_send_at))，
 * 但真正的闸门在**拿到发送锁之后**重读活会话：回合在跑、有排队输入、有后台任务
 * (pi 子代理)、有 silent-stop 续跑认领、有已排定的自动续跑时一律跳过；锁内再用
 * 最新活动时间复核一次闲置阈值(扫描快照可能已经过期)。最后由 `closeIfIdle()`
 * 做一次同步的「检查 + 关闭预约」——它同时覆盖宿主发起的独占 RPC 操作
 * (手动压缩 / rewind / 切模)与并发发送；关闭失败或竞态只会让本轮跳过，下轮重试。
 *
 * 释放后下一次发送走既有 lazy create-session 透明重建(resume 自 sdk_session_id)，
 * 与冷启动语义一致，见 docs/dev-rules/pi-harness.md。
 */

import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { sessions } from '../localDb/schema.js';

/** Shared by the initial scan and the lock-protected recheck. */
export const piIdleReleaseIdleSince = () =>
  sql<number>`max(${sessions.updatedAt}, coalesce(${sessions.lastTurnEndedAt}, 0), coalesce(${sessions.userSendAt}, 0))`;

export const piIdleReleaseCandidateWhere = () =>
  and(
    eq(sessions.agentKind, 'pi'),
    inArray(sessions.status, ['active', 'archived']),
    // Plugin tasks are intentionally hidden, but their processes are host-owned.
    // Keep other hidden tasks and specialized lifecycle owners out of this scan.
    or(and(eq(sessions.source, 'desktop'), isNull(sessions.hiddenAt)), eq(sessions.source, 'plugin')),
    isNull(sessions.orcaRole),
    isNull(sessions.remoteHostId),
    isNull(sessions.agentDeviceId),
  );

/** 普通 pi 会话进入空闲回收前的闲置时长(分钟)。与远端 pi daemon 的 30min 口径一致。 */
export const DEFAULT_PI_IDLE_RELEASE_MINUTES = 30;

/** 扫描周期：比 TTL 小一个量级即可，单个扫描只查一次本地 sessions 表(数百行)。 */
export const DEFAULT_PI_IDLE_SCAN_INTERVAL_MS = 5 * 60_000;

/** SQL 侧选出的候选：只带回收决策需要的字段。 */
export interface PiIdleReleaseCandidate {
  /** 业务会话 id(Session.id)。 */
  id: string;
  /** 闲置起点：max(updated_at, last_turn_ended_at, user_send_at)，用于日志归因。 */
  idleSinceMs: number;
}

/** 运行时会话面：只暴露回收决策需要读的状态。 */
export interface PiIdleReleaseSession {
  isTurnRunning(): boolean;
  listBackgroundTasks(): readonly unknown[];
  countPendingWakeContinuations(): number;
  closeIfIdle(): Promise<boolean>;
}

/** Timer handle abstraction keeps the watcher deterministic under fake timers. */
export interface PiIdleReleaseTimer {
  setInterval(callback: () => void, intervalMs: number): ReturnType<typeof setInterval>;
  clearInterval(handle: ReturnType<typeof setInterval>): void;
}

export interface PiIdleReleaseWatcherDeps {
  /** `<= 0` 关闭回收(与 Orca 的 workerIdleReleaseMinutes 同语义)。 */
  readIdleReleaseMinutes(): number;
  listCandidates(idleBeforeMs: number): Promise<readonly PiIdleReleaseCandidate[]>;
  getSession(sessionId: string): PiIdleReleaseSession | null;
  withSessionLock<T>(sessionId: string, task: () => Promise<T>): Promise<T>;
  hasPendingInput(sessionId: string): Promise<boolean>;
  /** 锁内复核用：重读该会话的最新活动时间；`null` = 已不再符合候选条件。 */
  readIdleSinceMs(sessionId: string): Promise<number | null>;
  /** 已排定/在途的自动续跑(stall / idle / reconnect 等)未收口时不得释放。 */
  hasScheduledAutoResume(sessionId: string): boolean;
  now(): number;
  timer: PiIdleReleaseTimer;
  log: {
    info(message: string, details?: Record<string, unknown>): void;
    warn(message: string, details?: Record<string, unknown>): void;
  };
}

export interface PiIdleReleaseWatcher {
  start(): void;
  stop(): void;
  scanNow(): Promise<void>;
}

/**
 * 扫描是单飞的：一次扫描串行处理候选，单个候选失败只记 warn 并继续，
 * 好让下轮重试而不阻塞其它会话的回收。
 */
export function createPiIdleReleaseWatcher(
  deps: PiIdleReleaseWatcherDeps,
  scanIntervalMs = DEFAULT_PI_IDLE_SCAN_INTERVAL_MS,
): PiIdleReleaseWatcher {
  let timerHandle: ReturnType<typeof setInterval> | null = null;
  let scanInFlight = false;

  const scanNow = async (): Promise<void> => {
    if (scanInFlight) return;
    scanInFlight = true;
    try {
      const idleReleaseMinutes = deps.readIdleReleaseMinutes();
      if (idleReleaseMinutes <= 0) return;

      const idleBeforeMs = deps.now() - idleReleaseMinutes * 60_000;
      const candidates = await deps.listCandidates(idleBeforeMs);
      for (const candidate of candidates) {
        try {
          await deps.withSessionLock(candidate.id, async () => {
            // Maker 会话是进程内的：查不到说明本进程不持有该运行时
            // (共享 userData 的另一个实例在跑)，只有本进程的 owner 才能释放。
            const session = deps.getSession(candidate.id);
            if (!session) return;

            // 发送与回收共用这把锁，所以拿到锁之后再读活状态：
            // 刚被接受的 turn / 排队输入不会被这次扫描关掉。
            if (session.isTurnRunning()) return;
            if (session.listBackgroundTasks().length > 0) return;
            if (session.countPendingWakeContinuations() > 0) return;
            if (deps.hasScheduledAutoResume(candidate.id)) return;
            if (await deps.hasPendingInput(candidate.id)) return;

            // 候选是扫描开始时的快照：等锁期间用户可能已经发过消息、跑完一轮。
            // 用锁内的最新活动时间复核阈值，避免把刚用过的会话提前回收。
            const idleSinceMs = await deps.readIdleSinceMs(candidate.id);
            if (idleSinceMs === null) return;
            if (deps.now() - idleSinceMs < idleReleaseMinutes * 60_000) return;

            // 同步复查 + 关闭预约：并发发送要么先赢，要么看到 closePromise 被拒。
            const released = await session.closeIfIdle();
            if (!released) return;

            deps.log.info('piIdleWatcher: released idle session', {
              sessionId: candidate.id,
              idleMs: Math.max(0, deps.now() - idleSinceMs),
              idleThresholdMin: idleReleaseMinutes,
            });
          });
        } catch (err) {
          deps.log.warn('piIdleWatcher: release session failed', {
            sessionId: candidate.id,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      deps.log.warn('piIdleWatcher: scan failed', {
        err: err instanceof Error ? err.message : String(err),
      });
    } finally {
      scanInFlight = false;
    }
  };

  return {
    start() {
      if (timerHandle !== null) deps.timer.clearInterval(timerHandle);
      timerHandle = deps.timer.setInterval(() => {
        void scanNow();
      }, scanIntervalMs);
      deps.log.info('piIdleWatcher started');
    },
    stop() {
      if (timerHandle === null) return;
      deps.timer.clearInterval(timerHandle);
      timerHandle = null;
      deps.log.info('piIdleWatcher stopped');
    },
    scanNow,
  };
}
