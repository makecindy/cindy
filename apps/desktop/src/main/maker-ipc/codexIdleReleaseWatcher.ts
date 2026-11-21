/**
 * codexIdleReleaseWatcher —— 桌面普通及插件 codex 会话的空闲运行时回收。
 *
 * 背景(upstream #5830)：本机 codex 会话此前没有任何 Idle TTL —— 只有退出应用、
 * 切换 Agent 或 Orca 工人走各自路径才会回收，长时间使用后会话与 thread 运行时
 * 持续累积。pi 有 `piIdleReleaseWatcher`、普通 Claude 有 `claudeIdleReleaseWatcher`，
 * codex 此前是三类本地 Agent 里唯一没有回收路径的，这里补上同构的第三个 watcher。
 *
 * codex 的进程模型与 pi 不同（`app-server/host.ts`）：共享 app-server 子进程与
 * CodexAgent 同生命周期、不随会话数升降，一个会话对应 server 端一个 thread。
 * 会话关闭走 `subscription.release()`（thread/unsubscribe），释放的是该 thread 的
 * live runtime 与宿主侧会话资源；共享进程本身的回收属于另一条设计线，不在本
 * watcher 范围。`sdkSessionId` 即 threadId，释放后下一次发送走既有
 * lazy create-session 透明重建并 resume 该 thread，与冷启动语义一致。
 *
 * 候选由 SQL 给出(闲置起点取 max(updated_at, last_turn_ended_at, user_send_at))，
 * 真正的闸门在**拿到发送锁之后**重读活会话：回合在跑、有排队输入、有后台任务、
 * 有 silent-stop 续跑认领、有已排定的自动续跑、有用户还没回答的异步问题、
 * 或正处于 codex 凭证切换 / 软重启兑现窗口时一律跳过；锁内再用最新活动时间
 * 复核一次闲置阈值。最后交给宿主侧的关闭 seam 做一次「检查 + 关闭预约」——
 * 关闭失败或竞态只会让本轮跳过，下轮重试。
 *
 * 关闭必须走 Maker 的 `runtime-refresh` 原因（与 Claude 回收路径同口径）：直接
 * `session.close()` 会被当成 unexpected 关闭，onClose 随之清掉该会话的暂存附件，
 * 用户之后回来读原附件就会扑空。待答的异步问题（codex 的
 * `request_user_input_async`）也不该被回收静默作废，所以有待答问题时跳过。
 */

import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Session } from '@cindy/maker-core';
import { sessions } from '../localDb/schema.js';

/** Shared by the initial scan and the lock-protected recheck. */
export const codexIdleReleaseIdleSince = () =>
  sql<number>`max(${sessions.updatedAt}, coalesce(${sessions.lastTurnEndedAt}, 0), coalesce(${sessions.userSendAt}, 0))`;

export const codexIdleReleaseCandidateWhere = () =>
  and(
    eq(sessions.agentKind, 'codex'),
    inArray(sessions.status, ['active', 'archived']),
    // Plugin tasks are intentionally hidden, but their processes are host-owned.
    // Keep other hidden tasks and specialized lifecycle owners out of this scan.
    or(and(eq(sessions.source, 'desktop'), isNull(sessions.hiddenAt)), eq(sessions.source, 'plugin')),
    isNull(sessions.orcaRole),
    isNull(sessions.remoteHostId),
    isNull(sessions.agentDeviceId),
  );

/** 普通 codex 会话进入空闲回收前的闲置时长(分钟)。与 pi / Claude 的 30min 口径一致。 */
export const DEFAULT_CODEX_IDLE_RELEASE_MINUTES = 30;

/** 扫描周期：比 TTL 小一个量级即可，单个扫描只查一次本地 sessions 表(数百行)。 */
export const DEFAULT_CODEX_IDLE_SCAN_INTERVAL_MS = 5 * 60_000;

/** SQL 侧选出的候选：只带回收决策需要的字段。 */
export interface CodexIdleReleaseCandidate {
  /** 业务会话 id(Session.id)。 */
  id: string;
  /** 闲置起点：max(updated_at, last_turn_ended_at, user_send_at)，用于日志归因。 */
  idleSinceMs: number;
}

/** 运行时会话面：只暴露回收决策需要读的状态。 */
export interface CodexIdleReleaseSession {
  id: string;
  isTurnRunning(): boolean;
  listBackgroundTasks(): readonly unknown[];
  countPendingWakeContinuations(): number;
  /** 待答的异步问题（codex 的 `request_user_input_async`）：关掉会让它们失效。 */
  manageAsyncUserQuestions(input: { action: 'list' }): { questions?: readonly unknown[] };
}

/** Timer handle abstraction keeps the watcher deterministic under fake timers. */
export interface CodexIdleReleaseTimer {
  setInterval(callback: () => void, intervalMs: number): ReturnType<typeof setInterval>;
  clearInterval(handle: ReturnType<typeof setInterval>): void;
}

export interface CodexIdleReleaseWatcherDeps {
  /** `<= 0` 关闭回收(与 Orca 的 workerIdleReleaseMinutes 同语义)。 */
  readIdleReleaseMinutes(): number;
  listCandidates(idleBeforeMs: number): Promise<readonly CodexIdleReleaseCandidate[]>;
  getSession(sessionId: string): CodexIdleReleaseSession | null;
  withSessionLock<T>(sessionId: string, task: () => Promise<T>): Promise<T>;
  hasPendingInput(sessionId: string): Promise<boolean>;
  /** 锁内复核用：重读该会话的最新活动时间；`null` = 已不再符合候选条件。 */
  readIdleSinceMs(sessionId: string): Promise<number | null>;
  /** 已排定/在途的自动续跑(stall / idle / reconnect 等)未收口时不得释放。 */
  hasScheduledAutoResume(sessionId: string): boolean;
  /** codex 专属：凭证切换在途、deferred/gateway 软重启正在兑现该会话时不得释放。 */
  isCodexHostBusy(sessionId: string): boolean;
  /**
   * 释放运行时。宿主实现必须走 Maker 的 `runtime-refresh` 关闭路径（含副作用
   * 抑制），不得直接 `session.close()`：后者按 unexpected 关闭处理，会删掉用户
   * 之后仍要读的暂存附件。返回 false 表示本轮不释放（会话不空闲或已被占用）。
   */
  close(session: CodexIdleReleaseSession): Promise<boolean>;
  now(): number;
  timer: CodexIdleReleaseTimer;
  log: {
    info(message: string, details?: Record<string, unknown>): void;
    warn(message: string, details?: Record<string, unknown>): void;
  };
}

export interface CodexIdleReleaseWatcher {
  start(): void;
  stop(): void;
  scanNow(): Promise<void>;
}

/** 关闭 seam 需要的 Maker 能力（只要 runtime-refresh 这一条关闭路径）。 */
export interface CodexIdleReleaseCloseMaker {
  closeSessionIfCurrent(
    session: Session,
    reason: 'runtime-refresh',
    opts?: { onlyIfIdle?: boolean },
  ): Promise<'closed' | 'deferred' | void>;
}

/**
 * 回收用的关闭 seam：走 Maker 的 `runtime-refresh` 关闭路径 + 副作用抑制窗口。
 *
 * 为什么不能直接 `session.close()`：直接关会话没有关闭事实，Maker 会按
 * `unexpected` / `transient: false` 处理，onClose 随之删掉该会话的暂存附件——
 * 用户半小时后回来让 Agent 读原附件时文件已经没了。`runtime-refresh` 才是
 * 「刷新后重建」语义（与 Claude 回收路径、pi 资源漂移回收同口径）。
 *
 * `onlyIfIdle` 让 Maker 自己做同步的「检查 + 关闭预约」：并发发送要么先赢，
 * 要么看到关闭被拒；拒绝时返回 false，本轮跳过、下轮再试。
 */
export function createCodexIdleReleaseClose(
  resolveMaker: () => CodexIdleReleaseCloseMaker,
  withSuppressed: <T>(sessionId: string, fn: () => Promise<T>) => Promise<T>,
): (session: CodexIdleReleaseSession) => Promise<boolean> {
  return async (session: CodexIdleReleaseSession): Promise<boolean> =>
    await withSuppressed(session.id, async () =>
      await resolveMaker().closeSessionIfCurrent(session as Session, 'runtime-refresh',
        { onlyIfIdle: true }) === 'closed',
    );
}

/**
 * 扫描是单飞的：一次扫描串行处理候选，单个候选失败只记 warn 并继续，
 * 好让下轮重试而不阻塞其它会话的回收。
 */
export function createCodexIdleReleaseWatcher(
  deps: CodexIdleReleaseWatcherDeps,
  scanIntervalMs = DEFAULT_CODEX_IDLE_SCAN_INTERVAL_MS,
): CodexIdleReleaseWatcher {
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
            if (deps.isCodexHostBusy(candidate.id)) return;
            if (await deps.hasPendingInput(candidate.id)) return;
            // 用户还没回答的异步问题：回收会让这些问题静默失效，下一轮再回收。
            if ((session.manageAsyncUserQuestions({ action: 'list' }).questions?.length ?? 0) > 0) return;
            // 用户还没回答的异步问题：回收会让这些问题静默失效，下一轮再回收。

            // 候选是扫描开始时的快照：等锁期间用户可能已经发过消息、跑完一轮。
            // 用锁内的最新活动时间复核阈值，避免把刚用过的会话提前回收。
            const idleSinceMs = await deps.readIdleSinceMs(candidate.id);
            if (idleSinceMs === null) return;
            if (deps.now() - idleSinceMs < idleReleaseMinutes * 60_000) return;

            // 宿主侧的「检查 + 关闭预约」：并发发送要么先赢，要么看到关闭被拒。
            const released = await deps.close(session);
            if (!released) return;

            deps.log.info('codexIdleWatcher: released idle session', {
              sessionId: candidate.id,
              idleMs: Math.max(0, deps.now() - idleSinceMs),
              idleThresholdMin: idleReleaseMinutes,
            });
          });
        } catch (err) {
          deps.log.warn('codexIdleWatcher: release session failed', {
            sessionId: candidate.id,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      deps.log.warn('codexIdleWatcher: scan failed', {
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
      deps.log.info('codexIdleWatcher started');
    },
    stop() {
      if (timerHandle === null) return;
      deps.timer.clearInterval(timerHandle);
      timerHandle = null;
      deps.log.info('codexIdleWatcher stopped');
    },
    scanNow,
  };
}
