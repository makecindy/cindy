import { EventEmitter } from 'node:events';
import type {
  Schedule,
  ScheduleRun,
  CreateScheduleInput,
  UpdateScheduleInput,
  ListFilter,
  SchedulerEvent,
  SchedulerInflightRun,
  SchedulerRuntimeSnapshot,
  SchedulerWaitingSchedule,
  ScheduleRunPhase,
  ScriptCapability,
  ScriptExecutionConfig,
  PreRunHookRunResult,
} from '../types.js';
import { SCRIPT_CAPABILITIES } from '../types.js';
import type { ScheduleStorage } from '../interfaces/schedule-storage.js';
import type { ChildRunInput, ScheduleRunner } from '../interfaces/schedule-runner.js';
import type { Clock } from '../interfaces/clock.js';
import type { Logger } from '../interfaces/logger.js';
import { nextCronOrMonthlyFire } from './monthlyClamp.js';

/**
 * Interval-mode 下次触发时间。`baseMs` 是上次完成（或 createdAt）。
 *   - baseMs + intervalMs 在未来 → 用它（尊重原 schedule，重启不重置）
 *   - baseMs + intervalMs 已过去 → 用 now + intervalMs（不补发漏掉的，重新起 N 倒计时）
 */
function nextIntervalFire(baseMs: number, intervalMs: number, now: number): number {
  const planned = baseMs + intervalMs;
  return planned > now ? planned : now + intervalMs;
}

const SCRIPT_CAPABILITY_SET: ReadonlySet<ScriptCapability> = new Set(SCRIPT_CAPABILITIES);

function normalizeScriptConfig(
  config: ScriptExecutionConfig | null | undefined,
): ScriptExecutionConfig | undefined {
  if (!config) return undefined;
  const command = config.command.trim();
  const capabilities = Array.from(
    new Set(
      config.capabilities.filter((capability): capability is ScriptCapability =>
        SCRIPT_CAPABILITY_SET.has(capability),
      ),
    ),
  );
  const timeoutMs =
    typeof config.timeoutMs === 'number' && Number.isFinite(config.timeoutMs) && config.timeoutMs > 0
      ? Math.floor(config.timeoutMs)
      : undefined;
  return { command, capabilities, ...(timeoutMs ? { timeoutMs } : {}) };
}

function validateScheduleExecutionShape(
  schedule: Pick<Schedule, 'executionMode' | 'scriptConfig' | 'workspaceKind' | 'workingDir' | 'useWorktree' | 'targetSessionId' | 'persistentSession' | 'prompt' | 'silentWhenIdle'>,
  opts: { checkAgentPrompt: boolean } = { checkAgentPrompt: true },
): void {
  if ((schedule.executionMode ?? 'agent') !== 'script') {
    // 堵 update 逃逸:script 任务(prompt 合法为空)经 patch 只切 executionMode='agent'
    // 时,若不校验会落库空提示词的 agent 任务,触发即烧一轮空输入。checkAgentPrompt
    // 仅在 create 与"patch 显式动了 executionMode/prompt"时为 true——存量任务改
    // 无关字段(改名/暂停等)不受影响。
    if (opts.checkAgentPrompt && !schedule.prompt?.trim()) {
      throw new Error('invalid schedule: prompt is required for agent execution mode');
    }
    return;
  }
  if (!schedule.scriptConfig?.command.trim()) {
    throw new Error('script execution requires a non-empty command');
  }
  if (schedule.workspaceKind !== 'project' || !schedule.workingDir?.trim()) {
    throw new Error('script execution requires a local project workspace');
  }
  if (schedule.useWorktree || schedule.targetSessionId || schedule.persistentSession) {
    throw new Error('script execution does not support worktrees or bound sessions');
  }
  // silentWhenIdle 的静默协议依赖 agent 在会话里调 silence 工具,script 任务无
  // agent、该语义整体不适用;显式传入按不支持字段拒绝(UI 提交层恒为 false)。
  if (schedule.silentWhenIdle) {
    throw new Error('script execution does not support silentWhenIdle');
  }
}

export interface SchedulerOptions {
  storage: ScheduleStorage;
  runner: ScheduleRunner;
  clock?: Clock;
  logger?: Logger;
  tickIntervalMs?: number;
  generateId?: () => string;
  /**
   * 判定一个 workingDir 是否是宿主 app 管理的对话工作区目录(实现细节路径,
   * 不应被当成用户项目)。由 host 注入 —— 引擎不感知 userData 等平台路径。
   * 命中时 create/update 会把任务归一成对话任务(清 workingDir + workspaceKind='dialogue')。
   */
  isManagedWorkspaceDir?: (dir: string) => boolean;
  /**
   * 被动模式:本实例不参与自动触发 —— start() 不装 tick 时钟、不做僵尸 run 清理
   * (那是活跃实例的 in-flight,不能被本实例误标 interrupted)。CRUD / runNow /
   * 事件广播全部照常。用途:同一台机器 dev / release 双开共用同一 DB 时,给其中
   * 一个实例(通常是 dev)设被动,把自动触发让给另一个,避免同一任务两边各跑一次。
   */
  passive?: boolean;
  /**
   * 全局并发闸门:同时 in-flight 的 run(自动触发 + 手动 runNow)达到该值时,tick
   * 不再放行新的自动触发。到点未放行的任务不丢 —— 它们保留在 activeSchedules 里,
   * nextFireAt 停在过去,后续每个 tick 天然重试,槽位释放后按「等得最久优先」依次
   * 放行(错过的 cron 点不补发,与 nextIntervalFire 的语义一致)。手动 runNow 是
   * 用户显式动作,不被闸门拦截,但计入占用、会挤压后续自动触发。
   * 背景:每个 run 都会在宿主进程里实例化完整会话上下文(agent 子进程 + MCP 注册),
   * 无上限并发触发在任务堆积时会耗尽宿主内存(2026-07-07 凌晨实际 OOM 崩溃)。
   */
  maxConcurrentRuns?: number;
  /** 宿主注入的 Scheduler 实例标识，用于区分同机多实例日志。 */
  instanceId?: string;
  /** 可选宿主进程标识；package 本身不读取 process，保持运行环境解耦。 */
  processId?: number;
}

const DEFAULT_TICK_MS = 1_000;

/** maxConcurrentRuns 缺省值。内部常量,宿主可经 SchedulerOptions 覆盖,不进用户设置。 */
export const DEFAULT_MAX_CONCURRENT_RUNS = 4;

/** 并发闸门「有任务在排队」日志的节流间隔 —— tick 每秒一次,不节流会刷屏。 */
const GATE_LOG_THROTTLE_MS = 30_000;

/** 单条执行超过该时长后输出周期性长跑诊断。 */
const LONG_RUNNING_DIAGNOSTIC_MS = 10 * 60_000;

/**
 * In-flight run 心跳续期间隔。执行实例每隔这么久把自己 in-flight run 的
 * heartbeatAt 刷到 DB，作为跨实例的"我还活着在跑"租约信号。
 */
export const RUN_HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * 心跳过期阈值（≈4 个心跳周期）。'running' 行的 COALESCE(heartbeatAt, firedAt)
 * 落后当前时间超过它，才被僵尸清理视为无主并改写 interrupted。
 * 必须显著大于 RUN_HEARTBEAT_INTERVAL_MS，容忍偶发的写盘延迟 / 事件循环卡顿。
 */
export const RUN_HEARTBEAT_STALE_MS = 60_000;

/**
 * tick 间隔缺口超过它视为进程刚从系统挂起（睡眠）恢复。同机双实例一起睡一起醒，
 * 醒来瞬间所有实例的心跳都停留在睡前——必须先给 owner 一个完整过期窗口续心跳，
 * 再恢复僵尸清扫，否则会把对方仍然活着的 run 误判成僵尸。
 */
const SUSPEND_GAP_MS = 30_000;

/**
 * 老版本(无心跳字段)写入的 'running' 行在运行期清扫里的过期窗口(按 firedAt)。
 * 两难权衡:NULL 心跳行既可能是"跨版本双开时老版本活实例正在跑"(不能动),也
 * 可能是"老版本崩溃残留的僵尸"(必须收,否则 running 行永久卡死,auto-relaunch
 * 的 busy probe 一直看到"忙"、更新自动重启被无限期阻塞)。心跳无法区分两者,
 * 只能按时长赌:绝大多数真实 run 远短于本窗口,超过它仍 'running' 的 NULL 行按
 * 僵尸收掉;极端长跑的老版本活 run 被误标的后果(瞬时假红点,完成时被 owner 覆写)
 * 与老版本自身长期以来的启动清理行为同类,且仅存在于版本过渡期。
 */
export const RUN_LEGACY_STALE_MS = 2 * 60 * 60 * 1000;

/**
 * activeSchedules 内存副本与 DB 的周期性同步间隔。多实例共库时,另一实例对任务
 * 的增删改与触发认领只落在 DB,本进程收不到任何事件 —— 定期重灌让本实例
 * (a) 看到对方新建/修改的任务 (b) 在对方退出后接管其任务的后续触发。
 * 触发互斥不依赖本同步(靠 claimDueFire 的 CAS),同步只解决"不漏、不永久滞后"。
 */
const DB_SYNC_INTERVAL_MS = 30_000;

/** 公开快照字段之外，再保留最近一次长跑诊断时间用于日志节流。 */
interface InflightAttempt extends SchedulerInflightRun {
  lastLongRunningLogAt?: number;
}

interface InflightRunDiagnostic extends SchedulerInflightRun {
  durationMs: number;
}

export class Scheduler extends EventEmitter {
  private readonly storage: ScheduleStorage;
  private readonly runner: ScheduleRunner;
  private readonly clock: Clock;
  private readonly logger?: Logger;
  private readonly tickIntervalMs: number;
  private readonly generateId: () => string;

  private readonly activeSchedules = new Map<string, Schedule>();
  // 同一 schedule 的用户态 CRUD 必须把“持久化写入 + activeSchedules 同步”视作一个
  // 临界区。否则 update 恢复 expired 的 await 返回后，pause 可能先删缓存，旧 update
  // 再把 active 快照加回来。不同 schedule 仍可并发，避免全局锁拖慢无关任务。
  private readonly scheduleMutationTails = new Map<string, Promise<void>>();
  private tickHandle: ReturnType<typeof setInterval> | null = null;
  private started = false;
  // In-flight run 心跳定时器:inflight registry 非空时运行(fireOne / runNow /
  // passive 实例的手动触发都靠它续租),清空时停,见 startHeartbeatLoopIfNeeded。
  private heartbeatHandle: ReturnType<typeof setInterval> | null = null;
  // 僵尸清扫的挂起唤醒防误杀:上次 tick 时刻 + 清扫解禁时刻(见 SUSPEND_GAP_MS)。
  private lastTickAt = 0;
  private sweepBlockedUntil = 0;

  // In-flight run registry — 让 delete / pause 能真正中断已经在跑的 runner.fire()。
  //   inflightControllers: runId → AbortController (deleteRun 可精准 abort 单条)
  //   inflightByschedule:  scheduleId → Set<runId>   (delete/pause 一次 abort 全部)
  // 两个 map 在 fireOne / runNow 的 try 顶部注册,在 finally 中清理,确保不泄漏。
  private readonly inflightControllers = new Map<string, AbortController>();
  private readonly inflightByschedule = new Map<string, Set<string>>();
  // 被 silenceInflightRuns 标记为"本轮静默"的 runId。仅内存(进程重启丢失 →
  // 通知照发,fail-safe);fireOne/runNow 终态落库后清理对应条目。
  private readonly silencedRuns = new Set<string>();
  // sessionId → 当前 in-flight runId 的反向映射。让 MCP 静默工具无需 agent 传 runId,
  // 直接按"是谁在调我"(调用方 session)定位本轮 run —— 把易漂移的 LLM 传参收回代码。
  //   sessionIdToRunId: sessionId → runId(正向,resolveInflightRunForSession 读)
  //   runIdToSessionId: runId → sessionId(反向,仅供 unregister 清理用,免去遍历)
  // 写入点:buildOnTurnActive 回调(runner 在 turn 被会话**接受后**才调,不在 send 之前)。
  // 刻意不在 onSessionBound(send 前)写:同一 session 上重叠的两个 run 里,被
  // SESSION_RUNNING 拒的那个永不写映射,不会覆盖/带走仍在执行的活跃 run 的映射
  // (codex review P2)。heartbeat 同 sessionId 跨轮复用 → 每轮接受时覆盖为最新活跃
  // runId,session 内 turn 串行,覆盖语义正确。清理点:unregisterInflight + stop。
  private readonly sessionIdToRunId = new Map<string, string>();
  private readonly runIdToSessionId = new Map<string, string>();
  // onSessionBound 早于 send accept,不能用于 sessionId→runId 解析;但显式
  // silenceRun(runId) 已经锁定了 run,可用该 sessionId 尽早广播静默抑制信号。
  private readonly runIdToBoundSessionId = new Map<string, string>();

  private readonly isManagedWorkspaceDir?: (dir: string) => boolean;
  private readonly passive: boolean;
  private lastDbSyncAt = 0;

  // ── 并发闸门状态 ──────────────────────────────────────────────────────────
  // fireOne / runNow 包装层在第一次 await 前同步写入 attempts，tick 直接读取 Map.size。
  // 这样既保留原计数的无超发窗口，又让每个占用都能追溯到具体 run/source/phase。
  private readonly maxConcurrentRuns: number;
  private readonly schedulerInstanceId: string;
  private readonly processId?: number;
  private readonly inflightAttempts = new Map<string, InflightAttempt>();
  private readonly waitingSchedules = new Map<string, SchedulerWaitingSchedule>();
  private lastGateLogAt = 0;

  constructor(opts: SchedulerOptions) {
    super();
    this.storage = opts.storage;
    this.runner = opts.runner;
    this.clock = opts.clock ?? { now: () => Date.now() };
    this.logger = opts.logger;
    this.tickIntervalMs = opts.tickIntervalMs ?? DEFAULT_TICK_MS;
    this.generateId = opts.generateId ?? defaultGenerateId;
    this.isManagedWorkspaceDir = opts.isManagedWorkspaceDir;
    this.passive = opts.passive ?? false;
    this.maxConcurrentRuns = Math.max(1, opts.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT_RUNS);
    this.schedulerInstanceId = opts.instanceId ?? `scheduler-${defaultGenerateId()}`;
    this.processId = opts.processId;
  }

  /**
   * workingDir 指向 app 管理的对话工作区时归一成对话任务。
   * agent 在对话里建/改任务时常把自己的 cwd(对话的随机管理目录)当 workingDir
   * 传进来 —— 这个目录是实现细节,按 project 对待会让任务与生成的会话错误地
   * 归入项目分组。命中时清掉 workingDir(runner 每次 fire 另行分配)并强制
   * workspaceKind='dialogue'。create 与 update 共用。
   */
  private normalizeManagedWorkingDir<
    T extends { workingDir?: string; workspaceKind?: Schedule['workspaceKind'] },
  >(input: T): T {
    const dir = (input.workingDir ?? '').trim();
    if (!dir || !this.isManagedWorkspaceDir?.(dir)) return input;
    return { ...input, workingDir: undefined, workspaceKind: 'dialogue' };
  }

  async start(): Promise<void> {
    if (this.started) return;
    // 被动模式:不装 tick 时钟、不做僵尸清理(可能误伤另一个活跃实例正在跑的
    // run)、不预载 activeSchedules(反正不 tick)。CRUD / runNow 照常可用。
    if (this.passive) {
      this.started = true;
      this.logger?.info?.('scheduler: started in passive mode (auto-fire disabled for this instance)');
      return;
    }
    // 先清理残留的 'running' 僵尸：app 关闭/崩溃时正在跑的 run 没机会走到
    // fireOne 的 finally 分支，DB 里仍是 status='running'。这里改写为
    // 'interrupted' 给 UI 区分，并防止未读 badge 永远卡着不消化。
    // 只清心跳过期的行——共库的另一个活实例正在跑的 run 心跳仍新鲜，绝不能
    // 误标（曾把对方 in-flight 心跳 run 标成 interrupted，在对方静默完成后
    // 给本实例 UI 留下一个永远消不掉的假失败红点）。刚崩溃（<过期窗口）的
    // 自家僵尸此处会被暂时放过，由运行期周期清扫（见 tick）在窗口过后收尾。
    const startNow = this.clock.now();
    try {
      const affected = await this.storage.markRunningAsInterrupted(
        startNow - RUN_HEARTBEAT_STALE_MS,
      );
      if (affected.length > 0) {
        this.logger?.info?.(
          `scheduler: marked ${affected.length} stale running run(s) as interrupted`,
        );
      }
    } catch (err) {
      this.logger?.error?.('scheduler: markRunningAsInterrupted failed', err);
    }
    // 运行期清扫也从"启动 + 完整过期窗口"后才开始:启动时未过期的行要么是活
    // 实例的(会持续续期),要么是刚死的僵尸(过窗口后自然过期),都不必抢着判。
    this.sweepBlockedUntil = startNow + RUN_HEARTBEAT_STALE_MS;
    const actives = await this.storage.listActive();
    const now = this.clock.now();
    this.lastTickAt = now;
    for (const sch of actives) {
      // 注意：这里**不做** intervalMs 回填。曾有一段"老数据迁移"逻辑会把 interval
      // 形态 cron（`*/10 * * * *` 等）的任务在启动时打上 intervalMs——但它无法区分
      // 老数据和新建任务，MCP 创建的纯 cron 任务会被误转成 interval 语义并永久冻结
      // 节奏（cron 后续怎么改都不生效）。迁移已于 2026-05 上线并跑了一个月，存量
      // 老任务均已转换完，该逻辑只剩误伤，故移除。
      let current = sch;
      const next = computeNextFireAt(current, now);
      if (next !== current.nextFireAt) {
        const updated = await this.storage.update(current.id, { nextFireAt: next });
        if (updated) current = updated;
        else current = { ...current, nextFireAt: next };
      }
      this.activeSchedules.set(current.id, current);
    }
    // 刚做完全量加载,视作一次已完成的 DB 同步。
    this.lastDbSyncAt = now;
    this.tickHandle = setInterval(() => {
      this.tick().catch((err) => this.logger?.error?.('scheduler tick error', err));
    }, this.tickIntervalMs);
    this.started = true;
  }

  async stop(): Promise<void> {
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
    // 切账号 / 进程退出前主动 abort 所有 in-flight —— 不然 runner 还在跑,事件流
    // 已断,run 行 stuck 在 'running'(心跳过期后由任一实例的清扫/start() 兜底,
    // 但当下的 agent 子进程仍在烧 token)。
    for (const controller of this.inflightControllers.values()) {
      try { controller.abort(); } catch (err) {
        this.logger?.warn?.('scheduler.stop: controller.abort threw', err);
      }
    }
    if (this.inflightAttempts.size > 0) {
      const now = this.clock.now();
      this.logger?.info?.('scheduler: releasing in-flight runs on stop', {
        schedulerInstanceId: this.schedulerInstanceId,
        processId: this.processId,
        inFlightBefore: this.inflightAttempts.size,
        inFlightAfter: 0,
        runs: this.describeInflightRuns(now),
      });
    }
    this.inflightAttempts.clear();
    this.waitingSchedules.clear();
    this.inflightControllers.clear();
    this.inflightByschedule.clear();
    this.stopHeartbeatLoopIfIdle();
    this.sessionIdToRunId.clear();
    this.runIdToSessionId.clear();
    this.runIdToBoundSessionId.clear();
    this.activeSchedules.clear();
    this.started = false;
    this.emitRuntimeState();
  }

  // Public for testing — tests construct Scheduler with a long tickIntervalMs to disable
  // the real interval, then call tick() directly with a fake clock. Production code should
  // rely on the interval scheduled in start(); use runNow() (not tick) for force-fire.
  async tick(): Promise<void> {
    const now = this.clock.now();
    // 挂起唤醒防误杀:tick 间隔出现大缺口说明进程刚从系统睡眠恢复。同机共库的
    // 实例一起睡一起醒,此刻所有 in-flight 心跳都停留在睡前——立刻清扫会把对方
    // 仍活着的 run 误判成僵尸。推迟一个完整过期窗口,给所有 owner 续心跳的机会。
    if (this.lastTickAt > 0 && now - this.lastTickAt > SUSPEND_GAP_MS) {
      this.sweepBlockedUntil = now + RUN_HEARTBEAT_STALE_MS;
    }
    this.lastTickAt = now;
    // 周期性从 DB 重灌 activeSchedules。多实例共库时另一实例的增删改/认领只发生
    // 在 DB,本进程收不到事件;不同步的话,输掉一次认领的任务会以 nextFireAt=空
    // 永远留在内存里,对方退出后本实例也无法接管。重灌是安全的:触发互斥由
    // fireOne 的 claimDueFire CAS 保证,即使重灌回一条过期副本,认领时 CAS 对不上
    // 也只是空转一次。lastDbSyncAt 在 await 前先置位,防重叠 tick 并发同步。
    if (now - this.lastDbSyncAt >= DB_SYNC_INTERVAL_MS) {
      this.lastDbSyncAt = now;
      try {
        const actives = await this.storage.listActive();
        this.activeSchedules.clear();
        for (const sch of actives) this.activeSchedules.set(sch.id, sch);
      } catch (err) {
        this.logger?.warn?.('scheduler: active-schedule DB sync failed', err);
      }
      // 顺路做运行期僵尸清扫:另一实例崩溃留下的 'running' 行不再等谁重启才收尾,
      // 本实例在心跳过期后就地改写 interrupted 并广播 'changed' 刷 UI。
      // excludeRunIds 兜底排除本进程 in-flight(即使自家心跳续期停摆也绝不自伤)。
      await this.sweepStaleRunningRuns(now);
    }
    const due: Schedule[] = [];
    for (const sch of this.activeSchedules.values()) {
      if (sch.nextFireAt !== undefined && sch.nextFireAt <= now) {
        due.push(sch);
      }
    }
    if (due.length === 0) {
      this.syncWaitingSchedules([]);
      return;
    }
    // 并发闸门:只放行「上限 - 当前 in-flight」个触发,等得最久的优先。未放行的
    // **不从 activeSchedules 删除** —— nextFireAt 停在过去,下个 tick 天然重试,
    // 这就是等待队列本身:无新增状态、无新增持久化,进程重启后由 start() 归一接管。
    // 排队任务的认领(claimDueFire)只在真正放行时发生,跨实例互斥语义不变。
    due.sort((a, b) => (a.nextFireAt ?? 0) - (b.nextFireAt ?? 0));
    const slots = Math.max(0, this.maxConcurrentRuns - this.inflightAttempts.size);
    const toFire = due.slice(0, slots);
    const gatedSchedules = due.slice(slots);
    const gated = gatedSchedules.length;
    for (const sch of toFire) {
      // Synchronous removal prevents another concurrent tick from picking the same one.
      this.activeSchedules.delete(sch.id);
    }
    // 调用 async fireOne 会在返回 promise 前同步登记 attempt；先构造 promises 再记 gate
    // 日志，日志里的 inFlightRuns 就同时包含本 tick 刚占槽的 run，不再出现 0/1 却 gated。
    const firePromises = toFire.map((schedule) => this.fireOne(schedule));
    this.syncWaitingSchedules(gatedSchedules);
    if (gated > 0 && now - this.lastGateLogAt >= GATE_LOG_THROTTLE_MS) {
      this.lastGateLogAt = now;
      this.logger?.info?.('scheduler: concurrency gate holding due fires', {
        schedulerInstanceId: this.schedulerInstanceId,
        processId: this.processId,
        inFlight: this.inflightAttempts.size,
        maxConcurrentRuns: this.maxConcurrentRuns,
        inFlightRuns: this.describeInflightRuns(now),
        gatedSchedules: gatedSchedules.map((schedule) => ({
          scheduleId: schedule.id,
          scheduleName: schedule.name,
          waitingMs: Math.max(0, now - (schedule.nextFireAt ?? now)),
        })),
      });
    }
    if (firePromises.length === 0) return;
    await Promise.all(firePromises);
  }

  /** 并发登记包装:同步注册/释放让 tick 的槽位计算无超发窗口(见字段注释)。 */
  private async fireOne(schedule: Schedule): Promise<void> {
    const runId = this.generateId();
    const now = this.clock.now();
    this.beginInflightAttempt({
      scheduleId: schedule.id,
      scheduleName: schedule.name,
      runId,
      source: 'automatic',
      executionMode: schedule.executionMode ?? 'agent',
      slotWaitMs: Math.max(0, now - (schedule.nextFireAt ?? now)),
      phase: 'claiming',
    });
    try {
      await this.fireOneInner(schedule, runId);
    } finally {
      this.finishInflightAttempt(runId);
    }
  }

  private async fireOneInner(schedule: Schedule, runId: string): Promise<void> {
    // 跨进程互斥:先在 DB 对这次触发做原子认领(CAS:nextFireAt 必须仍等于本进程
    // 内存里看到的值)。dev / release 双开共用同一 DB 时两边引擎会同时判定"到点
    // 了",只有认领成功的一方真正执行;失败方刷新内存副本后放弃,保证同一次到点
    // 只跑一次。认领把 nextFireAt 置空(运行期间无下次排期),结束时按 recurring
    // 语义重排;若进程运行中途崩溃,任一实例下次 start() 的归一会重新排期。
    // ⚠️ 已知窄窗口:空 nextFireAt 同时承担"in-flight 认领"和"崩溃残留"两种语义,
    // start() 归一无法区分——另一实例在本实例长 run 期间启动,会把认领标记重排回
    // 可触发时间,该任务可能被并发跑一次。根治需给认领加租约字段(claim owner +
    // 心跳续期,follow-up);过渡期双开场景建议其中一端开 passive 模式让位。
    if (schedule.nextFireAt !== undefined) {
      let claimed: Schedule | null;
      try {
        claimed = await this.storage.claimDueFire(schedule.id, schedule.nextFireAt);
      } catch (err) {
        // DB 竞争(如另一进程持写锁)拿不到结论 → 原样放回内存,下个 tick 重试。
        this.logger?.warn?.('scheduler: claimDueFire errored, retry next tick', {
          scheduleId: schedule.id,
          error: String(err),
        });
        this.activeSchedules.set(schedule.id, schedule);
        return;
      }
      if (!claimed) {
        // 被另一实例抢先(或任务已被改期/暂停/删除)。刷新内存副本跟上 DB 真值。
        const fresh = await this.storage.get(schedule.id);
        if (fresh && fresh.status === 'active') this.activeSchedules.set(fresh.id, fresh);
        else this.activeSchedules.delete(schedule.id);
        this.logger?.info?.('scheduler: due fire already claimed elsewhere, skipped', {
          scheduleId: schedule.id,
        });
        return;
      }
      schedule = claimed;
    }
    this.updateInflightAttempt(runId, 'persisting');
    const firedAt = this.clock.now();
    const initialRun: ScheduleRun = {
      id: runId,
      scheduleId: schedule.id,
      firedAt,
      status: 'running',
      // Script 不产生 agent token，零费用是确定值；agent 费用在 turn done 后异步归因。
      costAttribution: schedule.executionMode === 'script' ? 'zero' : 'unavailable',
      heartbeatAt: firedAt,
    };
    try {
      await this.storage.insertRun(initialRun);
    } catch (err) {
      this.logger?.error?.('insertRun failed', err);
      return;
    }
    const controller = new AbortController();
    this.registerInflight(schedule.id, runId, controller);
    if (schedule.silentWhenIdle) {
      this.silencedRuns.add(runId);
    }
    this.emitEvent({
      type: 'fired',
      scheduleId: schedule.id,
      runId,
      ...(schedule.silentWhenIdle ? { silent: true } : {}),
    });

    let sessionId: string | undefined;
    let resultText: string | undefined;
    let runError: string | undefined;
    let deferred = false;
    let deferRetryMs: number | undefined;
    let skipped = false;
    this.updateInflightAttempt(runId, 'running');
    try {
      const result = await this.runner.fire(schedule, {
        runId,
        firedAt,
        signal: controller.signal,
        onSessionBound: this.buildOnSessionBound(schedule.id, runId),
        onPreRunHookCompleted: this.buildOnPreRunHookCompleted(runId),
        onTurnActive: this.buildOnTurnActive(runId),
        createChildRun: this.buildCreateChildRun(schedule.id, firedAt),
      });
      sessionId = result.sessionId;
      resultText = result.resultText;
      deferred = result.deferred ?? false;
      deferRetryMs = result.deferRetryMs;
      skipped = result.skipped ?? false;
    } catch (err) {
      runError = err instanceof Error ? err.message : String(err);
      this.logger?.warn?.('schedule fire failed', { scheduleId: schedule.id, runId, error: runError });
    } finally {
      this.unregisterInflight(schedule.id, runId);
      this.updateInflightAttempt(runId, 'finalizing');
    }

    // 如果是被 delete/pause 主动 abort 的,把 run 标 'aborted' 而非 'failed' —— 让 UI
    // 用 RunHistoryCard 渲染时能区分"用户中断"和"agent 自爆"。判定见 wasRunAborted。
    const wasAborted = this.wasRunAborted(schedule, controller.signal, runError);

    // Mark the run row (schedule_runs table). The schedule row update below is a SEPARATE
    // table — do not collapse the two storage.update calls.
    const finishedAt = this.clock.now();

    // 顺延(目标 session 正忙 / 活跃礼让):本轮没真跑。撤销预插的 running run
    // (不留可见记录)、不 emit completed/failed(不亮红点不通知)、不写 lastFiredAt
    // (没真跑)。只把 nextFireAt 前移 deferRetryMs 后重试 —— 必须前移,否则
    // nextFireAt<=now 会让下个 tick 立刻再触发,变忙循环。被 abort 时让 abort 优先。
    if (deferred && !wasAborted) {
      try {
        await this.storage.deleteRun(runId);
      } catch (err) {
        this.logger?.warn?.('deleteRun on defer failed', { scheduleId: schedule.id, runId, error: String(err) });
      }
      this.silencedRuns.delete(runId);
      const retryAt = finishedAt + (deferRetryMs ?? 60_000);
      const updated = await this.storage.update(schedule.id, { nextFireAt: retryAt });
      if (updated && updated.status === 'active') {
        this.activeSchedules.set(updated.id, updated);
      }
      // 'deferred' 配对先前的 'fired',让 UI 清掉 ephemeral running 态(不留可见 run);
      // 'changed' 让列表 revalidate 新的 nextFireAt。
      this.emitEvent({ type: 'deferred', scheduleId: schedule.id, runId });
      this.emitEvent({ type: 'changed', scheduleId: schedule.id });
      return;
    }

    if (wasAborted) {
      await this.storage.updateRun(runId, {
        status: 'aborted',
        finishedAt,
        errorMsg: 'cancelled by user (schedule deleted or paused)',
      });
      this.emitEvent({
        type: 'failed',
        scheduleId: schedule.id,
        runId,
        error: 'aborted',
      });
    } else if (runError !== undefined) {
      await this.storage.updateRun(runId, {
        status: 'failed',
        finishedAt,
        errorMsg: runError,
      });
      this.emitEvent({ type: 'failed', scheduleId: schedule.id, runId, error: runError });
    } else if (skipped) {
      // 前置检查拦截(preRunHook exit 2):run 记录保留为 'skipped'(与 deferred 的
      // "撤销不留痕"不同——跳过是本轮的最终结果,用户要能在历史里看到"这几轮是
      // hook 拦的",与"调度器坏了"区分)。生而已读(readAt),不通知不亮红点;
      // sessionId: 跳过时为空(不再创建留痕会话)。schedule 行照常走下方重排逻辑。
      await this.storage.updateRun(runId, {
        status: 'skipped',
        sessionId: sessionId || undefined,
        finishedAt,
        costAttribution: 'zero',
        resultText,
        readAt: finishedAt,
      });
      this.emitEvent({ type: 'skipped', scheduleId: schedule.id, runId, sessionId: sessionId ?? '' });
    } else {
      // No error path: runner resolved. sessionId is whatever runner returned (string per
      // FireResult contract); empty string is still treated as success — runner is responsible
      // for throwing if it has no session to report.
      const finalSessionId = sessionId ?? '';
      // 静默 run(agent 经 silenceInflightRuns 声明"本轮无需关注"):落库时直接
      // 置 readAt(生而已读)→ 小红点计算(!readAt && 终态)天然排除,运行历史
      // 仍完整保留。仅 success 生效;failed/aborted 保留未读(异常必须可见)。
      await this.storage.updateRun(runId, {
        status: 'success',
        sessionId: finalSessionId,
        finishedAt,
        resultText,
        ...(this.silencedRuns.has(runId) ? { readAt: finishedAt } : {}),
      });
      this.emitEvent({
        type: 'completed',
        scheduleId: schedule.id,
        runId,
        sessionId: finalSessionId,
        ...(this.silencedRuns.has(runId) ? { silenced: true } : {}),
      });
    }
    this.silencedRuns.delete(runId);

    // Aborted 路径不更新 schedule 行 —— schedule 大概率已被 delete(行已不存在,update
    // 是 no-op)或 pause(status='paused',activeSchedules 已被摘出)。重排 nextFireAt
    // 会引入幽灵下次触发,resume 时 resume() 自己会重算,这里跳过最干净。
    if (wasAborted) {
      return;
    }

    // Update the schedule row (schedules table — different from schedule_runs above).
    // lastFinishedAt 跟随终态写入：success/failed 都算"跑完了一次"，UI 列表
    // "Last X ago" 用本字段，避免显示出 fired vs finished 间的间隙感。
    //
    // 重排前必须重读 DB 行：run 进行中 schedule 可能已被 update()（典型：任务内
    // agent 调 schedule_update 自适应降档改 cron）。用 fire 时刻的快照重排会把
    // 刚改好的新节奏覆盖回旧值。行已不存在时回退快照（storage.update 是 no-op）。
    const current = (await this.storage.get(schedule.id)) ?? schedule;
    if (current.recurring) {
      // intervalMs 模式：finishedAt + N（时间已经走到 finishedAt，不需要再 max(now,...)）。
      // cron 模式：保持原行为，从 finishedAt 找下一个壁钟槽位。
      const next =
        current.intervalMs !== undefined
          ? finishedAt + current.intervalMs
          : nextCronOrMonthlyFire(current.cronExpr, finishedAt, current.timezone);
      const updated = await this.storage.update(schedule.id, {
        lastFiredAt: firedAt,
        lastFinishedAt: finishedAt,
        nextFireAt: next,
      });
      if (updated && updated.status === 'active') {
        this.activeSchedules.set(updated.id, updated);
      }
    } else {
      // 豁免调用方 run 自暂停场景：run 完成后重读行可能已是 'paused'（调用方在
      // run 内调 schedule_pause 并豁免自身 → pause() 写 'paused' → run 自然结束）。
      // 不覆盖 'paused'，只补 timing 字段；行已删（delete 豁免场景）storage.update
      // 是 no-op，直接写 'expired' 也安全。
      if (current.status === 'paused') {
        await this.storage.update(schedule.id, {
          lastFiredAt: firedAt,
          lastFinishedAt: finishedAt,
        });
      } else {
        await this.storage.update(schedule.id, {
          lastFiredAt: firedAt,
          lastFinishedAt: finishedAt,
          status: 'expired',
          nextFireAt: undefined,
        });
      }
      // Do not re-add to activeSchedules.
    }
    this.emitEvent({ type: 'changed', scheduleId: schedule.id });
  }

  // Force-fire a schedule now.
  // - lastFiredAt 也更新 —— "上次触发"语义包含手动 fire，UI 列表的 "Last X ago"
  //   应该反映最近一次实际执行（cron / manual 均算）。
  // - nextFireAt 不动 —— 手动触发不应改变下一次按 cron 排定的时间。
  // - 副作用：recurring=false 的任务被手动 runNow 后 lastFiredAt 落地，
  //   重启 app 时 computeNextFireAt 会返回 undefined → 不会再被 cron 触发。
  //   这反而更贴合"Once"语义：用户手动跑过一次就视作用完。
  async runNow(id: string): Promise<{ runId: string }> {
    // 手动触发不受并发闸门拦截(用户显式动作要即时响应),但计入 in-flight 占用,
    // 会挤压后续自动触发的槽位。
    const runId = this.generateId();
    this.beginInflightAttempt({
      scheduleId: id,
      runId,
      source: 'run-now',
      phase: 'loading',
    });
    try {
      return await this.runNowInner(id, runId);
    } finally {
      this.finishInflightAttempt(runId);
    }
  }

  private async runNowInner(id: string, runId: string): Promise<{ runId: string }> {
    const schedule = await this.storage.get(id);
    if (!schedule) throw new Error(`Schedule not found: ${id}`);
    this.updateInflightAttempt(runId, 'persisting', schedule);
    const firedAt = this.clock.now();
    const initialRun: ScheduleRun = {
      id: runId,
      scheduleId: schedule.id,
      firedAt,
      status: 'running',
      costAttribution: schedule.executionMode === 'script' ? 'zero' : 'unavailable',
      heartbeatAt: firedAt,
    };
    await this.storage.insertRun(initialRun);
    // 立刻把 lastFiredAt 落到 schedule row —— 不等 finished，让 UI 列表立刻反映
    // "刚跑了一次"。同时若 activeSchedules 里有这条，同步内存副本。
    await this.storage.update(schedule.id, { lastFiredAt: firedAt });
    const cached = this.activeSchedules.get(schedule.id);
    if (cached) this.activeSchedules.set(schedule.id, { ...cached, lastFiredAt: firedAt });
    const controller = new AbortController();
    this.registerInflight(schedule.id, runId, controller);
    if (schedule.silentWhenIdle) {
      this.silencedRuns.add(runId);
    }
    this.emitEvent({
      type: 'fired',
      scheduleId: schedule.id,
      runId,
      ...(schedule.silentWhenIdle ? { silent: true } : {}),
    });

    let finishedAt = firedAt;
    let runError: string | undefined;
    let runSessionId: string | undefined;
    let runResultText: string | undefined;
    let deferred = false;
    let deferRetryMs: number | undefined;
    let skipped = false;
    this.updateInflightAttempt(runId, 'running');
    try {
      const result = await this.runner.fire(schedule, {
        runId,
        firedAt,
        signal: controller.signal,
        onSessionBound: this.buildOnSessionBound(schedule.id, runId),
        onPreRunHookCompleted: this.buildOnPreRunHookCompleted(runId),
        onTurnActive: this.buildOnTurnActive(runId),
        createChildRun: this.buildCreateChildRun(schedule.id, firedAt),
      });
      runSessionId = result.sessionId;
      runResultText = result.resultText;
      deferred = result.deferred ?? false;
      deferRetryMs = result.deferRetryMs;
      skipped = result.skipped ?? false;
    } catch (err) {
      runError = err instanceof Error ? err.message : String(err);
    } finally {
      this.unregisterInflight(schedule.id, runId);
      this.updateInflightAttempt(runId, 'finalizing');
    }
    finishedAt = this.clock.now();

    const wasAborted = this.wasRunAborted(schedule, controller.signal, runError);

    // 顺延(手动触发撞忙也礼让,与 cron 路径一致):撤销预插的 running run、不通知。
    // runNow 正常路径不动 nextFireAt;但顺延必须把 nextFireAt 前移到短延后,让 cron
    // tick 在会话空闲后接力真跑(否则手动触发撞忙就石沉大海)。
    if (deferred && !wasAborted) {
      try {
        await this.storage.deleteRun(runId);
      } catch (err) {
        this.logger?.warn?.('deleteRun on defer failed', { scheduleId: schedule.id, runId, error: String(err) });
      }
      this.silencedRuns.delete(runId);
      const retryAt = finishedAt + (deferRetryMs ?? 60_000);
      // 还原 lastFiredAt:runNow 在 fire 前已乐观写 lastFiredAt=firedAt(让 UI 立刻
      // 反映"刚跑了一次");但顺延意味着没真跑,必须撤销这次乐观写,恢复到 fire 前的
      // schedule.lastFiredAt。否则:① 顺延却显示成"已触发",违背"顺延不留可见记录";
      // ② 对 recurring=false 的 Once 任务,lastFiredAt 一旦落地,重启时
      // computeNextFireAt 会因 lastFiredAt 已设而返回 undefined → 顺延的重试被吞掉。
      const updated = await this.storage.update(schedule.id, {
        nextFireAt: retryAt,
        lastFiredAt: schedule.lastFiredAt,
      });
      if (updated && updated.status === 'active') {
        this.activeSchedules.set(updated.id, updated);
      }
      // 'deferred' 配对先前的 'fired'(清 UI running 态、不留可见 run);'changed' revalidate。
      this.emitEvent({ type: 'deferred', scheduleId: schedule.id, runId });
      this.emitEvent({ type: 'changed', scheduleId: schedule.id });
      return { runId };
    }

    if (wasAborted) {
      await this.storage.updateRun(runId, {
        status: 'aborted',
        finishedAt,
        errorMsg: 'cancelled by user (schedule deleted or paused)',
      });
      this.emitEvent({ type: 'failed', scheduleId: schedule.id, runId, error: 'aborted' });
    } else if (runError !== undefined) {
      await this.storage.updateRun(runId, {
        status: 'failed',
        finishedAt,
        errorMsg: runError,
      });
      this.emitEvent({ type: 'failed', scheduleId: schedule.id, runId, error: runError });
    } else if (skipped) {
      // 前置检查拦截:语义同 fireOne 的 skipped 分支(run 保留为 'skipped'、生而
      // 已读、不通知)。手动触发被 hook 拦下同样留痕,让用户点"立即运行"后能看到
      // "被前置检查拦了"而不是石沉大海。
      await this.storage.updateRun(runId, {
        status: 'skipped',
        sessionId: runSessionId || undefined,
        finishedAt,
        costAttribution: 'zero',
        resultText: runResultText,
        readAt: finishedAt,
      });
      this.emitEvent({
        type: 'skipped',
        scheduleId: schedule.id,
        runId,
        sessionId: runSessionId ?? '',
      });
    } else {
      // 静默语义与 fireOne 一致:success 落库带 readAt,失败路径不豁免。
      await this.storage.updateRun(runId, {
        status: 'success',
        sessionId: runSessionId,
        finishedAt,
        resultText: runResultText,
        ...(this.silencedRuns.has(runId) ? { readAt: finishedAt } : {}),
      });
      this.emitEvent({
        type: 'completed',
        scheduleId: schedule.id,
        runId,
        sessionId: runSessionId ?? '',
        ...(this.silencedRuns.has(runId) ? { silenced: true } : {}),
      });
    }
    this.silencedRuns.delete(runId);

    // Aborted 路径同 fireOne:schedule 大概率已被 delete/pause,不要重写 lastFinishedAt
    // (避免污染已删除/已暂停 schedule 的字段)。
    if (!wasAborted) {
      // runNow 跟 cron 路径一致：把 lastFinishedAt 写到 schedule row，让 UI 列表
      // 立刻反映"刚跑完了一次"。nextFireAt 不动（manual 触发不该改 cron 排定时间）。
      await this.storage.update(schedule.id, { lastFinishedAt: finishedAt });
      const cachedAfter = this.activeSchedules.get(schedule.id);
      if (cachedAfter) {
        this.activeSchedules.set(schedule.id, { ...cachedAfter, lastFinishedAt: finishedAt });
      }
    }
    // 'changed' tells UI to revalidate the run-history view (a new ScheduleRun row exists,
    // even though the schedule's nextFireAt/lastFiredAt are intentionally untouched).
    this.emitEvent({ type: 'changed', scheduleId: schedule.id });
    return { runId };
  }

  // ---------- CRUD ----------

  async list(filter?: ListFilter): Promise<Schedule[]> {
    return this.storage.list(filter);
  }

  async get(id: string): Promise<Schedule | null> {
    return this.storage.get(id);
  }

  async listRuns(scheduleId: string, limit?: number): Promise<ScheduleRun[]> {
    return this.storage.listRuns(scheduleId, limit);
  }

  /**
   * 删除单条历史 run 记录。
   * - 找不到 → throw 'Schedule run not found'（与其他 NOT_FOUND 路径文案统一）
   * - running 状态的 run 不该删（fireOne 后续 updateRun 会找不到行）—— 调用前应过滤；
   *   storage 层已经 delete 之后才发现的话只 warn 兜底。
   * - 成功 → emit 'changed'，订阅 useRuns 的 UI 自动刷新。
   */
  async deleteRun(runId: string): Promise<void> {
    const target = await this.storage.deleteRun(runId);
    if (!target) throw new Error(`Schedule run not found: ${runId}`);
    if (target.status === 'running') {
      this.logger?.warn?.('deleteRun removed a running row', { runId, scheduleId: target.scheduleId });
    }
    this.emitEvent({ type: 'changed', scheduleId: target.scheduleId });
  }

  async create(input: CreateScheduleInput): Promise<Schedule> {
    input = this.normalizeManagedWorkingDir(input);
    const now = this.clock.now();
    const id = this.generateId();
    const manual = input.manual ?? false;
    // 首次 nextFireAt：
    //   - manual → undefined（永不自动 fire）
    //   - intervalMs 设了 → createdAt + intervalMs（让"每 N 分钟"有 N 分钟暖场期）
    //   - 其它 → 第一个壁钟 cron 槽位
    let firstFireAt: number | undefined;
    if (!manual) {
      firstFireAt =
        input.intervalMs !== undefined
          ? now + input.intervalMs
          : nextCronOrMonthlyFire(input.cronExpr, now, input.timezone);
    }
    // 未显式传 workspaceKind 时按目标推断:非 heartbeat、不开 worktree、也没给
    // workingDir → 视为对话任务(runner 分配 app 管理的工作区,会话归入"对话"分组)。
    // MCP / 对话路径创建的任务通常不带 workspaceKind,此前一律落成 'project'
    // 却没有目录,UI 归组与 fire 行为都不自洽。
    const inferredWorkspaceKind: Schedule['workspaceKind'] =
      input.workspaceKind ??
      (!input.targetSessionId && !input.useWorktree && !(input.workingDir ?? '').trim()
        ? 'dialogue'
        : 'project');
    const schedule: Schedule = {
      id,
      ...input,
      workspaceKind: inferredWorkspaceKind,
      // null(JSON 边界的"清空"表达)归一成 undefined,Schedule 内存形态只有两态
      preRunHook: input.preRunHook ?? undefined,
      executionMode: input.executionMode ?? 'agent',
      scriptConfig: normalizeScriptConfig(input.scriptConfig),
      manual,
      persistentSession: input.persistentSession ?? false,
      silentWhenIdle: input.silentWhenIdle ?? false,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      nextFireAt: firstFireAt,
    };
    validateScheduleExecutionShape(schedule);
    const inserted = await this.storage.insert(schedule);
    this.activeSchedules.set(id, inserted);
    this.emitEvent({ type: 'changed', scheduleId: id });
    return inserted;
  }

  async update(id: string, patch: UpdateScheduleInput): Promise<Schedule> {
    return this.serializeScheduleMutation(id, () => this.updateUnlocked(id, patch));
  }

  /**
   * 在同一条 per-schedule 串行边界内读取最新任务、异步生成 patch 并更新。
   * 供 patch 依赖当前持久化值的调用方使用，避免锁外快照覆盖并发写入。
   */
  async updateFromCurrent(
    id: string,
    buildPatch: (current: Schedule) => Promise<UpdateScheduleInput>,
  ): Promise<Schedule> {
    return this.serializeScheduleMutation(id, async () => {
      const current = await this.storage.get(id);
      if (!current) throw new Error(`Schedule not found: ${id}`);
      return this.updateUnlocked(id, await buildPatch(current));
    });
  }

  private async updateUnlocked(id: string, patch: UpdateScheduleInput): Promise<Schedule> {
    patch = this.normalizeManagedWorkingDir(patch);
    // patch 显式给了真实 workingDir 而未指明 workspaceKind 时,同步翻成 project
    // (与 create 的推断对称)—— 否则 dialogue 任务被改了目录后仍是 dialogue,
    // 下次 fire 会忽略新目录、照走管理工作区分配,显式设置被静默丢弃。
    // (managed 目录已在上面被归一清掉,走不到这里。)
    if (
      patch.workspaceKind === undefined &&
      typeof patch.workingDir === 'string' &&
      patch.workingDir.trim() !== ''
    ) {
      patch = { ...patch, workspaceKind: 'project' };
    }
    const now = this.clock.now();
    const updates = { ...patch, updatedAt: now } as Partial<Schedule>;
    if (Object.prototype.hasOwnProperty.call(patch, 'scriptConfig')) {
      updates.scriptConfig = normalizeScriptConfig(patch.scriptConfig);
    }
    // preRunHook 显式传 null(JSON 边界的"清空"表达)→ 归一成 undefined,
    // 但保留 key(storage patch 按 hasOwnProperty 判定,key 在且 undefined = 双列清 NULL)。
    if (Object.prototype.hasOwnProperty.call(patch, 'preRunHook') && patch.preRunHook === null) {
      updates.preRunHook = undefined;
    }
    const existing = await this.storage.get(id);
    if (!existing) throw new Error(`Schedule not found: ${id}`);
    const candidate: Schedule = { ...existing, ...updates };
    validateScheduleExecutionShape(
      candidate,
      {
        checkAgentPrompt:
          Object.prototype.hasOwnProperty.call(patch, 'executionMode') ||
          Object.prototype.hasOwnProperty.call(patch, 'prompt'),
      },
    );
    // expired 是一次性任务已消费的终态。编辑后的配置若已经表达为“循环且非手动”，
    // 继续保留 expired 会让持久化状态与排期语义冲突：即使算出了 nextFireAt，任务也
    // 不会进入 activeSchedules，重启后 listActive() 同样加载不到。状态恢复集中在引擎
    // 层处理，让 desktop、device-link 与其它调用方共享一致行为。
    const shouldReactivateExpired =
      existing.status === 'expired' && candidate.recurring && !candidate.manual;
    if (shouldReactivateExpired) {
      updates.status = 'active';
    }
    // manual / intervalMs / cronExpr / timezone 任一变化，或 expired 恢复 active 时，
    // 都要重算 nextFireAt：
    //   - manual:true  → 强制清空 nextFireAt（不再自动 fire）
    //   - manual:false 且 触发字段变 → 按新表达式重算（intervalMs 优先于 cron）
    //   - manual:false 且 触发字段没动 → nextFireAt 保留（避免 update 副作用）
    const needsRecompute =
      patch.cronExpr !== undefined ||
      patch.timezone !== undefined ||
      patch.manual !== undefined ||
      patch.intervalMs !== undefined ||
      shouldReactivateExpired;
    let recomputeFromTo: { from: number | undefined; to: number | undefined } | null = null;
    if (needsRecompute) {
      // cron 变更但 patch 未显式带 intervalMs（典型：MCP 工具只 patch cronExpr，
      // 其 schema 不暴露 intervalMs）→ 一律清空 intervalMs（undefined，storage 落
      // NULL），按字面壁钟语义执行。不清的话旧 intervalMs 永远获胜，改 cron 形同
      // 虚设。也刻意**不做**"按形态推导 interval"：cron 就是 cron，interval 语义
      // 只属于显式传 intervalMs 的调用方（GUI 表单）——推导会让 `0 */12 * * *`
      // 这类壁钟意图被静默转成 interval，且与 create()（不推导）不对称。
      if (patch.cronExpr !== undefined && !('intervalMs' in patch)) {
        updates.intervalMs = undefined;
      }
      const merged: Schedule = { ...existing, ...updates };
      if (merged.manual) {
        updates.nextFireAt = undefined;
      } else if (
        patch.cronExpr !== undefined ||
        patch.timezone !== undefined ||
        patch.manual === false ||
        patch.intervalMs !== undefined ||
        shouldReactivateExpired
      ) {
        // intervalMs 模式：把"修改"视作冷启动，从 now 起新一轮 N 倒计时。
        // cron 模式：照旧从 now 找下一个壁钟槽位。
        updates.nextFireAt =
          merged.intervalMs !== undefined
            ? now + merged.intervalMs
            : nextCronOrMonthlyFire(merged.cronExpr, now, merged.timezone);
      }
      recomputeFromTo = { from: existing.nextFireAt, to: updates.nextFireAt };
    }
    const updated = await this.storage.update(id, updates);
    if (!updated) throw new Error(`Schedule not found: ${id}`);
    if (updated.status === 'active') {
      this.activeSchedules.set(id, updated);
    } else {
      this.activeSchedules.delete(id);
    }
    // DEBUG: 帮排查"编辑后 pending fire 没刷新"问题；只在触发字段变更时打。
    // 看 dev 日志能直接确认 nextFireAt 是否被引擎正确重排。
    if (recomputeFromTo) {
      this.logger?.info?.('scheduler: update recomputed nextFireAt', {
        scheduleId: id,
        from: recomputeFromTo.from,
        to: recomputeFromTo.to,
        fromIso: recomputeFromTo.from ? new Date(recomputeFromTo.from).toISOString() : null,
        toIso: recomputeFromTo.to ? new Date(recomputeFromTo.to).toISOString() : null,
      });
    }
    this.emitEvent({ type: 'changed', scheduleId: id });
    return updated;
  }

  async pause(id: string, opts?: { exemptRunId?: string }): Promise<Schedule> {
    return this.serializeScheduleMutation(id, () => this.pauseUnlocked(id, opts));
  }

  private async pauseUnlocked(
    id: string,
    opts?: { exemptRunId?: string },
  ): Promise<Schedule> {
    // 先中断这条 schedule 名下所有 in-flight run。pause 语义 = 立刻停 + 不再触发,
    // in-flight 跑完才算停就跟用户预期不符(且老行为还会更新 lastFinishedAt 把 schedule
    // 数据弄脏)。abort 触发后 fireOne 的 wasAborted 分支会自己把 run 标 'aborted'。
    // exemptRunId:调用方自己所在的 run(agent 在任务内 pause 自己的 schedule)不 abort,
    // 让它自然跑完 —— 语义与豁免理由见 abortInflightAndWait。
    await this.abortInflightAndWait(id, opts?.exemptRunId);
    const updated = await this.storage.update(id, { status: 'paused', updatedAt: this.clock.now() });
    if (!updated) throw new Error(`Schedule not found: ${id}`);
    this.activeSchedules.delete(id);
    this.emitEvent({ type: 'changed', scheduleId: id });
    return updated;
  }

  async resume(id: string): Promise<Schedule> {
    return this.serializeScheduleMutation(id, () => this.resumeUnlocked(id));
  }

  private async resumeUnlocked(id: string): Promise<Schedule> {
    const existing = await this.storage.get(id);
    if (!existing) throw new Error(`Schedule not found: ${id}`);
    const now = this.clock.now();
    // resume 视作冷启动：interval 模式起新一轮 N 倒计时；cron 模式找下一个壁钟槽位。
    const next =
      existing.intervalMs !== undefined
        ? nextIntervalFire(existing.lastFinishedAt ?? existing.createdAt, existing.intervalMs, now)
        : nextCronOrMonthlyFire(existing.cronExpr, now, existing.timezone);
    const updated = await this.storage.update(id, {
      status: 'active',
      updatedAt: now,
      nextFireAt: next,
    });
    if (!updated) throw new Error(`Schedule not found: ${id}`);
    this.activeSchedules.set(id, updated);
    this.emitEvent({ type: 'changed', scheduleId: id });
    return updated;
  }

  async delete(id: string, opts?: { exemptRunId?: string }): Promise<void> {
    return this.serializeScheduleMutation(id, () => this.deleteUnlocked(id, opts));
  }

  private async deleteUnlocked(id: string, opts?: { exemptRunId?: string }): Promise<void> {
    // 先中断 in-flight,等它们 settle,再删 schedule 行。否则被删 schedule 名下的
    // in-flight run 会继续跑到底(原行为),用户点删除后看到的是"还在跑"。
    // abort + 等待逻辑见 abortInflightAndWait。
    //
    // exemptRunId:调用方自己所在的 run 不 abort。典型场景是心跳任务收口 ——
    // agent 在任务 run 内调 schedule_delete 删除自己的 schedule,若不豁免,
    // delete 会 abort 发起删除的这轮 run 自己:turn 被强杀(收尾汇报被掐断、
    // in-flight 的 delete 工具调用被 SDK 以 rejection 收场,尽管删除已成功)、
    // run 被记 aborted 而非 success。豁免后该 run 自然跑完;它的 run 行随
    // schedule 级联删除,结束时 updateRun 落在已删行上是 no-op(storage 容错),
    // fireOne 尾部对 schedule 行的重排 update 同样 no-op —— 均无副作用。
    await this.abortInflightAndWait(id, opts?.exemptRunId);
    await this.storage.delete(id);
    this.activeSchedules.delete(id);
    this.emitEvent({ type: 'changed', scheduleId: id });
  }

  /** 按 schedule id 串行执行 CRUD，并在队尾完成后释放对应条目。 */
  private async serializeScheduleMutation<T>(id: string, mutation: () => Promise<T>): Promise<T> {
    const previous = this.scheduleMutationTails.get(id) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.scheduleMutationTails.set(id, tail);

    await previous;
    try {
      return await mutation();
    } finally {
      release();
      if (this.scheduleMutationTails.get(id) === tail) {
        this.scheduleMutationTails.delete(id);
      }
    }
  }

  /**
   * 返回当前实例的瞬时执行/排队快照。用于 renderer 首次加载补快照和运行期诊断，
   * 不查 DB、不修改调度状态。
   */
  getRuntimeSnapshot(): SchedulerRuntimeSnapshot {
    return {
      schedulerInstanceId: this.schedulerInstanceId,
      ...(this.processId !== undefined ? { processId: this.processId } : {}),
      inFlight: this.inflightAttempts.size,
      maxConcurrentRuns: this.maxConcurrentRuns,
      inFlightRuns: [...this.inflightAttempts.values()].map((attempt) => ({
        scheduleId: attempt.scheduleId,
        scheduleName: attempt.scheduleName,
        runId: attempt.runId,
        source: attempt.source,
        executionMode: attempt.executionMode,
        startedAt: attempt.startedAt,
        slotWaitMs: attempt.slotWaitMs,
        phase: attempt.phase,
      })),
      waitingSchedules: [...this.waitingSchedules.values()].map((waiting) => ({ ...waiting })),
    };
  }

  /**
   * 返回该 schedule 当前有多少个 in-flight run(被 runner.fire 正在执行的)。
   * UI 在 delete/pause 前用它决定是否弹"有 N 次执行正在进行"二次确认。
   * 无 in-flight → 0(包括 schedule 已 paused / expired / 不存在的情况)。
   */
  getInflightCount(id: string): number {
    return this.inflightByschedule.get(id)?.size ?? 0;
  }

  /**
   * 把**指定的单条 in-flight run** 标记为"静默":任务内 agent 确认本轮无需用户
   * 关注(如 PR 巡检无新动态)时,经 MCP 工具传自己这一轮的 runId 调用本方法。
   * 静默的 run 在 success 落库时直接置 readAt(生而已读,小红点天然排除),且
   * runner 会跳过完成通知。失败/中止路径忽略静默标记(fail-safe:异常必须可见)。
   *
   * 只标该 runId 一条 —— 同一 schedule 若有多个 run 并发在跑(如定时 fire 撞上
   * runNow),静默一个不会误伤另一个。runId 必须当前在 in-flight,否则返回 false
   * (调用方据此报 NOT_FOUND:静默只能在该 run 执行中调)。标记只存内存:进程重启
   * 丢失 → 通知照发,安全方向正确。
   */
  silenceRun(runId: string): boolean {
    if (!this.inflightControllers.has(runId)) return false;
    const scheduleId = this.findInflightScheduleId(runId);
    if (!scheduleId) return false;
    this.silencedRuns.add(runId);
    const sessionId = this.runIdToSessionId.get(runId) ?? this.runIdToBoundSessionId.get(runId);
    if (sessionId) this.emitEvent({ type: 'silenced', scheduleId, runId, sessionId });
    return true;
  }

  /**
   * 静默运行中的单条 in-flight run 主动请求提醒用户。成功后该 run 恢复普通
   * completion 路径:success 不再自动置 readAt,runner 会按通知渠道提醒。
   */
  notifyRun(runId: string): boolean {
    if (!this.inflightControllers.has(runId)) return false;
    const scheduleId = this.findInflightScheduleId(runId);
    if (!scheduleId) return false;
    this.silencedRuns.delete(runId);
    const sessionId = this.runIdToSessionId.get(runId) ?? this.runIdToBoundSessionId.get(runId);
    if (sessionId) this.emitEvent({ type: 'notified', scheduleId, runId, sessionId });
    return true;
  }

  /** run 是否被标记静默(runner 在完成通知前查询)。 */
  isRunSilenced(runId: string): boolean {
    return this.silencedRuns.has(runId);
  }

  /**
   * 运行期僵尸清扫:把心跳过期的 'running' 行改写 interrupted,恢复崩溃认领悬置
   * 的排期,并按 schedule 广播 'changed'。清扫窗口受 sweepBlockedUntil 节制
   * (启动暖场 + 挂起唤醒宽限);本进程 in-flight run 无条件排除。
   * tick 的 DB-sync 块内周期调用。
   */
  private async sweepStaleRunningRuns(now: number): Promise<void> {
    if (now < this.sweepBlockedUntil) return;
    try {
      // 带心跳的行按心跳窗口(60s)判僵尸;NULL 心跳行(老版本实例写入,活着也不会
      // 续心跳)单独用宽得多的 RUN_LEGACY_STALE_MS 按 firedAt 判 —— 既不把跨版本
      // 双开时对方正在跑的 run 秒杀,也不让老版本崩溃残留永久卡死 busy probe
      // (codex review P2:一刀切跳过 NULL 行会让启动时未过期的残留永远无人收)。
      const affected = await this.storage.markRunningAsInterrupted(
        now - RUN_HEARTBEAT_STALE_MS,
        [...this.inflightControllers.keys()],
        { legacyStaleBefore: now - RUN_LEGACY_STALE_MS },
      );
      if (affected.length === 0) return;
      this.logger?.info?.(
        `scheduler: swept ${affected.length} stale running run(s) as interrupted`,
      );
      for (const scheduleId of new Set(affected)) {
        // 先恢复排期再广播,让 UI 一次刷新就读到最终状态。
        await this.rescheduleAfterSweep(scheduleId, now);
        this.emitEvent({ type: 'changed', scheduleId });
      }
    } catch (err) {
      this.logger?.warn?.('scheduler: stale running-run sweep failed', err);
    }
  }

  /**
   * 清扫善后:被清扫 run 若是另一实例经 claimDueFire 认领后崩溃留下的,该 schedule
   * 的 nextFireAt 已被认领置空且永远等不到 fireOne 收口时的重排 —— 不补排的话,
   * 本实例的 DB 同步会一直重灌回这条"active 但无排期"的 schedule,due 循环永远
   * 跳过它,任务无声停摆直到某个实例重启(start() 归一)。这里按 start() 同款
   * 语义就地补排(codex review P1)。
   */
  private async rescheduleAfterSweep(scheduleId: string, now: number): Promise<void> {
    try {
      const schedule = await this.storage.get(scheduleId);
      if (!schedule || schedule.status !== 'active') return;
      // nextFireAt 仍在 = 悬置的不是认领(如 runNow 僵尸),排期没坏,不动。
      if (schedule.nextFireAt !== undefined) return;
      // 该 schedule 仍有 running 行(如清的是 runNow 僵尸、cron 认领正被另一活
      // 实例执行)→ 不抢排,等执行方 fireOne 收口时按 recurring 语义重排。
      // 必须用无上限的状态查询:listRuns 带展示上限,活跃 claim run 被更新的
      // runNow/终态行挤出窗口会漏判并误补排(codex review P2)。
      if (await this.storage.hasRunningRuns(scheduleId)) return;
      // manual / 已消耗的一次性任务 computeNextFireAt 返回 undefined → 与 start()
      // 归一同款:保持无排期,不强行续命。
      const next = computeNextFireAt(schedule, now);
      if (next === undefined) return;
      const updated = await this.storage.update(scheduleId, { nextFireAt: next });
      // 内存副本同步跟上,不等下一轮 30s DB 同步。
      if (updated && updated.status === 'active') {
        this.activeSchedules.set(scheduleId, updated);
      }
      this.logger?.info?.('scheduler: rescheduled orphaned claim after sweep', {
        scheduleId,
        nextFireAt: next,
      });
    } catch (err) {
      // 补排失败不阻塞其余 schedule 的清扫善后;下一轮清扫/任一实例重启仍会兜底。
      this.logger?.warn?.('scheduler: reschedule after sweep failed', { scheduleId, error: String(err) });
    }
  }

  /**
   * inflight registry 非空期间维持心跳续期定时器。挂在 register/unregister 上而
   * 不是 tick:passive 实例不 tick,但 runNow 的手动触发同样需要续租,否则会被
   * 对面活跃实例的清扫误判成僵尸。
   */
  private startHeartbeatLoopIfNeeded(): void {
    if (this.heartbeatHandle !== null) return;
    this.heartbeatHandle = setInterval(() => {
      const runIds = [...this.inflightControllers.keys()];
      const now = this.clock.now();
      this.logLongRunningAttempts(now);
      if (runIds.length > 0) {
        void this.storage.touchRunHeartbeats(runIds, now).catch((err) => {
          this.logger?.warn?.('scheduler: touchRunHeartbeats failed', err);
        });
      }
    }, RUN_HEARTBEAT_INTERVAL_MS);
    // 不让心跳定时器拖住进程退出(Electron main 常驻无感,vitest / CLI 宿主有感)。
    (this.heartbeatHandle as unknown as { unref?: () => void }).unref?.();
  }

  private stopHeartbeatLoopIfIdle(): void {
    if (this.inflightAttempts.size === 0 && this.heartbeatHandle !== null) {
      clearInterval(this.heartbeatHandle);
      this.heartbeatHandle = null;
    }
  }

  /** 在第一次 await 前同步登记一次槽位占用，并输出可配对的注册日志。 */
  private beginInflightAttempt(input: Omit<SchedulerInflightRun, 'startedAt'>): void {
    if (this.inflightAttempts.has(input.runId)) {
      throw new Error(`duplicate scheduler run id: ${input.runId}`);
    }
    const before = this.inflightAttempts.size;
    const attempt: InflightAttempt = { ...input, startedAt: this.clock.now() };
    this.inflightAttempts.set(input.runId, attempt);
    this.startHeartbeatLoopIfNeeded();
    this.logger?.info?.('scheduler: in-flight run registered', {
      schedulerInstanceId: this.schedulerInstanceId,
      processId: this.processId,
      ...this.describeInflightRun(attempt, attempt.startedAt),
      inFlightBefore: before,
      inFlightAfter: this.inflightAttempts.size,
      maxConcurrentRuns: this.maxConcurrentRuns,
    });
    this.emitRuntimeState();
  }

  /** 推进诊断阶段；runNow 在读到 schedule 后也通过这里补齐名称与 runner 类型。 */
  private updateInflightAttempt(
    runId: string,
    phase: ScheduleRunPhase,
    schedule?: Schedule,
  ): void {
    const current = this.inflightAttempts.get(runId);
    if (!current) return;
    current.phase = phase;
    if (schedule) {
      current.scheduleName = schedule.name;
      current.executionMode = schedule.executionMode ?? 'agent';
    }
  }

  /** finally 配对释放；stop() 已统一清空时，迟到的 finally 保持幂等 no-op。 */
  private finishInflightAttempt(runId: string): void {
    const attempt = this.inflightAttempts.get(runId);
    if (!attempt) return;
    const before = this.inflightAttempts.size;
    this.inflightAttempts.delete(runId);
    const now = this.clock.now();
    this.logger?.info?.('scheduler: in-flight run released', {
      schedulerInstanceId: this.schedulerInstanceId,
      processId: this.processId,
      ...this.describeInflightRun(attempt, now),
      inFlightBefore: before,
      inFlightAfter: this.inflightAttempts.size,
      maxConcurrentRuns: this.maxConcurrentRuns,
    });
    this.stopHeartbeatLoopIfIdle();
    this.emitRuntimeState();
  }

  /** 同步真实被并发闸门扣住的任务集合；无变化时不重复广播。 */
  private syncWaitingSchedules(schedules: Schedule[]): void {
    const next = new Map<string, SchedulerWaitingSchedule>();
    const now = this.clock.now();
    for (const schedule of schedules) {
      next.set(schedule.id, {
        scheduleId: schedule.id,
        scheduleName: schedule.name,
        waitingSince: schedule.nextFireAt ?? now,
      });
    }
    const unchanged =
      next.size === this.waitingSchedules.size &&
      [...next].every(([id, value]) => {
        const previous = this.waitingSchedules.get(id);
        return (
          previous?.scheduleName === value.scheduleName &&
          previous.waitingSince === value.waitingSince
        );
      });
    if (unchanged) return;
    this.waitingSchedules.clear();
    for (const [id, value] of next) this.waitingSchedules.set(id, value);
    this.emitRuntimeState();
  }

  /** 心跳周期内对超长执行输出节流诊断，即使当前没有其它任务排队也能被发现。 */
  private logLongRunningAttempts(now: number): void {
    const due: InflightRunDiagnostic[] = [];
    for (const attempt of this.inflightAttempts.values()) {
      const durationMs = Math.max(0, now - attempt.startedAt);
      if (durationMs < LONG_RUNNING_DIAGNOSTIC_MS) continue;
      if (
        attempt.lastLongRunningLogAt !== undefined &&
        now - attempt.lastLongRunningLogAt < LONG_RUNNING_DIAGNOSTIC_MS
      ) {
        continue;
      }
      attempt.lastLongRunningLogAt = now;
      due.push(this.describeInflightRun(attempt, now));
    }
    if (due.length === 0) return;
    this.logger?.warn?.('scheduler: long-running in-flight runs detected', {
      schedulerInstanceId: this.schedulerInstanceId,
      processId: this.processId,
      thresholdMs: LONG_RUNNING_DIAGNOSTIC_MS,
      runs: due,
    });
  }

  private describeInflightRun(
    attempt: SchedulerInflightRun,
    now: number,
  ): InflightRunDiagnostic {
    return {
      scheduleId: attempt.scheduleId,
      scheduleName: attempt.scheduleName,
      runId: attempt.runId,
      source: attempt.source,
      executionMode: attempt.executionMode,
      phase: attempt.phase,
      startedAt: attempt.startedAt,
      slotWaitMs: attempt.slotWaitMs,
      durationMs: Math.max(0, now - attempt.startedAt),
    };
  }

  private describeInflightRuns(now: number): InflightRunDiagnostic[] {
    return [...this.inflightAttempts.values()].map((attempt) =>
      this.describeInflightRun(attempt, now),
    );
  }

  private emitRuntimeState(): void {
    this.emitEvent({ type: 'runtime-state', snapshot: this.getRuntimeSnapshot() });
  }

  /**
   * 一次 fire 是否属于"被 delete/pause 主动中断"(fireOne/runNow 共用判定)。
   * controller.signal.aborted 是 source of truth;runError 文本里的 'abort' 只是
   * **agent 模式**的兜底(runner 没接 signal 但 Session.abort 已经触发了——agent
   * 侧错误文本由我们自己产生,可控)。script 模式**绝不做文本匹配**:script
   * runner 第一方接了 signal(真 abort 时 signal 必已置位),而它的失败消息携带
   * 脚本自己的 stderr,任意文本(如 "operation aborted by remote server")都可能
   * 撞上 /abort/i——误判成 aborted 会走"不重排 nextFireAt"的分支,而 claimDueFire
   * 已把 nextFireAt 清空,recurring 任务就此静默停摆到重启(codex review #966)。
   */
  private wasRunAborted(schedule: Schedule, signal: AbortSignal, runError: string | undefined): boolean {
    if (signal.aborted) return true;
    if ((schedule.executionMode ?? 'agent') === 'script') return false;
    return runError !== undefined && /abort/i.test(runError);
  }

  /** 注册一次 fire 的 controller(fireOne/runNow 顶部调用)。两个 map 都要写。 */
  private registerInflight(scheduleId: string, runId: string, controller: AbortController): void {
    this.inflightControllers.set(runId, controller);
    let set = this.inflightByschedule.get(scheduleId);
    if (!set) {
      set = new Set();
      this.inflightByschedule.set(scheduleId, set);
    }
    set.add(runId);
    this.startHeartbeatLoopIfNeeded();
  }

  /** 清理一次 fire 的 controller(fireOne/runNow 的 finally 调用,确保不泄漏)。 */
  private unregisterInflight(scheduleId: string, runId: string): void {
    this.inflightControllers.delete(runId);
    const set = this.inflightByschedule.get(scheduleId);
    if (set) {
      set.delete(runId);
      if (set.size === 0) this.inflightByschedule.delete(scheduleId);
    }
    // 同步清反向映射:仅当 sessionId 当前仍指向本 runId 才删正向条目
    // (heartbeat 同 sessionId 已被后一轮覆盖时不能误删新 run 的映射)。
    const sessionId = this.runIdToSessionId.get(runId);
    if (sessionId !== undefined) {
      if (this.sessionIdToRunId.get(sessionId) === runId) {
        this.sessionIdToRunId.delete(sessionId);
      }
      this.runIdToSessionId.delete(runId);
    }
    this.runIdToBoundSessionId.delete(runId);
    this.stopHeartbeatLoopIfIdle();
  }

  /**
   * 按调用方 session 解析其当前 in-flight 的 runId。MCP 静默工具用它把"静默本轮"
   * 落到具体 run —— agent 无需(也无法)传 runId,从根上消除传参漂移,并天然只能
   * 命中调用方自己 session 的 run(caller-ownership)。无 in-flight run 时返回 undefined。
   */
  resolveInflightRunForSession(sessionId: string): string | undefined {
    return this.sessionIdToRunId.get(sessionId);
  }

  /**
   * 中断该 schedule 名下所有 in-flight run,polling 等它们 settle(map 清空)。
   * 5s 超时兜底 —— 极端情况下 runner 不响应 abort 也不能让 delete/pause 永远卡死;
   * 超时后 schedule 该删/该停继续走,fireOne 后续 storage.update 找不到 schedule
   * 是 no-op(schedule 行已删)或更新到 paused 行(无害,wasAborted 短路了重排)。
   *
   * exemptRunId(caller-ownership 豁免):delete/pause 请求来自该 schedule 自己的
   * 任务 run 内部时(agent 收口场景,经 MCP 层用 resolveInflightRunForSession 解析),
   * 这条 run 不 abort 也不等待 —— abort 它等于让删除动作自杀:发起方 turn 被强杀,
   * 等待它则互相死锁(run 等 delete 返回,delete 等 run settle,只能靠 5s 超时脱困)。
   * 传入的 exemptRunId 若不属于本 schedule 的 in-flight set,filter 不命中,天然无影响。
   */
  private async abortInflightAndWait(scheduleId: string, exemptRunId?: string): Promise<void> {
    const set = this.inflightByschedule.get(scheduleId);
    if (!set || set.size === 0) return;
    // 复制 runIds 防迭代中 set 被 fireOne finally 改写。
    const runIds = Array.from(set).filter((runId) => runId !== exemptRunId);
    if (runIds.length === 0) return;
    for (const runId of runIds) {
      this.inflightControllers.get(runId)?.abort();
    }
    // 等待条件同样排除豁免 run:它要等本次 delete/pause 返回后才会结束,算上它
    // 必然把 5s 超时耗满。
    const pendingCount = (): number => {
      const current = this.inflightByschedule.get(scheduleId);
      if (!current) return 0;
      let n = 0;
      for (const runId of current) {
        if (runId !== exemptRunId) n += 1;
      }
      return n;
    };
    const deadline = this.clock.now() + 5000;
    while (pendingCount() > 0 && this.clock.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const remaining = pendingCount();
    if (remaining > 0) {
      this.logger?.warn?.(
        `scheduler: abortInflightAndWait timed out, ${remaining} run(s) still in-flight for schedule ${scheduleId}`,
      );
    }
  }

  // ---------- typed event API ----------

  on(event: 'fired', listener: (e: Extract<SchedulerEvent, { type: 'fired' }>) => void): this;
  on(event: 'completed', listener: (e: Extract<SchedulerEvent, { type: 'completed' }>) => void): this;
  on(event: 'failed', listener: (e: Extract<SchedulerEvent, { type: 'failed' }>) => void): this;
  on(event: 'silenced', listener: (e: Extract<SchedulerEvent, { type: 'silenced' }>) => void): this;
  on(event: 'notified', listener: (e: Extract<SchedulerEvent, { type: 'notified' }>) => void): this;
  on(event: 'deferred', listener: (e: Extract<SchedulerEvent, { type: 'deferred' }>) => void): this;
  on(event: 'skipped', listener: (e: Extract<SchedulerEvent, { type: 'skipped' }>) => void): this;
  on(event: 'session-bound', listener: (e: Extract<SchedulerEvent, { type: 'session-bound' }>) => void): this;
  on(event: 'changed', listener: (e: Extract<SchedulerEvent, { type: 'changed' }>) => void): this;
  on(event: 'runtime-state', listener: (e: Extract<SchedulerEvent, { type: 'runtime-state' }>) => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  private emitEvent(e: SchedulerEvent): void {
    this.emit(e.type, e);
  }

  private findInflightScheduleId(runId: string): string | undefined {
    for (const [scheduleId, runIds] of this.inflightByschedule) {
      if (runIds.has(runId)) return scheduleId;
    }
    return undefined;
  }

  /**
   * 构造一个传给 runner 的 onSessionBound 回调：拿到 sessionId 后立刻 UPDATE
   * schedule_runs.sessionId + emit 'session-bound' 事件，让 UI 在 run 还在 running
   * 状态时就能拿到 sessionId（"Open session" 按钮即时可用，不必等 completion）。
   *
   * 内部 try/catch 兜底，存储/广播失败只 warn，不向 runner 传染异常。
   */
  /**
   * 构造 createChildRun 回调：多 session runner 为每个子任务
   * 创建独立 run 记录。每条 child run 拥有独立 sessionId，UI 各自显示 "Open session"。
   */
  private buildCreateChildRun(scheduleId: string, firedAt: number): (input: ChildRunInput) => Promise<string> {
    return async (input: ChildRunInput) => {
      const childRunId = this.generateId();
      const childRun: ScheduleRun = {
        id: childRunId,
        scheduleId,
        sessionId: input.sessionId,
        firedAt,
        finishedAt: this.clock.now(),
        status: input.status,
        costAttribution: input.status === 'skipped' ? 'zero' : 'unavailable',
        resultText: input.resultText,
        errorMsg: input.errorMsg,
      };
      await this.storage.insertRun(childRun);
      if (input.sessionId) {
        this.emitEvent({ type: 'session-bound', scheduleId, runId: childRunId, sessionId: input.sessionId });
      }
      this.emitEvent({ type: 'completed', scheduleId, runId: childRunId, sessionId: input.sessionId ?? '' });
      return childRunId;
    };
  }

  private buildOnSessionBound(scheduleId: string, runId: string): (sessionId: string) => Promise<void> {
    return async (sessionId: string) => {
      if (!sessionId) return;
      try {
        this.runIdToBoundSessionId.set(runId, sessionId);
        await this.storage.updateRun(runId, { sessionId });
        this.emitEvent({ type: 'session-bound', scheduleId, runId, sessionId });
        if (this.silencedRuns.has(runId)) {
          this.emitEvent({ type: 'silenced', scheduleId, runId, sessionId });
        }
      } catch (err) {
        this.logger?.warn?.('updateRun(sessionId) failed', err);
      }
    };
  }

  /** 前置检查发生在 session 创建之前，结束后立即把完整结果写到当前 run。 */
  private buildOnPreRunHookCompleted(
    runId: string,
  ): (result: PreRunHookRunResult) => Promise<void> {
    return async (result: PreRunHookRunResult) => {
      try {
        await this.storage.updateRun(runId, { preRunHookResult: result });
      } catch (err) {
        // 诊断结果落库是 best-effort：短暂 BUSY / I/O 错误不能覆盖已经得到的
        // run / skip / block 业务判定，最终 run 状态仍由 fire 主流程收敛。
        this.logger?.warn?.('persist pre-run hook result failed', {
          runId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };
  }

  /**
   * 构造 onTurnActive 回调:runner 在本轮 turn **被会话接受后**调一次,这才落定
   * sessionId → 本轮 runId 的反向映射(供 resolveInflightRunForSession 解析)。
   * 刻意不在 onSessionBound(send 之前)写——见 sessionIdToRunId 声明处注释:
   * 避免同 session 重叠 run 里被拒的那个覆盖/带走活跃 run 的映射(codex review P2)。
   */
  private buildOnTurnActive(runId: string): (sessionId: string) => void {
    return (sessionId: string) => {
      if (!sessionId) return;
      this.sessionIdToRunId.set(sessionId, runId);
      this.runIdToSessionId.set(runId, sessionId);
    };
  }
}

function computeNextFireAt(schedule: Schedule, fromMs: number): number | undefined {
  // manual schedule 永远不参与自动触发，跳过 cron 计算（runNow 是单独路径）
  if (schedule.manual) return undefined;
  if (!schedule.recurring && schedule.lastFiredAt !== undefined) return undefined;
  if (schedule.intervalMs !== undefined) {
    // 冷启动：基线取 lastFinishedAt（跑过）或 createdAt（没跑过），再 max(base+N, now+N)
    // —— 漏掉的不补发，重新起 N 倒计时。
    return nextIntervalFire(
      schedule.lastFinishedAt ?? schedule.createdAt,
      schedule.intervalMs,
      fromMs,
    );
  }
  return nextCronOrMonthlyFire(schedule.cronExpr, fromMs, schedule.timezone);
}

function defaultGenerateId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
