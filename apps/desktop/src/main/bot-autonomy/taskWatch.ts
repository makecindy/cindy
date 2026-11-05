/**
 * 伙伴自主跟进 · 层 0 状态表（程序级，不经模型）。
 *
 * 只观察明确委派的本机任务；开启总调度后才扩大到本机全部任务：
 * - 本机：灵动岛活动订阅（运行 / 等交互 / 完成 / 出错）+ 输入协调器投影（出错 / 用量上限等待）
 *   + 挂起交互（等你的那句话）+ 数据库兜底（标题、隐藏 / 归档、伙伴专线排除、启动时被打断的任务）。
 * - 远程：查看总调度工作台时才读取已授权电脑的 `maker:list-active` v2，再按需读标题与挂起交互；
 *   `AUTONOMY_THRESHOLDS.remotePollMs` 是读取节流，不注册后台轮询。
 *   失败按设备指数退避（上限 15 分钟），离线电脑的行保留最后状态并标 online=false。
 *   远程行只进工作台（给主人看与允许）：followerBotId 恒为 null，不发事件、不发系统提醒——
 *   那台电脑上的任务由那台电脑上的伙伴跟，避免两台电脑的同名伙伴各跟一遍。
 *
 * 所有 IO 经注入的 deps，便于单测；账号边界由 service 在 deps 里校验。
 */
import type { SessionActivitySnapshot } from '@cindy/maker-shared/session-activity';
import {
  AUTONOMY_THRESHOLDS,
  type BotAutonomyExecution,
  type WatchedPhase,
  type WatchedSession,
  type WatchedSource,
} from '../../shared/botAutonomy.js';
import {
  deriveFollowerBotId,
  resolveSchedulerBotId,
  type FollowerBotDirectory,
  type FollowerBotState,
} from './follower.js';
import type { FinishedRecord } from './glance.js';
import {
  deriveLocalPhase,
  deriveRemotePhase,
  nextPhaseSince,
  parseActiveSessionList,
  summarizeInteraction,
  truncateSummary,
} from './phase.js';

/** 做完的行在表里停留多久（之后只留在「今天做完」计数里）。 */
export const FINISHED_ROW_RETENTION_MS = 15 * 60_000;
/** 伙伴、委派与接手关系的重读间隔。 */
export const OWNERSHIP_REFRESH_MS = 60_000;
/** 设备目录（服务端 HTTP）重读间隔；轮询本身按 remotePollMs。 */
export const DEVICE_DIRECTORY_REFRESH_MS = 5 * 60_000;
/** 远程轮询失败的退避上限。 */
export const REMOTE_BACKOFF_MAX_MS = 15 * 60_000;
/** 离线电脑的行最多保留多久。 */
export const OFFLINE_ROW_RETENTION_MS = 24 * 60 * 60_000;
/** 启动兜底：只看最近这么久内被打断的任务，最多这么多条。 */
export const INTERRUPTED_LOOKBACK_MS = 24 * 60 * 60_000;
export const INTERRUPTED_LIMIT = 50;
/** 本机库里查不到的任务（例如别的电脑经渲染层镜像进灵动岛的）隔多久再查一次。 */
const MISSING_META_RETRY_MS = 60_000;
/** 远程一次读标题的批量。 */
const REMOTE_READ_BATCH = 50;

const USER_SOURCES = new Set(['desktop', 'feishu', 'slack', 'telegram', 'x', 'discord', 'wechat', 'dingtalk', 'wecom', 'shared']);
/**
 * 伙伴的历史 / 私聊话题 / 群 / IM 渠道专线不是「任务」，不进表。主任务（canonical）进表：总调度是另一个伙伴时要能
 * 发现它坏了；但它永远不是主任务所属伙伴自己的事件对象（见 followerFor），也不进它自己的工作台。
 */
const BOT_LANE_ROLES = new Set(['history', 'thread', 'group', 'channel', 'routine']);

export interface LocalSessionMeta {
  id: string;
  title: string;
  workingDir: string | null;
  status: string;
  hiddenAt: number | null;
  source: string;
  orcaRole: string | null;
  /** bot_session_links.role（无链接为 null）。 */
  laneRole: string | null;
  /** bot_session_links.bot_id（无链接为 null）。 */
  laneBotId: string | null;
  /** 上一轮没有正常收尾（startedAt > endedAt）。只在新鲜读库时有意义。 */
  interrupted: boolean;
  activeTurnStartedAt: number | null;
  /** 上一轮收尾时刻（库里的 last_turn_ended_at）；跨重启稳定，用作出错状态的时刻。 */
  lastTurnEndedAt: number | null;
}

export interface OwnershipSnapshot {
  bots: Map<string, FollowerBotState>;
  /** 任务 → 开它（或明确接手它）的伙伴。委派来源优先。 */
  creatorBySession: Map<string, string>;
  /** 伙伴 → 它负责的任务（委派 + 明确接手 - 解除）。 */
  responsibleByBot: Map<string, Set<string>>;
}

/** The directory reference is a dispatch consent token: identical IO refreshes
 * must not revoke a queued follow-up, while any ownership/availability change must. */
function sameOwnership(a: OwnershipSnapshot, b: OwnershipSnapshot): boolean {
  if (a.bots.size !== b.bots.size || a.creatorBySession.size !== b.creatorBySession.size
    || a.responsibleByBot.size !== b.responsibleByBot.size) return false;
  for (const [id, bot] of a.bots) {
    const other = b.bots.get(id);
    if (!other || bot.status !== other.status || bot.allowSchedulerFollow !== other.allowSchedulerFollow
      || !!bot.shadowed !== !!other.shadowed || !!bot.followOff !== !!other.followOff
      || (bot.canonicalSessionId ?? null) !== (other.canonicalSessionId ?? null)) return false;
  }
  for (const [id, creator] of a.creatorBySession) if (b.creatorBySession.get(id) !== creator) return false;
  for (const [id, sessions] of a.responsibleByBot) {
    const other = b.responsibleByBot.get(id);
    if (!other || sessions.size !== other.size || [...sessions].some(session => !other.has(session))) return false;
  }
  return true;
}

export interface RemoteDeviceTarget {
  deviceId: string;
  name: string;
  online: boolean;
  /** 已开启远程控制、本机允许控制、版本支持后台只读请求。 */
  eligible: boolean;
}

export interface TaskWatchLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
}

export interface TaskWatchDeps {
  now(): number;
  log: TaskWatchLogger;
  getActivitySnapshots(): readonly SessionActivitySnapshot[];
  readSessionExecution?(sessionId: string): BotAutonomyExecution | null;
  /** 本机任务是否有前台工具调用在途（tool_use 已发、tool_result 未回）；只是布尔事实。 */
  isToolCallInFlight(sessionId: string): boolean;
  getPendingInteractions(sessionId: string): readonly unknown[];
  readLocalSessions(ids: readonly string[]): Promise<LocalSessionMeta[]>;
  readInterruptedSessions(sinceMs: number, limit: number, sessionIds?: readonly string[]): Promise<LocalSessionMeta[]>;
  readOwnership(): Promise<OwnershipSnapshot>;
  readSchedulerOverride(): { customized: boolean; schedulerBotId: string | null };
  /** null = 当前不能用设备互联（未登录 / 换号中 / 无 device-link）。 */
  listRemoteDevices(): Promise<RemoteDeviceTarget[] | null>;
  invokeRemote(deviceId: string, channel: string, args: unknown[]): Promise<unknown>;
  /** 表有变化（行、相位、标题、跟进者、在线状态）。 */
  onChange(): void;
}

/** 输入协调器投影里跟进需要的字段(其余字段不读)。 */
export interface BotAutonomyInputProjection {
  sessionId: string;
  error?: string | null;
  errorReason?: string | null;
  toolLoop?: unknown;
  usageLimitWait?: unknown;
}

/** 工具循环的投影带 toolLoop 详情；旧被控端可能只给 toolLoop、不给 errorReason。 */
function inputProjectionErrorReason(projection: BotAutonomyInputProjection): string | null {
  if (typeof projection.errorReason === 'string' && projection.errorReason) return projection.errorReason;
  return projection.toolLoop ? 'tool_use_loop_detected' : null;
}

interface LocalFacts {
  activity: SessionActivitySnapshot | null;
  execution?: BotAutonomyExecution;
  delivery?: { execution: BotAutonomyExecution; final: boolean };
  /** Live activity reached completion before ownership/metadata could create a row. */
  observedCompletion: boolean;
  inputError: string | null;
  /** 出错横幅背后的稳定原因(输入协调器投影的 errorReason / 工具循环),没有就是 null。 */
  inputErrorReason: string | null;
  usageLimitWait: boolean;
}

interface RemoteDeviceState {
  name: string;
  online: boolean;
  failures: number;
  nextPollAt: number;
  offlineSince: number | null;
  /** 远程任务上次观察到的活动迹象：消息数或更新时间变化即算有活动。 */
  signals: Map<string, { signature: string; observedAt: number }>;
}

const EMPTY_OWNERSHIP: OwnershipSnapshot = {
  bots: new Map(),
  creatorBySession: new Map(),
  responsibleByBot: new Map(),
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function remoteWatchedSessionId(deviceId: string, sessionId: string): string {
  return `${deviceId}::${sessionId}`;
}

export class TaskWatch {
  private readonly rows = new Map<string, WatchedSession>();
  private readonly local = new Map<string, LocalFacts>();
  private readonly meta = new Map<string, LocalSessionMeta>();
  private readonly missingMeta = new Map<string, number>();
  /** 启动兜底读到的「上次被打断」行：没有新的活动之前保留，复查库里已收尾就移除。 */
  private readonly interrupted = new Set<string>();
  private readonly pending = new Set<string>();
  private flushing: Promise<void> | null = null;
  private ownership: OwnershipSnapshot = EMPTY_OWNERSHIP;
  /** 主任务 id → 所属伙伴（来自伙伴资料 canonical_session_id）。 */
  private canonicalOwners = new Map<string, string>();
  private ownershipAt = 0;
  /** 归属至少成功读到过一次：之前不重算、不通知，免得把启动时已有的事件按「没人跟」结清。 */
  private ownershipLoaded = false;
  private ownershipReadFailures = 0;
  /** 启动兜底（上一轮被打断的任务）是否已读成功；读失败时在之后的扫描里重试。 */
  private interruptedSeeded = false;
  private ownershipRefresh: Promise<void> | null = null;
  private schedulerBotId: string | null = null;
  private readonly finishedLog: FinishedRecord[] = [];
  private readonly remote = new Map<string, RemoteDeviceState>();
  private directory: { at: number; devices: RemoteDeviceTarget[] } | null = null;
  private remotePolling = false;
  private remoteRefresh: Promise<void> | null = null;
  private lastSweepAt = 0;
  private stopped = false;

  constructor(private readonly deps: TaskWatchDeps) {}

  // ─── 读 ────────────────────────────────────────────────────────────────

  list(): WatchedSession[] {
    return [...this.rows.values()].map((row) => ({ ...row }));
  }

  get(sessionId: string): WatchedSession | undefined {
    const row = this.rows.get(sessionId);
    return row ? { ...row } : undefined;
  }

  getSchedulerBotId(): string | null {
    return this.schedulerBotId;
  }

  getBots(): FollowerBotDirectory {
    return this.ownership.bots;
  }

  responsibleFor(botId: string): ReadonlySet<string> {
    return this.ownership.responsibleByBot.get(botId) ?? new Set();
  }

  finished(): readonly FinishedRecord[] {
    return this.finishedLog;
  }

  /** Completed event was settled (or intentionally has no event); keep only the completion counter. */
  retireFinished(sessionId: string, phaseSince: number): void {
    const row = this.rows.get(sessionId);
    if (!row || row.deviceId !== null || row.phase !== 'finished' || row.phaseSince !== phaseSince) return;
    this.rows.delete(sessionId);
    this.meta.delete(sessionId);
    this.interrupted.delete(sessionId);
    const facts = this.local.get(sessionId);
    // New activity may already be queued while the previous completion publish was awaiting IO.
    if (facts && (!facts.activity || facts.activity.phase === 'completed') && !facts.inputError && !facts.usageLimitWait) {
      this.local.delete(sessionId);
    }
  }

  offlineDevices(): string[] {
    return [...this.remote.values()].filter((device) => !device.online).map((device) => device.name);
  }

  getLastSweepAt(): number {
    return this.lastSweepAt;
  }

  // ─── 生命周期 ──────────────────────────────────────────────────────────

  async start(): Promise<void> {
    await this.refreshOwnership();
    for (const snapshot of this.deps.getActivitySnapshots()) {
      this.local.set(snapshot.sessionId, { ...this.factsFor(snapshot.sessionId), ...this.activityFacts(snapshot) });
      if (this.observesLocal(snapshot.sessionId) || !this.ownershipLoaded) this.pending.add(snapshot.sessionId);
    }
    // 归属没读到时不补「上一轮被打断」的任务：空归属会把它判成没人开、先落到总调度；留给读到归属后的扫描。
    if (this.ownershipLoaded) await this.seedInterrupted();
    await this.flush();
  }

  stop(): void {
    this.stopped = true;
  }

  // ─── 本机输入 ──────────────────────────────────────────────────────────

  applyActivity(sessionId: string, current: SessionActivitySnapshot | null): void {
    if (this.stopped) return;
    const previous = this.factsFor(sessionId);
    const observedCompletion = current?.phase === 'completed' && previous.activity !== null
      && previous.activity.turnGeneration === current.turnGeneration
      && (previous.activity.phase !== 'completed' || previous.observedCompletion);
    const facts = { ...previous, ...this.activityFacts(current), observedCompletion };
    if (!current && !facts.inputError && !facts.usageLimitWait) this.local.delete(sessionId);
    else this.local.set(sessionId, facts);
    if (this.observesLocal(sessionId) || !this.ownershipLoaded) this.queue(sessionId);
  }

  /** A report belongs to one live execution, never to the next turn or another task. */
  reportDelivery(sessionId: string, execution: BotAutonomyExecution, final: boolean): boolean {
    if (this.stopped) return false;
    const facts = this.local.get(sessionId);
    const live = this.deps.readSessionExecution?.(sessionId);
    if (!facts?.activity || facts.activity.phase !== 'running'
      || !live || live.instanceId !== execution.instanceId || live.generation !== execution.generation) return false;
    this.local.set(sessionId, { ...facts, delivery: { execution: { ...execution }, final } });
    this.queue(sessionId);
    return true;
  }

  applyInputProjection(projection: BotAutonomyInputProjection): void {
    if (this.stopped || typeof projection?.sessionId !== 'string') return;
    const facts = this.factsFor(projection.sessionId);
    const inputError = typeof projection.error === 'string' && projection.error ? projection.error : null;
    const inputErrorReason = inputError ? inputProjectionErrorReason(projection) : null;
    const usageLimitWait = !!projection.usageLimitWait;
    if (
      facts.inputError === inputError
      && facts.inputErrorReason === inputErrorReason
      && facts.usageLimitWait === usageLimitWait
    ) return;
    // 没有任何活动、也没有出错 / 等待的会话不进表（投影会为每个会话广播）。
    if (!this.local.has(projection.sessionId) && !inputError && !usageLimitWait) return;
    this.local.set(projection.sessionId, { ...facts, inputError, inputErrorReason, usageLimitWait });
    if (this.observesLocal(projection.sessionId) || !this.ownershipLoaded) this.queue(projection.sessionId);
  }

  /** 设置变化（总调度换人）或资料变化后：重读归属并重算全部跟进者。 */
  /** 归属至少成功读到过一次：在这之前状态表与跟进者都不可信，工作台按「还没就绪」处理。 */
  isReady(): boolean {
    return this.ownershipLoaded && !this.stopped;
  }

  async refreshFollowers(): Promise<void> {
    await this.refreshOwnership(true);
    if (this.stopped) return;
    for (const snapshot of this.deps.getActivitySnapshots()) {
      this.local.set(snapshot.sessionId, { ...this.factsFor(snapshot.sessionId), ...this.activityFacts(snapshot) });
    }
    for (const id of this.local.keys()) if (this.observesLocal(id)) this.pending.add(id);
    if (!this.interruptedSeeded && this.ownershipLoaded) await this.seedInterrupted();
    await this.flush();
    this.deps.onChange();
  }

  /** No timer for unassigned owner work or a completed delegation. Events can wake us again. */
  needsSweep(): boolean {
    if (this.stopped) return false;
    if (!this.ownershipLoaded) return this.ownershipReadFailures <= 3 || this.pending.size > 0;
    return this.ownershipReadFailures > 0
      || this.hasScheduler()
      || (!this.interruptedSeeded && this.ownership.creatorBySession.size > 0)
      || [...this.pending].some(id => this.observesLocal(id))
      || [...this.rows.values()].some(row => row.deviceId === null && row.phase !== 'finished');
  }

  private hasScheduler(): boolean {
    // Observation consent survives pausing the selected teammate; followerFor controls execution.
    return this.schedulerBotId !== null;
  }

  private observesLocal(id: string): boolean {
    return this.hasScheduler() || this.ownership.creatorBySession.has(id);
  }

  /** UI reads opt into remote IO explicitly. Concurrent windows share the same bounded read. */
  refreshRemote(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (!this.remoteRefresh) {
      this.remoteRefresh = this.pollRemote(this.deps.now()).finally(() => {
        this.remoteRefresh = null;
        // View reads already returned cached rows. Runtime deduplicates unchanged projections.
        if (!this.stopped) this.deps.onChange();
      });
    }
    return this.remoteRefresh;
  }

  private factsFor(sessionId: string): LocalFacts {
    return this.local.get(sessionId) ?? { activity: null, observedCompletion: false, inputError: null, inputErrorReason: null, usageLimitWait: false };
  }

  private activityFacts(activity: SessionActivitySnapshot | null): Pick<LocalFacts, 'activity' | 'execution'> {
    const live = activity ? this.deps.readSessionExecution?.(activity.sessionId) : null;
    const previous = activity ? this.local.get(activity.sessionId) : undefined;
    // Island snapshots can omit native generation. Capture the live identity
    // synchronously here, before metadata IO or the next queued turn can run.
    const execution = live && (activity?.turnGeneration == null || live.generation === activity.turnGeneration) ? { ...live } :
      activity && previous?.activity?.turnGeneration === activity.turnGeneration
        && previous.activity.startedAtMs === activity.startedAtMs ? previous.execution : undefined;
    return { activity, execution };
  }

  private queue(sessionId: string): void {
    this.pending.add(sessionId);
    this.scheduleFlush();
    this.deps.onChange();
  }

  private scheduleFlush(): void {
    if (this.flushing) return;
    // 同一 tick 的多条变化合成一次读库。
    this.flushing = Promise.resolve().then(() => this.flush()).finally(() => {
      this.flushing = null;
      // Even a filtered/unknown task can consume the last pending read without changing a row.
      if (!this.stopped) this.deps.onChange();
    });
  }

  /** 测试与 service 用：等当前排队的重算落定。 */
  async settled(): Promise<void> {
    while (this.flushing) await this.flushing;
  }

  private async flush(): Promise<void> {
    // 归属还没读到：只累积 pending，首次读到后再一起重算。
    while (this.ownershipLoaded && this.pending.size && !this.stopped) {
      const ids = [...this.pending].filter(id => this.observesLocal(id));
      this.pending.clear();
      const now = this.deps.now();
      const unknown = ids.filter((id) => !this.meta.has(id)
        && (this.missingMeta.get(id) === undefined || now - (this.missingMeta.get(id) ?? 0) >= MISSING_META_RETRY_MS));
      if (unknown.length) {
        try {
          const rows = await this.deps.readLocalSessions(unknown);
          if (this.stopped) return;
          const found = new Set<string>();
          for (const row of rows) {
            found.add(row.id);
            this.meta.set(row.id, row);
            this.missingMeta.delete(row.id);
          }
          for (const id of unknown) if (!found.has(id)) this.missingMeta.set(id, now);
        } catch (error) {
          this.deps.log.warn('session meta read failed', { error: errorCode(error) });
          // 读库失败不能丢掉这批 id：否则之后一直安静的任务（正是卡住的那种）再也进不了表。
          // 放回 pending 并停下，不原地空转；下一条活动或下一次扫描再重试。
          for (const id of ids) this.pending.add(id);
          break;
        }
      }
      let unowned = false;
      let changed = false;
      for (const id of ids) {
        const result = this.recomputeLocal(id, now);
        changed ||= result.changed;
        unowned ||= result.unowned;
      }
      // 新出现的任务可能刚由伙伴委派开出来：归属有点旧就提前重读一次。
      // 新出现、又查不到创建者的任务：发布任何事件前先确认一次最新归属（委派任务与它的委派记录在同一事务里写入，
      // 新读一次一定能认出来）；不拿几秒前的缓存判它「没人开」，否则事件会先落到总调度并被结清。
      if (unowned) await this.refreshOwnership(true);
      if (changed || unowned) this.deps.onChange();
    }
  }

  private isWatchable(meta: LocalSessionMeta | undefined): meta is LocalSessionMeta {
    return !!meta
      && meta.status === 'active'
      && meta.hiddenAt === null
      && meta.orcaRole !== 'worker'
      && meta.source !== 'review'
      && !(meta.laneRole !== null && BOT_LANE_ROLES.has(meta.laneRole));
  }

  private recomputeLocal(sessionId: string, now: number): { changed: boolean; unowned: boolean } {
    const meta = this.meta.get(sessionId);
    const previous = this.rows.get(sessionId) ?? null;
    if (!this.observesLocal(sessionId) || !this.isWatchable(meta)) {
      this.interrupted.delete(sessionId);
      return { changed: this.rows.delete(sessionId), unowned: false };
    }
    const facts = this.factsFor(sessionId);
    const activity = facts.activity;
    const phase: WatchedPhase = deriveLocalPhase({
      activityPhase: activity?.phase ?? null,
      interactionKind: activity?.interactionKind ?? null,
      inputError: !!facts.inputError,
      usageLimitWait: facts.usageLimitWait,
    });
    if (activity) this.interrupted.delete(sessionId);
    // 启动时残留的完成不发事件；归属/元数据读取前已见过同一轮的完成跃迁则保留。
    if (phase === 'finished' && !previous && !facts.observedCompletion) return { changed: false, unowned: false };
    if (phase === 'idle') {
      if (previous && this.interrupted.has(sessionId)) return { changed: false, unowned: false };
      if (previous?.phase === 'finished') return { changed: false, unowned: false };
      // 回到空闲但没观察到完成（主人点了停止 / 中止：灵动岛直接撤掉条目，不留完成卡）：
      // 不是「做完」，静默离表——不发事件、不计入今天做完，免得伙伴把主人刚停下的事又推起来。
      return { changed: this.rows.delete(sessionId), unowned: false };
    }
    let phaseSince: number;
    if (phase === 'running') {
      phaseSince = activity?.startedAtMs ?? (previous?.phase === 'running' ? previous.phaseSince : now);
    } else if (phase === 'finished') {
      phaseSince = nextPhaseSince(previous, phase, activity?.phase === 'completed' ? activity.lastActivityAtMs ?? now : now);
    } else if (phase === 'errored') {
      // 时刻尽量取跨重启稳定的来源（灵动岛终态时刻，否则库里的上一轮收尾时刻），重启后同一次出错是同一个事件 id。
      const terminal = activity?.phase === 'error' || activity?.phase === 'completed';
      const ended = meta.lastTurnEndedAt;
      const endedFresh = ended !== null && ended <= now && (previous?.startedAt == null || ended >= previous.startedAt);
      phaseSince = nextPhaseSince(previous, phase, terminal ? activity?.lastActivityAtMs ?? now : endedFresh ? ended : now);
    } else if (phase === 'waiting-answer' || phase === 'waiting-permission') {
      // 进入等交互时灵动岛会记下活动时刻；等待期间没有新活动，重启后同一条挂起交互仍是同一个时刻。
      phaseSince = nextPhaseSince(previous, phase, activity?.phase === 'needs-interaction' ? activity.lastActivityAtMs ?? now : now);
    } else {
      phaseSince = nextPhaseSince(previous, phase, now);
    }
    let pendingQuestion: string | null = null;
    let pendingRequestId: string | null = null;
    let pendingInteractionId: string | null = null;
    if (phase === 'waiting-answer' || phase === 'waiting-permission') {
      const summary = summarizeInteraction(this.deps.getPendingInteractions(sessionId)[0]);
      const keep = previous?.phase === phase;
      pendingQuestion = summary?.summary ?? (keep ? previous.pendingQuestion : null);
      pendingRequestId = summary?.requestId ?? (keep ? previous.pendingRequestId ?? null : null);
      pendingInteractionId = summary?.interactionId ?? (keep ? previous.pendingInteractionId ?? null : null);
    }
    // 同一相位里从请求 A 换到 B：新请求是新的等待，等待时刻从这次观察算起（与远程一致）。
    if (previous?.phase === phase && previous.pendingInteractionId && pendingInteractionId
      && previous.pendingInteractionId !== pendingInteractionId) phaseSince = now;
    const canonicalOfBotId = this.canonicalOwner(sessionId, meta);
    const creatorBotId = this.creatorOf(sessionId, canonicalOfBotId);
    const row: WatchedSession = {
      sessionId,
      deviceId: null,
      deviceName: null,
      online: true,
      title: meta.title,
      workingDir: meta.workingDir,
      phase,
      phaseSince,
      lastActivityAt: activity?.lastActivityAtMs ?? previous?.lastActivityAt ?? phaseSince,
      startedAt: activity?.startedAtMs ?? previous?.startedAt ?? null,
      ...(facts.execution ? { execution: facts.execution } : {}),
      finalDelivery: facts.delivery?.final === true
        && facts.delivery.execution.instanceId === facts.execution?.instanceId
        && facts.delivery.execution.generation === facts.execution?.generation,
      pendingQuestion,
      pendingRequestId,
      pendingInteractionId,
      toolInFlight: phase === 'running' && this.deps.isToolCallInFlight(sessionId),
      error: phase === 'errored' && facts.inputError ? truncateSummary(facts.inputError) : null,
      errorReason: phase === 'errored' ? facts.inputErrorReason : null,
      creatorBotId,
      canonicalOfBotId,
      followerBotId: null,
      source: localSource(meta, creatorBotId),
      ...(meta.source === 'shared' ? { shared: true } : {}),
    };
    row.followerBotId = this.followerFor(row);
    if (phase === 'finished' && previous?.phase !== 'finished') this.recordFinished(row, now);
    this.rows.set(sessionId, row);
    return { changed: !sameRow(previous, row), unowned: !previous && creatorBotId === null };
  }

  private recordFinished(row: WatchedSession, now: number): void {
    // 伙伴主任务的一轮回复不计入「今天做完」。
    if (row.canonicalOfBotId) return;
    this.finishedLog.push({ sessionId: row.sessionId, creatorBotId: row.creatorBotId, at: now });
    // 只为「今天做完 N 件」留两天的记录。
    const cutoff = now - 2 * 24 * 60 * 60_000;
    while (this.finishedLog.length && this.finishedLog[0]!.at < cutoff) this.finishedLog.shift();
  }

  private async seedInterrupted(): Promise<void> {
    const now = this.deps.now();
    const ownership = this.ownership;
    const schedulerBotId = this.schedulerBotId;
    let rows: LocalSessionMeta[];
    try {
      const ids = this.hasScheduler() ? undefined : [...this.ownership.creatorBySession.keys()];
      rows = ids?.length === 0 ? []
        : await this.deps.readInterruptedSessions(now - INTERRUPTED_LOOKBACK_MS, INTERRUPTED_LIMIT, ids);
    } catch (error) {
      this.deps.log.warn('interrupted session seed failed', { error: errorCode(error) });
      return;
    }
    // A read started for an older scope cannot finish recovery for a newly selected scope.
    if (this.stopped || ownership !== this.ownership || schedulerBotId !== this.schedulerBotId) return;
    this.interruptedSeeded = true;
    for (const meta of rows) {
      if (!this.observesLocal(meta.id)) continue;
      this.meta.set(meta.id, meta);
      if (!this.isWatchable(meta) || !meta.interrupted || this.rows.has(meta.id) || this.local.get(meta.id)?.activity) continue;
      const since = meta.activeTurnStartedAt ?? now;
      const canonicalOfBotId = this.canonicalOwner(meta.id, meta);
      const creatorBotId = this.creatorOf(meta.id, canonicalOfBotId);
      const row: WatchedSession = {
        sessionId: meta.id,
        deviceId: null,
        deviceName: null,
        online: true,
        title: meta.title,
        workingDir: meta.workingDir,
        phase: 'errored',
        phaseSince: since,
        lastActivityAt: since,
        startedAt: since,
        pendingQuestion: null,
        error: null,
        creatorBotId,
        canonicalOfBotId,
        followerBotId: null,
        source: localSource(meta, creatorBotId),
        ...(meta.source === 'shared' ? { shared: true } : {}),
      };
      row.followerBotId = this.followerFor(row);
      this.rows.set(meta.id, row);
      this.interrupted.add(meta.id);
    }
  }

  private followerFor(row: Pick<WatchedSession, 'creatorBotId' | 'deviceId' | 'canonicalOfBotId' | 'shared'>): string | null {
    // 每台电脑上的任务由那台电脑上的伙伴跟：两台电脑上的同名伙伴（如各自的 Cindy 助理）不会各跟一遍。
    // 另一台电脑的行只进工作台给主人看与允许；总调度仍可经工具显式继续它。
    if (row.deviceId !== null) return null;
    // 共享任务里有访客发的话：不能让账号外的内容叫醒以主人权限运行的伙伴，等你时直接提醒主人。
    if (row.shared) return null;
    const follower = deriveFollowerBotId({
      creatorBotId: row.creatorBotId,
      schedulerBotId: this.schedulerBotId,
      bots: this.ownership.bots,
    });
    // 伙伴自己的主任务永远不是它自己的事件对象：自己叫醒自己只会排在正在失败的主任务后面打转。
    // 总调度是另一个伙伴时照常跟（它能发现别的伙伴的主任务坏了）。
    return follower !== null && follower === (row.canonicalOfBotId ?? null) ? null : follower;
  }

  /** 这件任务是哪个伙伴的主任务：资料登记的 canonical_session_id 优先，其次 bot_session_links 的 canonical 链接。 */
  private canonicalOwner(sessionId: string, meta: LocalSessionMeta | undefined): string | null {
    const registered = this.canonicalOwners.get(sessionId);
    if (registered) return registered;
    return meta?.laneRole === 'canonical' ? meta.laneBotId : null;
  }

  /** 主任务所属伙伴不算它的「开的任务」：不让它经 creator 路径跟自己，也不进它自己的工作台。 */
  private creatorOf(sessionId: string, canonicalOfBotId: string | null): string | null {
    const creator = this.ownership.creatorBySession.get(sessionId) ?? null;
    return creator !== null && creator === canonicalOfBotId ? null : creator;
  }

  private async refreshOwnership(force = false): Promise<void> {
    const previousScope = JSON.stringify([this.hasScheduler(), [...this.ownership.creatorBySession.keys()]]);
    if (this.ownershipRefresh) {
      await this.ownershipRefresh;
      if (!force) return;
    }
    const run = (async () => {
      try {
        const next = await this.deps.readOwnership();
        if (this.stopped) return;
        this.ownership = sameOwnership(this.ownership, next) ? { ...next, bots: this.ownership.bots } : next;
        this.ownershipAt = this.deps.now();
        this.ownershipLoaded = true;
        this.ownershipReadFailures = 0;
        this.canonicalOwners = new Map();
        for (const [botId, bot] of next.bots) {
          if (bot.canonicalSessionId) this.canonicalOwners.set(bot.canonicalSessionId, botId);
        }
      } catch (error) {
        this.ownershipReadFailures += 1;
        this.deps.log.warn('ownership read failed', { error: errorCode(error) });
      }
      this.schedulerBotId = resolveSchedulerBotId(this.readOverride(), this.ownership.bots);
      if (previousScope !== JSON.stringify([this.hasScheduler(), [...this.ownership.creatorBySession.keys()]])) {
        this.interruptedSeeded = false;
        // A recovered ownership read can discover delegations whose activity arrived while idle.
        for (const id of this.local.keys()) if (this.observesLocal(id)) this.pending.add(id);
      }
      for (const row of this.rows.values()) {
        if (row.deviceId === null && !this.observesLocal(row.sessionId)) {
          this.rows.delete(row.sessionId);
          this.meta.delete(row.sessionId);
          this.interrupted.delete(row.sessionId);
          continue;
        }
        if (row.deviceId === null) {
          const meta = this.meta.get(row.sessionId);
          row.canonicalOfBotId = this.canonicalOwner(row.sessionId, meta);
          row.creatorBotId = this.creatorOf(row.sessionId, row.canonicalOfBotId);
          if (meta) row.source = localSource(meta, row.creatorBotId);
        }
        row.followerBotId = this.followerFor(row);
      }
    })();
    this.ownershipRefresh = run;
    try {
      await run;
    } finally {
      if (this.ownershipRefresh === run) this.ownershipRefresh = null;
    }
    // 初次加载或变化后恢复归属：把期间累积的变化补算一次。
    if (this.ownershipLoaded && this.pending.size && !this.stopped) this.scheduleFlush();
  }

  private readOverride(): { customized: boolean; schedulerBotId: string | null } {
    try {
      return this.deps.readSchedulerOverride();
    } catch (error) {
      this.deps.log.warn('scheduler setting read failed', { error: errorCode(error) });
      return { customized: false, schedulerBotId: null };
    }
  }

  // ─── 周期扫描 ──────────────────────────────────────────────────────────

  /** 有观察需求时刷新本机归属与标题、清理做完的行。远程读取由工作台显式触发。 */
  async sweep(): Promise<void> {
    if (this.stopped || !this.needsSweep()) return;
    const now = this.deps.now();
    if (this.ownershipReadFailures > 0 || now - this.ownershipAt >= OWNERSHIP_REFRESH_MS) await this.refreshOwnership();
    await this.refreshLocalMeta();
    // 启动兜底读失败（如数据库一时忙）或启动时归属还没读到：按扫描节奏重试，读成功一次后不再读。
    if (!this.interruptedSeeded && this.ownershipLoaded && !this.stopped) await this.seedInterrupted();
    // 上次读元数据失败留下的 pending：按扫描节奏重试一次，不形成重试风暴。
    if (this.pending.size && this.ownershipLoaded && !this.stopped) this.scheduleFlush();
    for (const [id, row] of this.rows) {
      if (row.phase === 'finished' && now - row.phaseSince >= FINISHED_ROW_RETENTION_MS
        && !(row.deviceId === null && this.local.get(id)?.activity)) this.rows.delete(id);
    }
    for (const [id, facts] of this.local) {
      if (!facts.activity && !facts.inputError && !facts.usageLimitWait && !this.rows.has(id)) this.local.delete(id);
    }
    // 查不到元数据的记录：过了重试间隔或已不在活动里就丢掉，避免无界增长（下次出现会重新查）。
    for (const [id, at] of this.missingMeta) {
      if (!this.local.has(id) || now - at >= MISSING_META_RETRY_MS) this.missingMeta.delete(id);
    }
    // 长工具调用期间没有活动事件：每次扫描刷新一次「工具在途」，stuck 判定据此放宽。
    for (const row of this.rows.values()) {
      if (row.deviceId === null) row.toolInFlight = row.phase === 'running' && this.deps.isToolCallInFlight(row.sessionId);
    }
    if (this.meta.size > 2_000) {
      for (const id of this.meta.keys()) if (!this.rows.has(id) && !this.local.has(id)) this.meta.delete(id);
    }
    if (this.stopped) return;
    this.lastSweepAt = now;
    this.deps.onChange();
  }

  private async refreshLocalMeta(): Promise<void> {
    const ids = [...this.rows.values()].filter((row) => row.deviceId === null).map((row) => row.sessionId);
    if (!ids.length) return;
    let fresh: LocalSessionMeta[];
    try {
      fresh = await this.deps.readLocalSessions(ids);
    } catch (error) {
      this.deps.log.warn('session meta refresh failed', { error: errorCode(error) });
      return;
    }
    if (this.stopped) return;
    const found = new Map(fresh.map((meta) => [meta.id, meta]));
    for (const id of ids) {
      const meta = found.get(id);
      const row = this.rows.get(id);
      if (!row) continue;
      if (!meta || !this.isWatchable(meta)) {
        if (meta) this.meta.set(id, meta);
        else this.meta.delete(id);
        this.rows.delete(id);
        this.interrupted.delete(id);
        continue;
      }
      this.meta.set(id, meta);
      if (this.interrupted.has(id) && !meta.interrupted) {
        this.rows.delete(id);
        this.interrupted.delete(id);
        continue;
      }
      row.title = meta.title;
      row.workingDir = meta.workingDir;
    }
  }

  // ─── 远程电脑 ──────────────────────────────────────────────────────────

  private async pollRemote(now: number): Promise<void> {
    if (this.remotePolling) return;
    this.remotePolling = true;
    try {
      if (!this.directory || now - this.directory.at >= DEVICE_DIRECTORY_REFRESH_MS) {
        let devices: RemoteDeviceTarget[] | null = null;
        try {
          devices = await this.deps.listRemoteDevices();
        } catch (error) {
          this.deps.log.debug('device directory read failed', { error: errorCode(error) });
        }
        if (this.stopped) return;
        if (devices === null && !this.directory) return;
        this.directory = { at: now, devices: devices ?? this.directory?.devices ?? [] };
        const known = new Set(this.directory.devices.map((device) => device.deviceId));
        for (const deviceId of this.remote.keys()) if (!known.has(deviceId)) this.forgetDevice(deviceId);
      }
      const targets = this.directory.devices.filter((device) => device.eligible);
      for (const device of this.directory.devices) {
        if (!device.eligible && this.remote.has(device.deviceId)) this.forgetDevice(device.deviceId);
      }
      for (const device of targets) {
        if (this.stopped) return;
        const state = this.remote.get(device.deviceId) ?? {
          name: device.name,
          online: device.online,
          failures: 0,
          nextPollAt: 0,
          offlineSince: null,
          signals: new Map(),
        };
        state.name = device.name;
        this.remote.set(device.deviceId, state);
        if (!device.online) {
          this.markDeviceOffline(device.deviceId, state, now);
          continue;
        }
        if (state.nextPollAt > now) continue;
        try {
          await this.pollDevice(device.deviceId, state, now);
          state.failures = 0;
          state.online = true;
          state.offlineSince = null;
          state.nextPollAt = now + AUTONOMY_THRESHOLDS.remotePollMs;
        } catch (error) {
          state.failures += 1;
          state.nextPollAt = now + Math.min(
            AUTONOMY_THRESHOLDS.remotePollMs * 2 ** state.failures,
            REMOTE_BACKOFF_MAX_MS,
          );
          this.markDeviceOffline(device.deviceId, state, now);
          this.deps.log.debug('remote task poll failed', {
            deviceId: device.deviceId.slice(0, 8),
            failures: state.failures,
            error: errorCode(error),
          });
        }
      }
    } finally {
      this.remotePolling = false;
    }
  }

  private markDeviceOffline(deviceId: string, state: RemoteDeviceState, now: number): void {
    if (state.online || state.offlineSince === null) state.offlineSince = state.offlineSince ?? now;
    state.online = false;
    for (const [id, row] of this.rows) {
      if (row.deviceId !== deviceId) continue;
      if (now - (state.offlineSince ?? now) >= OFFLINE_ROW_RETENTION_MS) this.rows.delete(id);
      else row.online = false;
    }
  }

  private forgetDevice(deviceId: string): void {
    this.remote.delete(deviceId);
    for (const [id, row] of this.rows) if (row.deviceId === deviceId) this.rows.delete(id);
  }

  private async pollDevice(deviceId: string, state: RemoteDeviceState, now: number): Promise<void> {
    const response = await this.deps.invokeRemote(deviceId, 'maker:list-active', [
      { summary: true, snapshotVersion: 2 },
    ]);
    // 两种返回都收；都不是就按读取失败处理（退避、标离线），不能当成「没有任务」把那台电脑的行全清掉。
    const sessions = parseActiveSessionList(response);
    if (!sessions) throw Object.assign(new Error('Unexpected active session list'), { code: 'REMOTE_SHAPE' });
    const active = new Map<string, { isTurnRunning?: unknown; activityPhase?: unknown }>();
    for (const raw of sessions) {
      const row = record(raw);
      if (!row || typeof row.sessionId !== 'string' || !row.sessionId || row.sessionId.length > 256) continue;
      const phase = deriveRemotePhase(row);
      if (phase === 'idle') continue;
      active.set(row.sessionId, row);
    }
    // 标题、更新时间与消息数：只为非空闲的任务读，按批。
    const metas = new Map<string, Record<string, unknown>>();
    const ids = [...active.keys()];
    for (let offset = 0; offset < ids.length; offset += REMOTE_READ_BATCH) {
      const batch = await this.deps.invokeRemote(deviceId, 'local-db:sessions:get-many', [ids.slice(offset, offset + REMOTE_READ_BATCH)]);
      for (const raw of Array.isArray(batch) ? batch : []) {
        const meta = record(raw);
        if (meta && typeof meta.id === 'string') metas.set(meta.id, meta);
      }
    }
    if (this.stopped) return;
    const seen = new Set<string>();
    for (const [remoteId, activity] of active) {
      const meta = metas.get(remoteId);
      // 被控端隐藏的任务读不到；伙伴的专线与后台任务由那台电脑自己的伙伴跟，不跨电脑重复跟。
      if (!meta || meta.source === 'bot' || meta.orcaRole === 'worker' || meta.source === 'review'
        || (meta.status !== undefined && meta.status !== 'active') || (meta.hiddenAt !== undefined && meta.hiddenAt !== null)) continue;
      const id = remoteWatchedSessionId(deviceId, remoteId);
      seen.add(id);
      const previous = this.rows.get(id) ?? null;
      let interactionKind: string | null = null;
      let pendingQuestion: string | null = null;
      let pendingRequestId: string | null = null;
      let pendingInteractionId: string | null = null;
      if (activity.activityPhase === 'needs-interaction') {
        // 每次轮询都重读挂起交互（每个等待中的远程任务每分钟一次）：两次轮询之间可能从请求 A 直接换到 B。
        let summary: ReturnType<typeof summarizeInteraction> = null;
        try {
          const pending = await this.deps.invokeRemote(deviceId, 'maker:get-pending-interactions', [remoteId]);
          const first = Array.isArray(pending) ? record(pending[0])?.request ?? pending[0] : undefined;
          summary = summarizeInteraction(first);
        } catch {
          // 读不到：沿用上次读到的；从没读到过时仍按「等回答」显示。
        }
        if (summary) {
          interactionKind = summary.waitingFor === 'permission' ? 'permission' : 'ask_user_question';
          pendingQuestion = summary.summary;
          pendingRequestId = summary.requestId;
          pendingInteractionId = summary.interactionId;
        } else if (previous && (previous.phase === 'waiting-answer' || previous.phase === 'waiting-permission')) {
          interactionKind = previous.phase === 'waiting-permission' ? 'permission' : 'ask_user_question';
          pendingQuestion = previous.pendingQuestion;
          pendingRequestId = previous.pendingRequestId ?? null;
          pendingInteractionId = previous.pendingInteractionId ?? null;
        }
      }
      const phase = deriveRemotePhase({ ...activity, interactionKind });
      // 第一次看到就已经做完的任务没有可观察的「做完」跃迁：不进表、不发事件、不计数。
      if (phase === 'finished' && !previous) continue;
      const signature = `${String(meta.messageCount ?? '')}|${String(meta.updatedAt ?? '')}`;
      const signal = state.signals.get(remoteId);
      const activityAt = !signal || signal.signature !== signature ? now : signal.observedAt;
      state.signals.set(remoteId, { signature, observedAt: activityAt });
      const updatedAt = finiteNumber(meta.updatedAt);
      // 出错的时刻尽量用被控端的更新时间，重启后同一次出错仍是同一个事件 id。
      const candidateSince = phase === 'errored' && updatedAt !== null && updatedAt <= now ? updatedAt : now;
      let phaseSince = phase === 'running' && previous?.phase === 'running'
        ? previous.phaseSince
        : nextPhaseSince(previous, phase, candidateSince);
      // 同一任务从请求 A 换到请求 B 是新的等待：重新计时（也就是新的事件 id）。
      if (previous?.phase === phase && previous.pendingInteractionId && pendingInteractionId
        && previous.pendingInteractionId !== pendingInteractionId) {
        phaseSince = now;
      }
      const row: WatchedSession = {
        sessionId: id,
        deviceId,
        deviceName: state.name,
        online: true,
        title: typeof meta.title === 'string' && meta.title ? meta.title : (previous?.title ?? ''),
        workingDir: typeof meta.workingDir === 'string' ? meta.workingDir : null,
        phase,
        phaseSince,
        lastActivityAt: Math.max(activityAt, updatedAt !== null && updatedAt <= now ? updatedAt : 0),
        startedAt: previous?.startedAt ?? (phase === 'running' ? now : null),
        pendingQuestion,
        pendingRequestId,
        pendingInteractionId,
        error: null,
        creatorBotId: null,
        followerBotId: null,
        source: meta.source === 'scheduler' ? 'routine' : USER_SOURCES.has(String(meta.source ?? 'desktop')) ? 'user' : 'other',
        ...(meta.source === 'shared' ? { shared: true } : {}),
      };
      row.followerBotId = this.followerFor(row);
      if (phase === 'finished' && previous?.phase !== 'finished') this.recordFinished(row, now);
      this.rows.set(id, row);
    }
    // 离开活动列表：只有观察到完成（列表里出现过 completed）的行留到保留期满；其它（含被停止）静默离表，
    // 不算「做完」。
    for (const [id, row] of this.rows) {
      if (row.deviceId !== deviceId || seen.has(id)) continue;
      row.online = true;
      if (row.phase !== 'finished') this.rows.delete(id);
    }
    for (const remoteId of state.signals.keys()) {
      if (!active.has(remoteId)) state.signals.delete(remoteId);
    }
  }
}

function localSource(meta: LocalSessionMeta, creatorBotId: string | null): WatchedSource {
  if (creatorBotId) return 'bot-task';
  if (meta.source === 'scheduler') return 'routine';
  return USER_SOURCES.has(meta.source) ? 'user' : 'other';
}

function sameRow(a: WatchedSession | null, b: WatchedSession): boolean {
  return !!a
    && a.finalDelivery === b.finalDelivery
    && a.phase === b.phase
    && a.phaseSince === b.phaseSince
    && a.title === b.title
    && a.pendingQuestion === b.pendingQuestion
    && (a.pendingRequestId ?? null) === (b.pendingRequestId ?? null)
    && (a.pendingInteractionId ?? null) === (b.pendingInteractionId ?? null)
    && a.error === b.error
    && (a.errorReason ?? null) === (b.errorReason ?? null)
    && a.followerBotId === b.followerBotId
    && a.online === b.online;
}

/** 日志只记错误类别，不带可能含任务内容的原文。 */
export function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof (error as { code: unknown }).code === 'string') {
    return (error as { code: string }).code;
  }
  return error instanceof Error ? error.name : typeof error;
}
