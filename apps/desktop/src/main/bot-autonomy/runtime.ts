/**
 * 伙伴自主跟进 · 一个账号范围内的运行体（不依赖 Electron，便于单测）。
 *
 * 随例行任务引擎创建而创建、随引擎停止而停止：
 * - 每次创建都向引擎重新登记宿主内置事件源 `host:sessions`（引擎的事件源表只在内存里）。
 * - 为每个在用（active、本机为主力电脑）的伙伴 ensure 一条内置「跟进」例行任务（幂等）；主人关掉它的
 *   系统技能「跟进」时只 ensure 夜间学习，不装跟进，也不叫醒它（谁跟见 follower.ts）。
 * - 状态表变化或周期扫描后判定阈值事件：有人跟 → 发布给引擎，由 followerBotId 过滤叫醒对应伙伴；
 *   没人跟（没有总调度、伙伴暂停、跟进规则被主人暂停）→ 本机任务的「等你」改为系统提醒主人。
 * - 条件兜底：某伙伴还有待处理的任务（等你 / 出错 / 用量上限 / 卡住），且距它上次被叫醒已满
 *   `fallbackIntervalMs`，发一条 `sweep` 事件叫醒它；没有待处理任务的伙伴不会被白叫醒。
 * - 状态表变化节流 ≤ 1 次/秒向界面推 `maker:bot-autonomy:changed`。
 *
 * 日志只记类别、计数与错误码，不记任务标题、问题或错误原文。
 */
import type { RoutineEngine } from '@cindy/maker-scheduler';
import {
  AUTONOMY_THRESHOLDS,
  HOST_SESSIONS_SOURCE_ID,
  type BotGlance,
  type WatchedSession,
} from '../../shared/botAutonomy.js';
import { FOLLOW_UP_BUILTIN_VERSION, buildFollowUpRoutineInput, builtinFollowUpRoutineId } from './builtinRoutine.js';
import {
  AutonomyEventLedger,
  hostSessionsSource,
  isPendingForFallback,
  sweepEventId,
  toRoutineEvent,
  toSweepEvent,
  type AutonomyEventCandidate,
} from './events.js';
import { isBotHomeHere, isFollowerAvailable } from './follower.js';
import { projectBotGlance } from './glance.js';
import { errorCode, type TaskWatch, type TaskWatchLogger } from './taskWatch.js';

/** 按需检查本机状态，或重试尚未成功发布的事件；不轮询远程电脑。 */
export const SWEEP_INTERVAL_MS = 30_000;
/** 界面推送节流。 */
export const PUSH_THROTTLE_MS = 1_000;

const ROUTINE_ID_PATTERN = /^[a-zA-Z0-9_-]{16,128}$/;

export type AutonomyEngine = Pick<RoutineEngine, 'registerSource' | 'publish' | 'ensureBuiltin'>;

export interface AutonomyRuntimeDeps {
  engine: AutonomyEngine;
  /** 由运行体传入 onChange 回调，调用方装好其余 IO。 */
  createWatch(onChange: () => void): TaskWatch;
  now(): number;
  log: TaskWatchLogger;
  /** 账号边界：换号 / 引擎重建后为 false，所有后续动作作废。 */
  isCurrent(): boolean;
  /** 没人跟的本机任务在等主人：系统提醒（桌面 + 手机），同一事件 id 只提醒一次。 */
  remind(row: WatchedSession, eventId: string): void;
  /** 推送界面刷新；payload 缺省 botIds 表示所有伙伴都该重读。 */
  push(payload: { botIds?: string[] }): void;
  /** 订阅灵动岛活动；返回 null 表示服务还没就绪（下次扫描再试）。 */
  subscribeActivity(watch: TaskWatch): (() => void) | null;
  /** 与跟进同时落地的其它默认内置规则（夜间学习）；同样只对在用、主力电脑上的伙伴调用。 */
  ensureOwnBuiltins?(botId: string): Promise<void>;
}

/** 「一眼」的调用方附加限制（远程端排除不可见伙伴）。 */
export interface GlanceOptions {
  excludeBotIds?: ReadonlySet<string>;
}

export class BotAutonomyRuntime {
  readonly watch: TaskWatch;
  private readonly ledger = new AutonomyEventLedger();
  private readonly inflight = new Set<string>();
  private readonly deferredEvents = new Set<string>();
  private readonly reminded = new Map<string, number>();
  /** 已对齐内置规则的伙伴 → 当时是否包含跟进（关掉「跟进」时只对齐夜间学习；开关变化后重新对齐）。 */
  private readonly ensured = new Map<string, boolean>();
  /** 正在对齐的内置规则：并发的 ensure 与发布共用同一次写入。 */
  private readonly ensuring = new Map<string, Promise<boolean>>();
  /** 伙伴上次被叫醒（任一事件被它的规则接收）的时刻；启动时视为刚叫醒过，避免重启后一起白跑。 */
  private readonly lastWokenAt = new Map<string, number>();
  private readonly sweptIds = new Set<string>();
  private startedAt = 0;
  private unsubscribe: (() => void) | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private evaluateTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPushAt = 0;
  private lastSignature = '';
  private sweeping = false;
  /** 状态表首次观察完成（归属已读）之前不判定事件。 */
  private started = false;
  private timersEnabled = false;
  private stopped = false;

  constructor(private readonly deps: AutonomyRuntimeDeps) {
    this.watch = deps.createWatch(() => this.onWatchChange());
  }

  /** 登记事件源并启动观察；`timers=false` 时不起周期定时器（单测逐步驱动）。 */
  async start(options: { timers?: boolean } = {}): Promise<void> {
    this.startedAt = this.deps.now();
    this.registerSource();
    this.unsubscribe = this.deps.subscribeActivity(this.watch);
    await this.watch.start();
    if (this.stopped) return;
    this.started = true;
    await this.ensureBuiltins();
    await this.evaluate();
    this.schedulePush();
    // start 期间可能已被停止（换账号 / 引擎重建）：不再起定时器，免得泄漏。
    if (this.stopped) return;
    this.timersEnabled = options.timers !== false;
    this.syncSweepTimer();
  }

  private syncSweepTimer(): void {
    const needed = this.started && !this.stopped && this.timersEnabled && this.needsSweep();
    if (!needed && this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    } else if (needed && !this.sweepTimer) {
      this.sweepTimer = setInterval(() => { void this.sweep(); }, SWEEP_INTERVAL_MS);
      this.sweepTimer.unref?.();
    }
  }

  private needsSweep(): boolean {
    return this.watch.needsSweep() || this.deferredEvents.size > 0;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.watch.stop();
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.pushTimer) clearTimeout(this.pushTimer);
    if (this.evaluateTimer) clearTimeout(this.evaluateTimer);
    this.sweepTimer = this.pushTimer = this.evaluateTimer = null;
  }

  isStopped(): boolean {
    return this.stopped;
  }

  /** 一次程序级扫描；定时器与单测共用。 */
  async sweep(): Promise<void> {
    if (this.stopped || this.sweeping || !this.deps.isCurrent()) return;
    if (!this.needsSweep()) {
      this.syncSweepTimer();
      return;
    }
    this.sweeping = true;
    try {
      if (!this.unsubscribe) this.unsubscribe = this.deps.subscribeActivity(this.watch);
      await this.watch.sweep();
      await this.ensureBuiltins();
      await this.evaluate();
      await this.evaluateFallback();
    } catch (error) {
      this.deps.log.warn('autonomy sweep failed', { error: errorCode(error) });
    } finally {
      this.sweeping = false;
      this.syncSweepTimer();
    }
  }

  glance(botId: string, options?: GlanceOptions): BotGlance {
    return projectBotGlance({
      botId,
      schedulerBotId: this.watch.getSchedulerBotId(),
      rows: this.watch.list(),
      responsibleSessionIds: this.watch.responsibleFor(botId),
      finished: this.watch.finished(),
      offlineDevices: this.watch.offlineDevices(),
      lastSweepAt: this.watch.getLastSweepAt(),
      now: this.deps.now(),
      ...(options?.excludeBotIds ? { excludeBotIds: options.excludeBotIds } : {}),
    });
  }

  /** 伙伴恢复 / 新建后：补建内置规则（幂等）。 */
  async ensureBot(botId: string): Promise<void> {
    this.ensured.delete(botId);
    await this.ensureOne(botId, !this.watch.getBots().get(botId)?.followOff);
  }

  /** 设置（总调度）变化：重读归属、重算跟进者，并立即判定一次。 */
  async refreshFollowers(): Promise<void> {
    await this.watch.refreshFollowers();
    await this.ensureBuiltins();
    await this.evaluate();
    this.schedulePush(true);
  }

  // ─── 内部 ──────────────────────────────────────────────────────────────

  private registerSource(): void {
    try {
      this.deps.engine.registerSource(hostSessionsSource());
    } catch (error) {
      this.deps.log.warn('host source register failed', { error: errorCode(error) });
    }
  }

  private onWatchChange(): void {
    if (this.stopped) return;
    this.syncSweepTimer();
    this.schedulePush();
    // 出错 / 用量上限 / 做完是即时事件：同一 tick 的变化合并后判定一次。
    if (this.evaluateTimer) return;
    this.evaluateTimer = setTimeout(() => {
      this.evaluateTimer = null;
      void this.evaluate();
    }, 0);
    this.evaluateTimer.unref?.();
  }

  private async ensureBuiltins(): Promise<void> {
    for (const [botId, bot] of this.watch.getBots()) {
      if (!isBotHomeHere(bot)) {
        // 暂停 / 归档 / 不是主力电脑：恢复后重新对齐一次。
        this.ensured.delete(botId);
        continue;
      }
      const follow = isFollowerAvailable(bot);
      if (this.ensured.get(botId) !== follow) await this.ensureOne(botId, follow);
    }
  }

  /**
   * 返回内置规则是否已落地；失败时不记为已对齐，下次扫描或发布前重试。
   * `follow=false`（主人关掉了「跟进」）只对齐夜间学习：已有的跟进规则留着，收不到事件，运行也会被跳过。
   */
  private ensureOne(botId: string, follow = true): Promise<boolean> {
    if (this.stopped || !this.deps.isCurrent()) return Promise.resolve(false);
    // 含跟进与只含夜间学习是两次不同的对齐，不共用在途结果。
    const key = follow ? botId : `${botId}:own`;
    const inflight = this.ensuring.get(key);
    if (inflight) return inflight;
    const id = builtinFollowUpRoutineId(botId);
    if (!ROUTINE_ID_PATTERN.test(id)) {
      // 兜底：builtinFollowUpRoutineId 对任何伙伴 id 都给出合法 id，正常不会走到这里。
      this.ensured.set(botId, follow);
      this.deps.log.warn('builtin routine skipped: unsupported teammate id');
      return Promise.resolve(false);
    }
    const run = (async (): Promise<boolean> => {
      try {
        if (follow) {
          await this.deps.engine.ensureBuiltin(
            botId,
            'follow-up',
            buildFollowUpRoutineInput(botId),
            id,
            FOLLOW_UP_BUILTIN_VERSION,
          );
          if (this.stopped) return false;
        }
        // 夜间学习落地失败只记日志：不能因此让跟进被判为未就绪、挡住事件发布。
        await this.deps.ensureOwnBuiltins?.(botId).catch((error) =>
          this.deps.log.warn('default builtin routine ensure failed', { error: errorCode(error) }));
        if (this.stopped) return false;
        this.ensured.set(botId, follow);
        return true;
      } catch (error) {
        this.deps.log.warn('builtin routine ensure failed', { error: errorCode(error) });
        return false;
      } finally {
        this.ensuring.delete(key);
      }
    })();
    this.ensuring.set(key, run);
    return run;
  }

  /**
   * 发布前先确保跟进者的内置规则已落地：首次安装或新伙伴时，事件若赶在 ensure 之前发布，
   * 引擎会记下回执却没有规则接收（accepted=0），这次事件就永久丢了。
   */
  private async ensureFollower(botId: string): Promise<boolean> {
    return this.ensured.get(botId) === true || await this.ensureOne(botId);
  }

  /** 判定并发布阈值事件。可重入：同一事件 id 在途时不重复处理。 */
  async evaluate(): Promise<void> {
    if (!this.started || this.stopped || !this.deps.isCurrent()) return;
    const now = this.deps.now();
    const rows = this.watch.list();
    const { due, capped } = this.ledger.evaluate(rows, now);
    const dueIds = new Set(due.map(candidate => candidate.id));
    // Removed/out-of-scope tasks must not retain a retry timer or replay stale events.
    for (const id of this.deferredEvents) if (!dueIds.has(id)) this.deferredEvents.delete(id);
    for (const candidate of capped) {
      this.deps.log.info('autonomy event capped', { type: candidate.type, occurrence: candidate.occurrence });
    }
    for (const candidate of due) {
      if (this.inflight.has(candidate.id)) continue;
      this.inflight.add(candidate.id);
      try {
        await this.dispatch(candidate, now);
      } finally {
        this.inflight.delete(candidate.id);
        if (this.ledger.isSettled(candidate.id)) this.deferredEvents.delete(candidate.id);
        else this.deferredEvents.add(candidate.id);
      }
      if (this.stopped) return;
    }
    const unsettled = new Set(due.filter(candidate => !this.ledger.isSettled(candidate.id)).map(candidate => candidate.row.sessionId));
    for (const row of rows) {
      if (row.phase === 'finished' && !unsettled.has(row.sessionId)) this.watch.retireFinished(row.sessionId, row.phaseSince);
    }
    this.pruneReminded(now);
    this.syncSweepTimer();
  }

  private async dispatch(candidate: AutonomyEventCandidate, now: number): Promise<void> {
    if (!candidate.row.followerBotId) {
      this.ledger.settle(candidate, now);
      this.remindOwner(candidate, now);
      return;
    }
    const ready = await this.ensureFollower(candidate.row.followerBotId);
    if (this.stopped) return;
    if (!ready) {
      // 规则没落地就发布会 accepted=0 并留下回执，之后同一事件再也发不出去：不发、不结清，下次扫描重试。
      this.deps.log.warn('autonomy event deferred: builtin routine not ready', { type: candidate.type });
      return;
    }
    let accepted: number;
    try {
      const result = await this.deps.engine.publish(
        HOST_SESSIONS_SOURCE_ID,
        toRoutineEvent(candidate, now),
        () => !this.stopped && this.deps.isCurrent(),
      );
      if (this.stopped) return;
      if (result.duplicate) {
        // 重启前已经发过：引擎回执兜底，不再计次也不提醒。
        this.ledger.settle(candidate, now, false);
        return;
      }
      accepted = result.accepted;
    } catch (error) {
      if (this.stopped) return;
      const code = errorCode(error);
      // 事件源丢了（引擎被重建但还没通知到）：重登记，下次判定再发。限流等错误同样留到下次。
      if (error instanceof Error && /not listening/u.test(error.message)) this.registerSource();
      this.deps.log.warn('autonomy event publish failed', { type: candidate.type, error: code });
      return;
    }
    this.ledger.settle(candidate, now);
    if (accepted > 0 && candidate.row.followerBotId) this.lastWokenAt.set(candidate.row.followerBotId, now);
    this.deps.log.info('autonomy event published', { type: candidate.type, accepted, occurrence: candidate.occurrence });
    // 跟进者的内置规则被主人暂停：没有任何规则接收 → 与「没人跟」同样处理。
    if (accepted === 0) this.remindOwner(candidate, now);
  }

  /**
   * 条件兜底（程序级）：只对还有待处理任务、且距上次被叫醒已满兜底间隔的伙伴发 `sweep`。
   * 同一伙伴同一时间桶只发一次；发布失败留到下次扫描再试。
   */
  async evaluateFallback(): Promise<void> {
    if (this.stopped || !this.deps.isCurrent()) return;
    const now = this.deps.now();
    const pending = new Set<string>();
    for (const row of this.watch.list()) {
      if (row.followerBotId && isPendingForFallback(row, now)) pending.add(row.followerBotId);
    }
    for (const botId of pending) {
      const last = this.lastWokenAt.get(botId) ?? this.startedAt;
      if (now - last < AUTONOMY_THRESHOLDS.fallbackIntervalMs) continue;
      const id = sweepEventId(botId, now);
      if (this.sweptIds.has(id)) continue;
      const ready = await this.ensureFollower(botId);
      if (this.stopped) return;
      if (!ready) {
        this.deps.log.warn('autonomy sweep deferred: builtin routine not ready');
        continue;
      }
      try {
        const result = await this.deps.engine.publish(
          HOST_SESSIONS_SOURCE_ID,
          toSweepEvent(botId, now),
          () => !this.stopped && this.deps.isCurrent(),
        );
        if (this.stopped) return;
        this.sweptIds.add(id);
        if (result.accepted > 0) this.lastWokenAt.set(botId, now);
        this.deps.log.info('autonomy sweep published', { accepted: result.accepted, duplicate: result.duplicate });
      } catch (error) {
        if (this.stopped) return;
        if (error instanceof Error && /not listening/u.test(error.message)) this.registerSource();
        this.deps.log.warn('autonomy sweep publish failed', { error: errorCode(error) });
      }
    }
    if (this.sweptIds.size > 1_000) this.sweptIds.clear();
  }

  private remindOwner(candidate: AutonomyEventCandidate, now: number): void {
    // 只有「等你」需要另外提醒；出错 / 做完已有任务通知，卡住与用量上限在工作台可见。
    if (candidate.type !== 'waiting' || candidate.row.deviceId !== null) return;
    if (this.reminded.has(candidate.id)) return;
    this.reminded.set(candidate.id, now);
    try {
      this.deps.remind(candidate.row, candidate.id);
    } catch (error) {
      this.deps.log.warn('autonomy reminder failed', { error: errorCode(error) });
    }
  }

  private pruneReminded(now: number): void {
    for (const [id, at] of this.reminded) if (now - at >= 24 * 60 * 60_000) this.reminded.delete(id);
  }

  private schedulePush(force = false): void {
    if (this.stopped) return;
    if (force) this.lastSignature = '';
    if (this.pushTimer) return;
    const wait = Math.max(0, this.lastPushAt + PUSH_THROTTLE_MS - this.deps.now());
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      this.flushPush();
    }, wait);
    this.pushTimer.unref?.();
  }

  /**
   * 只在「一眼」可见的内容变了时推送；分钟数由界面自己按时间刷新。
   * 页脚「上次看过 N 分钟前」读 lastSweepAt：按分钟粒度计入签名，扫描后没别的变化也会刷新。
   */
  flushPush(): void {
    if (this.stopped || !this.deps.isCurrent()) return;
    const signature = JSON.stringify([
      this.watch.getSchedulerBotId(),
      Math.floor(this.watch.getLastSweepAt() / 60_000),
      this.watch.offlineDevices(),
      this.watch.finished().length,
      this.watch.list().map((row) => [
        row.sessionId, row.phase, row.phaseSince, row.title, row.pendingQuestion, row.pendingRequestId ?? null,
        row.error, row.creatorBotId, row.followerBotId, row.online, row.startedAt,
      ]),
    ]);
    if (signature === this.lastSignature) return;
    this.lastSignature = signature;
    this.lastPushAt = this.deps.now();
    this.deps.push({});
  }
}
