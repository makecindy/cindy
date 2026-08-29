import { EventEmitter } from 'node:events';
import type {
  Schedule,
  ScheduleRun,
  CreateScheduleInput,
  UpdateScheduleInput,
  ListFilter,
  SchedulerEvent,
  ScheduleFireSource,
  SchedulerInflightRun,
  SchedulerInflightRunPolicy,
  SchedulerRuntimeSnapshot,
  SchedulerWaitingSchedule,
  ScheduleRunPhase,
  ScriptCapability,
  ScriptExecutionConfig,
  PreRunHookRunResult,
} from '../types.js';
import { SCRIPT_CAPABILITIES } from '../types.js';
import { isLegalPhaseTransition } from './attemptLifecycle.js';
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
   * Host-owned validation for a persisted bound-session target. The scheduler
   * calls it before CRUD persistence and again immediately before every fire,
   * so a row restored from an older process cannot bypass a newer host policy.
   */
  validateTargetSession?: (
    targetSessionId: string,
    operation: 'create' | 'update' | 'fire',
  ) => Promise<void>;
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
  /**
   * 卡死判定阈值:一条占槽的 run 连续这么久没有任何进展信号(见
   * FireContext.onProgress)就被视为卡死并 abort。默认 RUN_STALL_MS。
   * 判"无反馈"而非"总时长"——真在干活的长任务持续有事件,不会被误砍。
   */
  runStallMs?: number;
  /**
   * abort 后的宽限:超过这么久 runner 仍不 settle,就强制收回槽位(见
   * forceReleaseStalledRun)。默认 RUN_STALL_ABORT_GRACE_MS。
   */
  runStallAbortGraceMs?: number;
  /**
   * 心跳间隔缺口超过它 → 判为系统挂起(合盖睡眠),把这段时间从卡死判定里剔除
   * (见 absorbSuspendGap)。默认 SUSPEND_GAP_MS;传 0 关闭。
   *
   * 测试里默认关闭:假时钟"一次跳 60 秒再跑一拍心跳"与真实的"睡了 60 秒"在壁钟上
   * 完全同形,开着会把用例想制造的静默当成睡眠吞掉。挂起行为本身由专门的用例覆盖。
   */
  suspendGapMs?: number;
  /**
   * **强制释放路径专用**的通知出口。通知投递平时住在 host 的两个 runner 里(它们各自
   * 持有 Notifier),但 runner 永不返回时那条链路根本不会执行 —— 用户配了 desktop /
   * feishu 通知也只会看到一个未读红点(review #944 P1)。
   *
   * 只在 forceReleaseStalledRun 里调用。守卫 abort 被 runner 老实响应的那条路径**不**
   * 走这里:那时 runner 已经 settle 并自己投过通知,引擎再投一次就是重复推送
   * (review #944 第二轮)。
   *
   * 由 host 注入,内部自行处理失败;引擎 fire-and-forget 调用,绝不因通知失败影响收口。
   */
  notifyForcedFailure?: (input: {
    scheduleId: string;
    runId: string;
    errorMsg: string;
  }) => Promise<void> | void;
  /** 宿主注入的 Scheduler 实例标识，用于区分同机多实例日志。 */
  instanceId?: string;
  /** 可选宿主进程标识；package 本身不读取 process，保持运行环境解耦。 */
  processId?: number;
}

const DEFAULT_TICK_MS = 1_000;

/**
 * maxConcurrentRuns 缺省值。内部常量,宿主可经 SchedulerOptions 覆盖,不进用户设置。
 *
 * 历史:原为 4,是 2026-07-07 凌晨 OOM 后的应急闸门。那次崩溃的真因是**一夜累积
 * 186 个未关闭会话句柄**(见 desktop runner 的 ephemeral 会话收尾注释),泄漏已由
 * run 终态 closeSession 修掉,上限却一直没随根因修复重新评估。2026-07-29 排队心跳
 * 占满全部 4 个槽导致整体停摆 3.5 小时后一并调整:纯等待不再占槽(见
 * ScheduleRunPhase 的 'queued'),同时把上限提到 8 —— 槽位现在只被真正在执行的
 * run 占用,4 个显著偏紧。
 */
export const DEFAULT_MAX_CONCURRENT_RUNS = 8;

/** 并发闸门「有任务在排队」日志的节流间隔 —— tick 每秒一次,不节流会刷屏。 */
const GATE_LOG_THROTTLE_MS = 30_000;

/** 单条执行超过该时长后输出周期性长跑诊断。 */
const LONG_RUNNING_DIAGNOSTIC_MS = 10 * 60_000;

/**
 * 卡死判定阈值(缺省):占槽的 run 连续这么久收不到任何进展信号即视为卡死。
 *
 * 为什么是 60min —— 分层不抢跑。卡死自愈按内到外分四层,每层阈值都大于内层,
 * 保证内层先有机会自愈:
 *   1. cc 子进程原生 stream watchdog(300s):网络层断流,透明降级恢复。
 *   2. agent 层上游静默 watchdog(30min):球在上游却一个字都不吐 → interrupt turn。
 *   3. Session 层 turn 零事件看门狗(45min):兜工具自己 hang / stdio 通道 wedge。
 *   4. **本层(60min)**:兜上面全部失灵、runner.fire 永不返回的情形,以及压根没进
 *      turn 的阶段(会话创建、凭证锁、workspace 分配)——那些阶段 2/3 层都不在计时。
 * 判据是"无进展"而非"总时长":真在干活的长任务持续有事件,不会被误砍。
 */
export const RUN_STALL_MS = 60 * 60_000;

/**
 * abort 之后的宽限(缺省)。超过它 runner 仍不 settle,就不再等它 —— 强制把槽位
 * 收回、run 落终态。abort 本身只是"请求停止",runner 不接信号或底层卡死时它不会
 * 生效;既有 abortInflightAndWait 也只等 5s。槽位释放不能依赖对方配合,否则一条
 * 卡死的 run 就能永久吃掉一格调度能力。
 */
export const RUN_STALL_ABORT_GRACE_MS = 60_000;

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
/**
 * 排期补偿只需要这四项。单独抽出来是为了让"补排失败后的重试凭据"能纯内存留存:
 * 整个 InflightAttempt 在收口时就被删了,而重试要在之后的 tick 里发生
 * (见 pendingReplans / retryPendingReplans,review #944 第十八轮 P1)。
 */
interface StalledClaimPlan {
  scheduleId: string;
  runId: string;
  startedAt: number;
  source: ScheduleFireSource;
}

interface InflightAttempt extends SchedulerInflightRun {
  lastLongRunningLogAt?: number;
  /** 卡死判定命中并已发出 abort 的时刻；用于计算强制收回槽位的宽限。 */
  stallAbortedAt?: number;
  /**
   * 本轮的 AbortController 是否已注册过（registerInflight 跑过）。
   *
   * attempt 在第一次 await 前就登记，而 controller 只在 run 行插入之后注册，两者之间
   * 有一段前置窗口（claimDueFire / insertRun / runNow 的 storage.get）。缺了这个标记
   * 就无法区分「controller 从未注册」和「runner 已 settle、finally 已摘掉 controller」
   * —— 卡死守卫据此做过相反的处置，见 enforceStallGuard（review #944 第五轮 P1）。
   */
  controllerRegistered?: boolean;
  /** 存储卡死告警的上次输出时刻；节流用（心跳每 15s 会重入判定）。 */
  storageStallLoggedAt?: number;
  /**
   * 进入 'finalizing' 的时刻。终态落库卡死从这里起算，而不是从最后一次进展信号：
   * 守卫 abort 生效的正常路径下 lastProgressAt 已经旧了整个 runStallMs，用它判定会在
   * 落库刚开始的那一刻就误报卡死。
   */
  finalizingSince?: number;
  /** runner 已经投过一条**失败**通知；守卫收口时据此决定是否补发。见 onRunnerNotified。 */
  runnerNotifiedFailure?: boolean;
  /**
   * 强制收口已认领这条 attempt 的清理权。置位期间 finishInflightAttempt 一律让位 ——
   * 只有 forceReleaseStalledRun 的 finally 能删它（review #944 第十三轮 P1）。
   */
  forceReleaseOwnsCleanup?: boolean;
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
  // 卡死守卫的挂起唤醒防误杀:上次心跳时刻(见 absorbSuspendGap)。
  private lastHeartbeatAt = 0;

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

  private readonly notifyForcedFailureHook?: SchedulerOptions['notifyForcedFailure'];
  private readonly isManagedWorkspaceDir?: (dir: string) => boolean;
  private readonly validateTargetSession?: SchedulerOptions['validateTargetSession'];
  private readonly passive: boolean;
  private lastDbSyncAt = 0;

  // ── 并发闸门状态 ──────────────────────────────────────────────────────────
  // fireOne / runNow 包装层在第一次 await 前同步写入 attempts，tick 直接读取 Map.size。
  // 这样既保留原计数的无超发窗口，又让每个占用都能追溯到具体 run/source/phase。
  private readonly maxConcurrentRuns: number;
  private readonly runStallMs: number;
  private readonly runStallAbortGraceMs: number;
  private readonly suspendGapMs: number;
  private readonly schedulerInstanceId: string;
  private readonly processId?: number;
  private readonly inflightAttempts = new Map<string, InflightAttempt>();
  private readonly waitingSchedules = new Map<string, SchedulerWaitingSchedule>();
  private lastGateLogAt = 0;
  /**
   * 已被卡死守卫强制收口的 runId。这些 run 的槽位已收回、run 行已落终态、schedule
   * 已重排 —— 若 runner 事后才 settle(可能几小时后),它的终态落库与事件广播必须整体
   * 跳过,否则会把用户已经看到的 failed 覆写回 success、并二次重排 nextFireAt。
   * 只存内存:进程重启后这些 run 行已是终态,不需要再记。
   */
  private readonly abandonedRuns = new Set<string>();
  /**
   * 排期补偿失败待重试的 schedule（key = scheduleId）。存储瞬时错误不能让一条活跃的
   * recurring 任务停摆到进程重启 —— 周期 DB sync 只重灌行、不会补 nextFireAt，僵尸清扫
   * 也只看 'running' 的 run 行（第十八轮 P1）。每个 tick 就地重试，成功即摘除。
   * 只存内存：真到了重启，start() 的归一本来就会补上。
   */
  private readonly pendingReplans = new Map<string, StalledClaimPlan>();
  /**
   * 严格 cron 解析上线前可能落库的畸形 active 任务。清空 nextFireAt 若遇到存储故障，
   * 周期 DB 同步仍会读回旧的到期时间；在用户修正表达式前必须持续把它们隔离在内存里。
   */
  private readonly invalidScheduleIds = new Set<string>();

  constructor(opts: SchedulerOptions) {
    super();
    this.storage = opts.storage;
    this.runner = opts.runner;
    this.clock = opts.clock ?? { now: () => Date.now() };
    this.logger = opts.logger;
    this.tickIntervalMs = opts.tickIntervalMs ?? DEFAULT_TICK_MS;
    this.generateId = opts.generateId ?? defaultGenerateId;
    this.isManagedWorkspaceDir = opts.isManagedWorkspaceDir;
    this.validateTargetSession = opts.validateTargetSession;
    this.notifyForcedFailureHook = opts.notifyForcedFailure;
    this.passive = opts.passive ?? false;
    this.maxConcurrentRuns = Math.max(1, opts.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT_RUNS);
    // 0 / 负值 = 关闭卡死守卫(逃生阀:守卫误伤时宿主可一键停掉,不必回滚版本)。
    this.runStallMs = opts.runStallMs ?? RUN_STALL_MS;
    this.runStallAbortGraceMs = Math.max(
      0,
      opts.runStallAbortGraceMs ?? RUN_STALL_ABORT_GRACE_MS,
    );
    this.suspendGapMs = Math.max(0, opts.suspendGapMs ?? SUSPEND_GAP_MS);
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
    // 隔离名单只描述本次运行周期里看到的存量坏记录。stop() 后再 start()
    // 必须从持久化事实重新判定，不能把已删除或已修正任务的 id 带进新周期。
    this.invalidScheduleIds.clear();
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
      let next: number | undefined;
      try {
        next = computeNextFireAt(current, now);
        this.invalidScheduleIds.delete(current.id);
      } catch (err) {
        // 旧版本曾接受 parseInt 可部分解析的畸形 cron（例如 `5abc * * * *`）。
        // 升级后严格解析会拒绝它们，但一条存量坏记录不能让整个 scheduler 启动失败。
        // 清空旧的 nextFireAt，保留记录供用户修正；内存副本同样禁用，避免陈旧时间误触发。
        this.logger?.warn?.('scheduler: skipped invalid active schedule during startup', {
          scheduleId: current.id,
          error: String(err),
        });
        this.invalidScheduleIds.add(current.id);
        try {
          const updated = await this.storage.update(current.id, { nextFireAt: undefined });
          current = updated ?? { ...current, nextFireAt: undefined };
        } catch (clearErr) {
          current = { ...current, nextFireAt: undefined };
          this.logger?.warn?.('scheduler: failed to clear invalid schedule nextFireAt', {
            scheduleId: current.id,
            error: String(clearErr),
          });
        }
        this.activeSchedules.set(current.id, current);
        continue;
      }
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
    // abandonedRuns **刻意不清**:stop 只是发出 abort,被强制收口过的 run 的 runner
    // 可能仍在跑、几分钟后才 settle。清掉保护会让那次迟到 settle 覆写用户已看到的
    // failed 并二次重排 schedule(review #944 P1)。集合只存 runId,留到进程退出无成本。
    this.stopHeartbeatLoopIfIdle();
    this.sessionIdToRunId.clear();
    this.runIdToSessionId.clear();
    this.runIdToBoundSessionId.clear();
    // silencedRuns 与上面同为 runId 键控登记,必须随 stop 一起清:留着会让重启后
    // 第一次 begin 的不变量断言把它当悬挂登记抛错(codex review P1)。语义上也与
    // silenceRun 文档一致 —— 标记丢失的安全方向就是照常通知。
    this.silencedRuns.clear();
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
        const previousSchedules = new Map(this.activeSchedules);
        this.activeSchedules.clear();
        const activeIds = new Set(actives.map((sch) => sch.id));
        for (const scheduleId of this.invalidScheduleIds) {
          if (!activeIds.has(scheduleId)) this.invalidScheduleIds.delete(scheduleId);
        }
        for (const sch of actives) {
          const previous = previousSchedules.get(sch.id);
          const cadenceChanged =
            !previous ||
            previous.cronExpr !== sch.cronExpr ||
            previous.timezone !== sch.timezone ||
            previous.intervalMs !== sch.intervalMs ||
            previous.manual !== sch.manual;
          const current = this.keepInvalidScheduleQuarantined(sch, now, cadenceChanged);
          this.activeSchedules.set(current.id, current);
        }
      } catch (err) {
        this.logger?.warn?.('scheduler: active-schedule DB sync failed', err);
      }
      // 顺路做运行期僵尸清扫:另一实例崩溃留下的 'running' 行不再等谁重启才收尾,
      // 本实例在心跳过期后就地改写 interrupted 并广播 'changed' 刷 UI。
      // excludeRunIds 兜底排除本进程 in-flight(即使自家心跳续期停摆也绝不自伤)。
      await this.sweepStaleRunningRuns(now);
    }
    // 补排重试要排在挑选 due 之前:本次刚补上的 nextFireAt 若已到期,同一个 tick 就能
    // 把它捞进 due,不必再等一整个 tick 间隔。
    await this.retryPendingReplans(now);
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
    // 闸门只数**真正占槽**的 run:'queued' 的纯等待项(心跳排在忙会话的队列里等派发)
    // 不消耗 agent 子进程 / MCP 注册 / token,让它们占配额等于让一个卡住的会话拖死
    // 整个调度器(见 ScheduleRunPhase 注释的 2026-07-29 事故)。
    due.sort((a, b) => (a.nextFireAt ?? 0) - (b.nextFireAt ?? 0));
    const slots = Math.max(0, this.maxConcurrentRuns - this.countSlotsInUse());
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
        slotsInUse: this.countSlotsInUse(),
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
      // The CAS protects the fire time, not the rest of the row. Another
      // instance can therefore change cron metadata while retaining the same
      // nextFireAt and still return its new row here. Validate the claimed
      // source of truth before creating a run so that 30-second cache windows
      // cannot execute a newly malformed schedule once.
      try {
        computeNextFireAt(schedule, this.clock.now());
        this.invalidScheduleIds.delete(schedule.id);
      } catch (err) {
        this.invalidScheduleIds.add(schedule.id);
        this.logger?.warn?.('scheduler: quarantined invalid schedule after due-fire claim', {
          scheduleId: schedule.id,
          error: String(err),
        });
        return;
      }
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
    // stop() 竞态守卫(codex review P1):前置 await(claimDueFire/insertRun)期间
    // stop() 会清掉 attempt,且此时还没有 controller 可 abort 本 continuation。恢复后
    // attempt 已不在账就不得再登记 controller/索引——悬挂登记会让停机后同实例的每次
    // begin 都被不变量断言拦下。放弃本轮:刚插入的 run 行与其他 stop 释放的 run 同样
    // 交给下次 start() 的僵尸清扫收敛成 interrupted,认领走崩溃恢复的既有归一路径。
    if (!this.inflightAttempts.has(runId)) {
      this.logger?.info?.('scheduler: attempt released during pre-register await (stopped); dropping fire', {
        schedulerInstanceId: this.schedulerInstanceId,
        processId: this.processId,
        runId,
        scheduleId: schedule.id,
      });
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
    // unregisterInflight 会清掉 session 映射,终态 emit 必须用 finally 之前捕获的值。
    let knownSessionId: string | undefined;
    this.updateInflightAttempt(runId, 'running');
    try {
      if (schedule.targetSessionId) {
        await this.validateTargetSession?.(schedule.targetSessionId, 'fire');
      }
      const result = await this.runner.fire(schedule, {
        runId,
        firedAt,
        signal: controller.signal,
        onSessionBound: this.buildOnSessionBound(schedule.id, runId),
        onPreRunHookCompleted: this.buildOnPreRunHookCompleted(runId),
        onTurnActive: this.buildOnTurnActive(runId),
        createChildRun: this.buildCreateChildRun(schedule.id, firedAt),
        onQueueWaitStart: this.buildOnQueueWaitStart(runId),
        endQueueWait: this.buildEndQueueWait(runId),
        onRunnerNotified: this.buildOnRunnerNotified(runId),
        onProgress: this.buildOnProgress(runId),
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
      knownSessionId = this.resolveTerminalSessionId(runId, sessionId, schedule.targetSessionId);
      this.unregisterInflight(schedule.id, runId);
      this.updateInflightAttempt(runId, 'finalizing');
    }

    // 卡死守卫已经强制收口过这条 run(槽位收回、run 落 failed、schedule 重排)。
    // 迟到的 settle 不能再写任何东西,否则会把用户已看到的失败覆写回 success
    // 并二次重排 nextFireAt。
    if (this.consumeAbandonedRun(runId)) {
      this.silencedRuns.delete(runId);
      return;
    }

    // 如果是被 delete/pause 主动 abort 的,把 run 标 'aborted' 而非 'failed' —— 让 UI
    // 用 RunHistoryCard 渲染时能区分"用户中断"和"agent 自爆"。判定见 wasRunAborted。
    const wasAborted = this.wasRunAborted(schedule, controller.signal, runError);
    // 守卫 abort 与用户 abort 的收口语义相反(见 wasStallAborted):必须在写 run 行与
    // 决定是否重排之前把两者分开。
    const stallAborted = this.wasStallAborted(runId);

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

    // 整段"写 run 行 + 广播终态"包在 try 里:任何一次 storage.updateRun 抛存储瞬时错误
    // 都不能把下面的 schedule 重排一起吞掉 —— claimDueFire 已清空 nextFireAt,异常直接
    // 冒泡会让这条活跃的 recurring 任务静默停摆到进程重启(review #944 第九轮 P1)。
    // run 行本身交给心跳过期后的僵尸清扫兜底(与 forceReleaseStalledRun 的落库失败分支
    // 同款处置),这里只保证排期一定被恢复。
    try {
      if (stallAborted) {
        // 卡死守卫中断:run 记 'failed'(异常必须可见),且下方重排照常执行。
        const errorMsg = this.describeStallAbort(runError);
        // finally 而不是顺序执行:落库抛存储瞬时错误时,控制流会直接跳到外层 catch,
        // 补发通知被整段跳过 —— 而"守卫在 setup 阶段就中断、runner 一条通知都没投过"
        // 恰恰是最需要补发的场景,用户配了桌面/飞书通知却什么都收不到(第十八轮 P1)。
        // 通知权认领与终态落库是两件独立的事,不能让前者依赖后者成功。
        try {
          await this.storage.updateRun(runId, {
            status: 'failed',
            finishedAt,
            errorMsg,
            ...(knownSessionId ? { sessionId: knownSessionId } : {}),
          });
          this.emitFailed(schedule.id, runId, errorMsg, knownSessionId);
        } finally {
          // 补发判据只看 runner 有没有真的投过**失败**通知(onRunnerNotified),不再用
          // "有没有 runError"推断:守卫的 abort 可能落在前置检查 / 会话创建这类 setup
          // await 上,runner 会在走到任何 notifier 调用之前抛错 —— 有 runError 却一条
          // 通知都没发,旧判据会静默吞掉唯一的失败提醒(review #944 第五轮 P1)。
          // runner 无错返回时它投的是**成功**通知,与本轮记为 failed 矛盾,照样要补
          // (第三轮已确立)。
          if (this.needsForcedFailureNotification(runId)) {
            void this.notifyForcedFailure(schedule.id, runId, errorMsg);
          }
        }
      } else if (wasAborted) {
        await this.storage.updateRun(runId, {
          status: 'aborted',
          finishedAt,
          errorMsg: 'cancelled by user (schedule deleted or paused)',
          // 系统/用户主动收口,不是要处理的失败;生而已读,侧栏不涂红。
          readAt: finishedAt,
          ...(knownSessionId ? { sessionId: knownSessionId } : {}),
        });
        this.emitFailed(schedule.id, runId, 'aborted', knownSessionId);
      } else if (runError !== undefined) {
        await this.storage.updateRun(runId, {
          status: 'failed',
          finishedAt,
          errorMsg: runError,
          ...(knownSessionId ? { sessionId: knownSessionId } : {}),
        });
        this.emitFailed(schedule.id, runId, runError, knownSessionId);
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
    } catch (err) {
      this.logger?.error?.(
        'scheduler: run terminal persistence failed; continuing so the schedule still gets replanned',
        {
          schedulerInstanceId: this.schedulerInstanceId,
          processId: this.processId,
          scheduleId: schedule.id,
          runId,
          error: String(err),
        },
      );
    }
    this.silencedRuns.delete(runId);

    // Aborted 路径不更新 schedule 行 —— schedule 大概率已被 delete(行已不存在,update
    // 是 no-op)或 pause(status='paused',activeSchedules 已被摘出)。重排 nextFireAt
    // 会引入幽灵下次触发,resume 时 resume() 自己会重算,这里跳过最干净。
    //
    // **例外:守卫 abort**。此时 schedule 既没被删也没被停,只是这一轮卡死了;
    // claimDueFire 已清空 nextFireAt,必须往下走重排,否则任务永久停摆(review P1)。
    if (wasAborted && !stallAborted) {
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
    // stop() 竞态守卫,与 fireOneInner 同款(codex review P1):storage.get/insertRun/
    // update 期间 stop() 清掉 attempt 后不得再登记 controller/索引。runNow 契约上
    // 以抛错收场(调用方显式动作,静默吞掉会让"没跑"看起来像"跑了")。
    if (!this.inflightAttempts.has(runId)) {
      this.logger?.info?.('scheduler: attempt released during pre-register await (stopped); dropping runNow', {
        schedulerInstanceId: this.schedulerInstanceId,
        processId: this.processId,
        runId,
        scheduleId: schedule.id,
      });
      throw new Error(`scheduler stopped while starting runNow (scheduleId=${schedule.id})`);
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

    let finishedAt = firedAt;
    let runError: string | undefined;
    let runSessionId: string | undefined;
    let runResultText: string | undefined;
    let deferred = false;
    let deferRetryMs: number | undefined;
    let skipped = false;
    // unregisterInflight 会清掉 session 映射,终态 emit 必须用 finally 之前捕获的值。
    let knownSessionId: string | undefined;
    this.updateInflightAttempt(runId, 'running');
    try {
      if (schedule.targetSessionId) {
        await this.validateTargetSession?.(schedule.targetSessionId, 'fire');
      }
      const result = await this.runner.fire(schedule, {
        runId,
        firedAt,
        signal: controller.signal,
        onSessionBound: this.buildOnSessionBound(schedule.id, runId),
        onPreRunHookCompleted: this.buildOnPreRunHookCompleted(runId),
        onTurnActive: this.buildOnTurnActive(runId),
        createChildRun: this.buildCreateChildRun(schedule.id, firedAt),
        onQueueWaitStart: this.buildOnQueueWaitStart(runId),
        endQueueWait: this.buildEndQueueWait(runId),
        onRunnerNotified: this.buildOnRunnerNotified(runId),
        onProgress: this.buildOnProgress(runId),
      });
      runSessionId = result.sessionId;
      runResultText = result.resultText;
      deferred = result.deferred ?? false;
      deferRetryMs = result.deferRetryMs;
      skipped = result.skipped ?? false;
    } catch (err) {
      runError = err instanceof Error ? err.message : String(err);
    } finally {
      knownSessionId = this.resolveTerminalSessionId(runId, runSessionId, schedule.targetSessionId);
      this.unregisterInflight(schedule.id, runId);
      this.updateInflightAttempt(runId, 'finalizing');
    }
    finishedAt = this.clock.now();

    // 语义同 fireOneInner:被卡死守卫强制收口过的 run,迟到 settle 整体丢弃。
    if (this.consumeAbandonedRun(runId)) {
      this.silencedRuns.delete(runId);
      return { runId };
    }

    const wasAborted = this.wasRunAborted(schedule, controller.signal, runError);
    const stallAborted = this.wasStallAborted(runId);

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

    if (stallAborted) {
      // 语义同 fireOneInner:守卫中断记 failed(可见)而不是 aborted(伪装成用户操作);
      // 通知按 runner 有没有真的投过失败通知补发(判据理由见 fireOneInner 同名分支)。
      const errorMsg = this.describeStallAbort(runError);
      // try/finally 的理由同 fireOneInner:落库失败不能把唯一的失败提醒一起吞掉。
      // 这里刻意不 catch —— runNow 是用户主动触发,落库失败照旧向调用方冒泡。
      try {
        await this.storage.updateRun(runId, {
          status: 'failed',
          finishedAt,
          errorMsg,
          ...(knownSessionId ? { sessionId: knownSessionId } : {}),
        });
        this.emitFailed(schedule.id, runId, errorMsg, knownSessionId);
      } finally {
        if (this.needsForcedFailureNotification(runId)) {
          void this.notifyForcedFailure(schedule.id, runId, errorMsg);
        }
      }
    } else if (wasAborted) {
      await this.storage.updateRun(runId, {
        status: 'aborted',
        finishedAt,
        errorMsg: 'cancelled by user (schedule deleted or paused)',
        readAt: finishedAt,
        ...(knownSessionId ? { sessionId: knownSessionId } : {}),
      });
      this.emitFailed(schedule.id, runId, 'aborted', knownSessionId);
    } else if (runError !== undefined) {
      await this.storage.updateRun(runId, {
        status: 'failed',
        finishedAt,
        errorMsg: runError,
        ...(knownSessionId ? { sessionId: knownSessionId } : {}),
      });
      this.emitFailed(schedule.id, runId, runError, knownSessionId);
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
    // (避免污染已删除/已暂停 schedule 的字段)。守卫 abort 例外:schedule 仍在,
    // "跑完了一次(以失败收场)"该如实反映到列表。
    if (!wasAborted || stallAborted) {
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
    // intervalMs 只决定下一次何时触发，不会让 cronExpr / timezone 变成可跳过的
    // 元数据。否则用户能先持久化一个坏表达式，等未来清掉 intervalMs 时才在调度
    // 路径报错。此处纯校验，不影响 interval 的 now + N 首次触发语义。
    nextCronOrMonthlyFire(input.cronExpr, now, input.timezone);
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
    if (schedule.targetSessionId) {
      await this.validateTargetSession?.(schedule.targetSessionId, 'create');
    }
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
    if (candidate.targetSessionId) {
      await this.validateTargetSession?.(candidate.targetSessionId, 'update');
    }
    // expired 是一次性任务已消费的终态。编辑后的配置若已经表达为“循环且非手动”，
    // 继续保留 expired 会让持久化状态与排期语义冲突：即使算出了 nextFireAt，任务也
    // 不会进入 activeSchedules，重启后 listActive() 同样加载不到。状态恢复集中在引擎
    // 层处理，让 desktop、device-link 与其它调用方共享一致行为。
    const shouldReactivateExpired =
      existing.status === 'expired' && candidate.recurring && !candidate.manual;
    if (shouldReactivateExpired) {
      updates.status = 'active';
    }
    // cronExpr 即使暂时被 intervalMs 覆盖，也会在调用方显式清除 interval 后重新
    // 成为调度依据。不能让一次 interval 模式更新把畸形 cron 持久化，留到以后才
    // 在重排或启动时爆炸；timezone 变更同样需要验证现有表达式在新时区可解析。
    const intervalKeyPresent = Object.prototype.hasOwnProperty.call(patch, 'intervalMs');
    if (
      patch.cronExpr !== undefined ||
      patch.timezone !== undefined ||
      patch.manual === false ||
      intervalKeyPresent ||
      shouldReactivateExpired
    ) {
      nextCronOrMonthlyFire(candidate.cronExpr, now, candidate.timezone);
    }
    // manual / intervalMs / cronExpr / timezone 任一变化，或 expired 恢复 active 时，
    // 都要重算 nextFireAt：
    //   - manual:true  → 强制清空 nextFireAt（不再自动 fire）
    //   - manual:false 且 触发字段变 → 按新表达式重算（intervalMs 优先于 cron）
    //   - manual:false 且 触发字段没动 → nextFireAt 保留（避免 update 副作用）
    // intervalMs 按「key 是否在场」判定而不是「值是否 undefined」：显式清空
    // （key 在、值 undefined）同样是触发字段变化，必须重算回 cron 槽位。
    const needsRecompute =
      patch.cronExpr !== undefined ||
      patch.timezone !== undefined ||
      patch.manual !== undefined ||
      intervalKeyPresent ||
      shouldReactivateExpired;
    let recomputeFromTo: { from: number | undefined; to: number | undefined } | null = null;
    if (needsRecompute) {
      // intervalMs 遵循真 partial 契约：**patch 没带 key 就不动**。
      //
      // 历史上这里曾在「patch 带 cronExpr 但没带 intervalMs」时隐式清空 intervalMs——
      // 那是 MCP 工具 schema 还不暴露 intervalMs 时代的权宜（不清的话旧 intervalMs
      // 永远获胜，改 cron 形同虚设）。intervalMs 对所有调用方开放后，这个隐式清空
      // 反过来成了静默事故源：调用方只更新 prompt + cronExpr（cadence 展示对齐的
      // 常见形态）就把 interval 任务打回 cron 槽位语义（2026-07-29 #211 心跳实测
      // 中招），所有调用方被迫记住「改 prompt 必须把 intervalMs 一起带上」。
      //
      // 现在清空只有一种表达：**显式带 key 且值为 undefined**（JSON 边界写 null，
      // 由 MCP 工具层翻译成带 key 的 undefined），与 GUI 表单「恒带 key」的既有
      // 行为一致。interval 任务只改 cronExpr 时，interval 语义保持权威（cron 仅作
      // 展示），nextFireAt 按 now + intervalMs 重新起算。仍然刻意**不做**「按形态
      // 推导 interval」：cron 就是 cron，与 create()（不推导）对称。
      const merged: Schedule = { ...existing, ...updates };
      if (merged.manual) {
        updates.nextFireAt = undefined;
      } else if (
        patch.cronExpr !== undefined ||
        patch.timezone !== undefined ||
        patch.manual === false ||
        intervalKeyPresent ||
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
      this.activeSchedules.set(id, this.keepInvalidScheduleQuarantined(updated, now));
    } else {
      this.invalidScheduleIds.delete(id);
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
    this.invalidScheduleIds.delete(id);
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
    // 与 create/update 对齐：恢复 interval 任务前也验证它保留的 cron 元数据，不能
    // 重新激活一条未来清 interval 后必坏的记录。
    nextCronOrMonthlyFire(existing.cronExpr, now, existing.timezone);
    // resume 视作冷启动：interval 模式起新一轮 N 倒计时（从 now 起算，与 update() 一致）；
    // cron 模式找下一个壁钟槽位。不要复用 nextIntervalFire —— 它按 lastFinishedAt+N 尊重原
    // 节奏（restart 语义），会让「上次完成不到一个 N 就 resume」比冷启动更早触发。
    const next =
      existing.intervalMs !== undefined
        ? now + existing.intervalMs
        : nextCronOrMonthlyFire(existing.cronExpr, now, existing.timezone);
    const updated = await this.storage.update(id, {
      status: 'active',
      updatedAt: now,
      nextFireAt: next,
    });
    if (!updated) throw new Error(`Schedule not found: ${id}`);
    this.invalidScheduleIds.delete(id);
    this.activeSchedules.set(id, updated);
    this.emitEvent({ type: 'changed', scheduleId: id });
    return updated;
  }

  async delete(id: string, opts?: { exemptRunId?: string }): Promise<void> {
    return this.serializeScheduleMutation(id, () => this.deleteUnlocked(id, opts));
  }

  private keepInvalidScheduleQuarantined(
    schedule: Schedule,
    now: number,
    validate = false,
  ): Schedule {
    const wasKnownInvalid = this.invalidScheduleIds.has(schedule.id);
    if (!validate && !wasKnownInvalid) return schedule;
    try {
      computeNextFireAt(schedule, now);
      this.invalidScheduleIds.delete(schedule.id);
      return schedule;
    } catch (err) {
      this.invalidScheduleIds.add(schedule.id);
      if (!wasKnownInvalid) {
        this.logger?.warn?.('scheduler: quarantined invalid active schedule during DB sync', {
          scheduleId: schedule.id,
          error: String(err),
        });
      }
      return { ...schedule, nextFireAt: undefined };
    }
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
    this.invalidScheduleIds.delete(id);
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
      slotsInUse: this.countSlotsInUse(),
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
        lastProgressAt: attempt.lastProgressAt,
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
   * 当前所有 in-flight run 的 runId(跨 schedule)。这是「某个 run 还在不在跑」的**权威
   * 来源** —— 引擎内存态,不依赖 run 行是否还在库里。
   *
   * 为什么需要它:自删除场景下 run 行会先消失、run 却仍在跑。agent 在任务 run 内调
   * `schedule_delete` 删自己的 schedule 时,`deleteUnlocked` 用 `exemptRunId` 豁免 caller
   * run 不 abort,该 run 的行随 schedule 级联删除后它继续跑到底(见那里的注释与
   * `delete with exemptRunId leaves caller run running` 用例)。因此「DB 里查不到这条
   * run」既可能是「已结束并被清理」,也可能是「正在跑的自删除 run」,只有这份 in-flight
   * 快照能区分。消费方(renderer 的抑制标记对账)据此决定能不能清标记。
   */
  listInflightRunIds(): string[] {
    return [...this.inflightControllers.keys()];
  }

  /**
   * 当前 in-flight run 的展示 / 通知策略快照。消费方在 hook 晚挂或事件丢失时用它
   * 重建 silenced / schedulerOwned 标记;sessionId 尚未绑定时可为空。
   */
  listInflightRunPolicies(): SchedulerInflightRunPolicy[] {
    return [...this.inflightControllers.keys()].map((runId) => ({
      runId,
      sessionId: this.runIdToSessionId.get(runId) ?? this.runIdToBoundSessionId.get(runId),
      silenced: this.silencedRuns.has(runId),
    }));
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

  /**
   * 该 run 是否已被卡死守卫强制收口(runner 在投通知前查询)。
   *
   * 命中说明引擎已经把这一轮记成 failed 并按任务配置投过通知了。迟到 settle 的 runner
   * 若再走自己的 finalizeRun / notifyFailureSilent,用户会为同一轮收到两条通知
   * (review #944 第十四轮 P1)。常见顺序正是"引擎先投、runner 几分钟后才 settle",
   * 所以只靠引擎侧的 needsForcedFailureNotification 挡不住,必须 runner 侧也自查。
   */
  isRunAbandoned(runId: string): boolean {
    return this.abandonedRuns.has(runId);
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
    // 基准必须在这里就播种,不能等第一拍回调:run 起来之后、第一拍心跳(15s)之前机器就
    // 睡下去的话,醒来那一拍还没有可比的间隔,整段睡眠会被 enforceStallGuard 当成无反馈
    // 直接砍掉一条健康 run(review #944 第十四轮 P1)。
    this.lastHeartbeatAt = this.clock.now();
    this.heartbeatHandle = setInterval(() => {
      const runIds = [...this.inflightControllers.keys()];
      const now = this.clock.now();
      this.absorbSuspendGap(now);
      this.logLongRunningAttempts(now);
      this.enforceStallGuard(now);
      if (runIds.length > 0) {
        void this.storage.touchRunHeartbeats(runIds, now).catch((err) => {
          this.logger?.warn?.('scheduler: touchRunHeartbeats failed', err);
        });
      }
    }, RUN_HEARTBEAT_INTERVAL_MS);
    // 不让心跳定时器拖住进程退出(Electron main 常驻无感,vitest / CLI 宿主有感)。
    (this.heartbeatHandle as unknown as { unref?: () => void }).unref?.();
  }

  /**
   * 判据必须是 controller registry 而不是 attempts:'queued' 的纯等待 run 虽然不占
   * 并发槽,DB 里的 run 行仍是 'running',心跳一停 heartbeatAt 就不再续期,60s 后会被
   * 僵尸清扫误标 interrupted。两个 registry 的生命周期本来也是 controller 更长
   * (register 在 insertRun 之后、unregister 在 fire settle 时)。
   */
  private stopHeartbeatLoopIfIdle(): void {
    if (
      this.inflightAttempts.size === 0 &&
      this.inflightControllers.size === 0 &&
      this.heartbeatHandle !== null
    ) {
      clearInterval(this.heartbeatHandle);
      this.heartbeatHandle = null;
    }
  }

  /**
   * 阶段转移的唯一写入口(#1016):合法性由 attemptLifecycle 的显式转移表判定,
   * 非法转移**抛错**——「静默少做一件事」正是 #944 review 里同型出现四次的缺陷形态,
   * 宁可响亮失败也不静默容忍。幂等重入(from === to)按 no-op 放行并返回 false
   * (强制收口与迟到 settle 会各自把 attempt 置一次 'finalizing')。
   */
  private transitionAttempt(
    attempt: InflightAttempt,
    next: ScheduleRunPhase,
    via: string,
  ): boolean {
    const from = attempt.phase;
    if (from === next) return false;
    if (!isLegalPhaseTransition(from, next)) {
      throw new Error(
        `scheduler: illegal attempt phase transition ${from} -> ${next} ` +
          `(via ${via}, runId=${attempt.runId}, scheduleId=${attempt.scheduleId})`,
      );
    }
    attempt.phase = next;
    if (next === 'finalizing' && attempt.finalizingSince === undefined) {
      attempt.finalizingSince = this.clock.now();
    }
    return true;
  }

  /**
   * 单一出口的「出口清单」矫正(#1016):attempt 删除时校验并清掉所有仍指向它的
   * 登记(controller / per-schedule 索引 / session 双向映射 / 静默标记)。这些登记
   * 本应由各路径自己收干净(unregisterInflight / 强制收口);此处发现残留说明某条
   * 出口路径漏了收口动作 —— 矫正之余响亮告警,让这类缺陷在日志/测试里直接可见,
   * 而不是留成"槽位对不上 / 映射悬挂"的静默账。abandonedRuns 刻意不碰:它就是
   * 设计为跨 attempt 生命周期存活、由迟到 settle 消费的(见字段注释)。
   */
  private reapAttemptResiduals(runId: string, scheduleId: string): void {
    const residuals: string[] = [];
    if (this.inflightControllers.delete(runId)) residuals.push('controller');
    const set = this.inflightByschedule.get(scheduleId);
    if (set?.delete(runId)) {
      residuals.push('scheduleIndex');
      if (set.size === 0) this.inflightByschedule.delete(scheduleId);
    }
    const sessionId = this.runIdToSessionId.get(runId);
    if (sessionId !== undefined) {
      if (this.sessionIdToRunId.get(sessionId) === runId) this.sessionIdToRunId.delete(sessionId);
      this.runIdToSessionId.delete(runId);
      residuals.push('sessionMap');
    }
    if (this.runIdToBoundSessionId.delete(runId)) residuals.push('boundSessionMap');
    if (this.silencedRuns.delete(runId)) residuals.push('silencedRuns');
    if (residuals.length > 0) {
      this.logger?.warn?.(
        'scheduler: attempt exit found unreaped registrations (cleaned; a lifecycle path skipped its cleanup)',
        {
          schedulerInstanceId: this.schedulerInstanceId,
          processId: this.processId,
          runId,
          scheduleId,
          residuals,
        },
      );
    }
  }

  /**
   * 登记一致性不变量(#1016):所有按 runId 键控的登记必须指向仍在账的 attempt。
   * 违反 = 某条出口漏了收口且 reap 也没兜住(理论不可达;可达即缺陷),抛错让
   * 单测与运行期都响亮失败。只在 begin(注册面唯一的扩张点)校验,O(登记数),
   * 上限受并发闸门约束,代价可忽略。
   */
  private assertAttemptRegistryInvariants(): void {
    for (const runId of this.inflightControllers.keys()) {
      if (!this.inflightAttempts.has(runId)) {
        throw new Error(`scheduler invariant violated: controller without attempt (runId=${runId})`);
      }
    }
    for (const [scheduleId, runIds] of this.inflightByschedule) {
      for (const runId of runIds) {
        if (!this.inflightAttempts.has(runId)) {
          throw new Error(
            `scheduler invariant violated: schedule index entry without attempt (runId=${runId}, scheduleId=${scheduleId})`,
          );
        }
      }
    }
    for (const runId of this.runIdToSessionId.keys()) {
      if (!this.inflightAttempts.has(runId)) {
        throw new Error(`scheduler invariant violated: session map entry without attempt (runId=${runId})`);
      }
    }
    for (const runId of this.runIdToBoundSessionId.keys()) {
      if (!this.inflightAttempts.has(runId)) {
        throw new Error(
          `scheduler invariant violated: bound-session map entry without attempt (runId=${runId})`,
        );
      }
    }
    for (const runId of this.silencedRuns) {
      if (!this.inflightAttempts.has(runId)) {
        throw new Error(`scheduler invariant violated: silenced mark without attempt (runId=${runId})`);
      }
    }
  }

  /** 在第一次 await 前同步登记一次槽位占用，并输出可配对的注册日志。 */
  private beginInflightAttempt(
    input: Omit<SchedulerInflightRun, 'startedAt' | 'lastProgressAt'>,
  ): void {
    if (this.inflightAttempts.has(input.runId)) {
      throw new Error(`duplicate scheduler run id: ${input.runId}`);
    }
    const before = this.inflightAttempts.size;
    this.assertAttemptRegistryInvariants();
    const startedAt = this.clock.now();
    const attempt: InflightAttempt = { ...input, startedAt, lastProgressAt: startedAt };
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
    this.transitionAttempt(current, phase, 'updateInflightAttempt');
    if (schedule) {
      current.scheduleName = schedule.name;
      current.executionMode = schedule.executionMode ?? 'agent';
    }
  }

  /** finally 配对释放；stop() 已统一清空时，迟到的 finally 保持幂等 no-op。 */
  private finishInflightAttempt(runId: string): void {
    const attempt = this.inflightAttempts.get(runId);
    if (!attempt) return;
    if (attempt.forceReleaseOwnsCleanup) {
      // 强制收口正在进行:它独占这条 attempt 的清理权(见 forceReleaseStalledRun)。
      // 迟到 settle 的 fire 走到自己的外层 finally 时必须让位,否则未完成的收口会从
      // 槽位记账和守卫视野里一起消失(review #944 第十三轮 P1)。
      this.logger?.info?.('scheduler: deferring attempt cleanup to the in-progress force release', {
        schedulerInstanceId: this.schedulerInstanceId,
        processId: this.processId,
        runId,
        scheduleId: attempt.scheduleId,
      });
      return;
    }
    const before = this.inflightAttempts.size;
    this.inflightAttempts.delete(runId);
    this.reapAttemptResiduals(runId, attempt.scheduleId);
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
      lastProgressAt: attempt.lastProgressAt,
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
   * 本轮的 abort 是否由卡死守卫发起(而非用户 delete/pause)。
   *
   * 两者收口语义相反,必须分开:用户中断 → run 记 'aborted' 且**不重排**(schedule
   * 大概率已被删/停);守卫中断 → run 记 'failed' 且**照常重排** —— claimDueFire 已
   * 把 nextFireAt 清空,不补排的话 recurring 任务会静默停摆到进程重启。
   *
   * 这正是 review #944 抓到的 P1:守卫 abort 生效(runner 在宽限内老实响应)时,
   * 原实现把它当成用户中断,于是守卫"正常工作"反而让任务永久停摆 —— 比不加守卫更糟。
   */
  private wasStallAborted(runId: string): boolean {
    return this.inflightAttempts.get(runId)?.stallAbortedAt !== undefined;
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
    // 打上"注册过"的水印:此后 controller 缺席只可能是 finally 已摘（已 settle）。
    const attempt = this.inflightAttempts.get(runId);
    if (attempt) attempt.controllerRegistered = true;
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

  /**
   * 终态归因用的 session。runner 回报优先,其次运行/绑定映射,最后才是 schedule
   * 上的目标会话 —— 绑定前失败(目标会话校验拒绝等)没有映射,仍要把红点落到
   * 用户绑定的那条任务上。空字符串视为没有回报,继续往下找。
   */
  private resolveTerminalSessionId(
    runId: string,
    resultSessionId?: string,
    targetSessionId?: string,
  ): string | undefined {
    return (
      resultSessionId ||
      this.runIdToSessionId.get(runId) ||
      this.runIdToBoundSessionId.get(runId) ||
      targetSessionId ||
      undefined
    );
  }

  private emitFailed(scheduleId: string, runId: string, error: string, sessionId?: string): void {
    this.emitEvent({
      type: 'failed',
      scheduleId,
      runId,
      error,
      ...(sessionId ? { sessionId } : {}),
    });
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
      // 与 onTurnActive 同款迟到守卫:run 已被强制收口时不再写绑定映射(悬挂
      // 登记会触发 begin 的不变量断言),也不再往已定案 failed 的 run 行补状态。
      const attempt = this.inflightAttempts.get(runId);
      if (!attempt || attempt.phase === 'finalizing') return;
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
      const attempt = this.inflightAttempts.get(runId);
      // 迟到回调竞态同 onQueueWaitStart:强制收口删除 attempt 后 runner 的
      // continuation 仍可能报 turn active,此时写映射会留下悬挂登记,被下一次
      // begin 的 assertAttemptRegistryInvariants 当成缺陷抛错(codex review P1)。
      if (!attempt || attempt.phase === 'finalizing') return;
      this.sessionIdToRunId.set(sessionId, runId);
      this.runIdToSessionId.set(runId, sessionId);
    };
  }

  /**
   * 构造 onQueueWaitStart 回调:把 run 切进「纯等待」并让出执行槽。
   * 'queued' 期间该 run 不计入并发闸门(见 countSlotsInUse),也不受卡死守卫判定
   * (等一个忙会话是正常状态,不是卡死;排队本身的上限由 runner 侧负责)。
   *
   * 切换时把 lastProgressAt 推到当下:排队那段时间不该算进"多久没反馈"的额度,
   * 否则一条排了很久才被派发的 run 会在刚开始执行时就被守卫误判。
   */
  private buildOnQueueWaitStart(runId: string): () => void {
    return () => {
      const attempt = this.inflightAttempts.get(runId);
      // 迟到回调竞态是**预期**而非状态机缺陷:强制收口把 attempt 置 'finalizing' 后,
      // runner 的异步 continuation 仍可能调进来 —— 与 endQueueWait 同款按 no-op 处理,
      // 不让正常竞态伪装成非法转移错误(review 反馈)。
      if (!attempt || attempt.phase === 'finalizing') return;
      if (!this.transitionAttempt(attempt, 'queued', 'onQueueWaitStart')) return;
      attempt.lastProgressAt = this.clock.now();
      this.logger?.info?.('scheduler: in-flight run entered pure queue wait (slot released)', {
        schedulerInstanceId: this.schedulerInstanceId,
        processId: this.processId,
        ...this.describeInflightRun(attempt, attempt.lastProgressAt),
        slotsInUse: this.countSlotsInUse(),
        maxConcurrentRuns: this.maxConcurrentRuns,
      });
      this.emitRuntimeState();
    };
  }

  /**
   * 构造 endQueueWait 回调 —— 契约见 FireContext.endQueueWait。
   *
   * reclaimSlot=true 时这是一次**原子的占槽尝试**:让出的槽早已被 tick 补上新任务,
   * 所以必须重新过闸门。拿不到就返回 false,由 runner 在 vendor dispatch 之前中断本轮
   * (它有现成的路径:与"目标路由已停用"同款的 abort + rollback)。这样瞬时并发严格
   * 不超过 maxConcurrentRuns —— 上一轮用"让槽配额"把峰值压到 2× 只是缓解,reviewer
   * 指出 2×(默认 16)仍然暴露 CPU / token / 宿主过载,确实如此(review #944 第三轮)。
   *
   * 检查与占位之间没有 await:main 进程单线程,两个同时恢复的排队 run 不会都拿到
   * 最后一个槽。
   */
  private buildEndQueueWait(runId: string): (reclaimSlot: boolean) => boolean {
    return (reclaimSlot: boolean) => {
      const attempt = this.inflightAttempts.get(runId);
      // attempt 已不在(被强制收口 / 已 settle):没有记账要复位,也不必拦调用方。
      if (!attempt) return true;
      if (attempt.phase !== 'queued') return true;
      if (!reclaimSlot) {
        // 本轮不再执行 → 'cancelling':它已经不是纯等待(卡死守卫照常看得住),但也明确
        // 不会执行,所以不该占并发槽 —— 复位成 'running' 会让 slotsInUse 临时超过
        // maxConcurrentRuns、UI 冒出 9/8,也与 endQueueWait 契约里"只复位记账"矛盾
        // (review #944 第十五轮)。
        this.transitionAttempt(attempt, 'cancelling', 'endQueueWait');
        attempt.lastProgressAt = this.clock.now();
        this.emitRuntimeState();
        return true;
      }
      if (this.countSlotsInUse() >= this.maxConcurrentRuns) {
        this.logger?.info?.('scheduler: queued run cannot reclaim a slot, caller must stand down', {
          schedulerInstanceId: this.schedulerInstanceId,
          processId: this.processId,
          runId,
          scheduleId: attempt.scheduleId,
          slotsInUse: this.countSlotsInUse(),
          maxConcurrentRuns: this.maxConcurrentRuns,
        });
        return false;
      }
      this.transitionAttempt(attempt, 'running', 'endQueueWait-reclaim');
      attempt.lastProgressAt = this.clock.now();
      this.logger?.info?.('scheduler: queued run reclaimed a slot', {
        schedulerInstanceId: this.schedulerInstanceId,
        processId: this.processId,
        ...this.describeInflightRun(attempt, attempt.lastProgressAt),
        slotsInUse: this.countSlotsInUse(),
        maxConcurrentRuns: this.maxConcurrentRuns,
      });
      this.emitRuntimeState();
      return true;
    };
  }

  /**
   * 构造 onProgress 回调:热路径,只更新时间戳(不落库、不广播 runtime-state ——
   * 每个会话事件广播一次 IPC 会把 renderer 打爆)。卡死守卫读它做判定。
   */
  private buildOnProgress(runId: string): () => void {
    return () => {
      const attempt = this.inflightAttempts.get(runId);
      if (!attempt) return;
      attempt.lastProgressAt = this.clock.now();
      // 刻意**不**清 stallAbortedAt:abort 已经发出后,判据就从"你还在动吗"变成
      // "你停下来了吗"。此时继续冒事件不代表健康(abort 收口本身也会产生事件),
      // 让进展信号重置宽限会让强制释放永远等不到,卡死的槽位又收不回来了。
    };
  }

  /** runner 上报"我投了一条通知"。只记 failure —— 判据理由见 onRunnerNotified。 */
  private buildOnRunnerNotified(runId: string): (kind: 'success' | 'failure') => void {
    return (kind) => {
      if (kind !== 'failure') return;
      const attempt = this.inflightAttempts.get(runId);
      if (attempt) attempt.runnerNotifiedFailure = true;
    };
  }

  /**
   * 守卫收口时是否还需要补一条失败通知。attempt 缺席(理论上不会:本判定跑在
   * finishInflightAttempt 之前)按"没投过"处理 —— 宁可重复,不可静默。
   */
  private needsForcedFailureNotification(runId: string): boolean {
    return this.inflightAttempts.get(runId)?.runnerNotifiedFailure !== true;
  }

  /**
   * 把"系统挂起(合盖睡眠)的那段时间"从卡死判定里剔除。
   *
   * 判定用的是壁钟(clock.now):机器睡 8 小时,醒来第一次心跳看到的 noProgressMs 就是
   * 8 小时,于是把一条完全健康的 run —— 甚至是睡前正在跑长工具的 run —— 直接 abort
   * (review #944 第十二轮 P1)。心跳每 15s 一次,间隔突然出现远大于它的缺口,只可能是
   * 进程被冻结过,不是"对方没动静"。
   *
   * 处置是把所有 in-flight 的时间戳整体前移这段缺口 —— 等价于"睡着的时间不算数",
   * 醒来后各 run 的剩余额度与睡前一致。与 tick 里僵尸清扫的挂起处理同源(SUSPEND_GAP_MS),
   * 只是那边推迟清扫窗口、这边平移判定基准。
   */
  private absorbSuspendGap(now: number): void {
    const last = this.lastHeartbeatAt;
    this.lastHeartbeatAt = now;
    // 基准由 startHeartbeatLoopIfNeeded 播种,正常不会是 0;留作防御(stop 后的迟到回调)。
    if (last === 0) return;
    if (this.suspendGapMs <= 0) return; // 显式关闭(测试默认)
    const gap = now - last - RUN_HEARTBEAT_INTERVAL_MS;
    if (gap <= this.suspendGapMs) return;
    let shifted = 0;
    for (const attempt of this.inflightAttempts.values()) {
      attempt.lastProgressAt += gap;
      if (attempt.stallAbortedAt !== undefined) attempt.stallAbortedAt += gap;
      if (attempt.finalizingSince !== undefined) attempt.finalizingSince += gap;
      if (attempt.storageStallLoggedAt !== undefined) attempt.storageStallLoggedAt += gap;
      if (attempt.lastLongRunningLogAt !== undefined) attempt.lastLongRunningLogAt += gap;
      attempt.startedAt += gap;
      shifted += 1;
    }
    this.logger?.info?.('scheduler: absorbed system-suspend gap into stall accounting', {
      schedulerInstanceId: this.schedulerInstanceId,
      processId: this.processId,
      gapMs: gap,
      shiftedRuns: shifted,
    });
  }

  /** 真正占用并发槽的 run 数：'queued'（纯等待）与 'cancelling'（已放弃执行）都不计入。 */
  private countSlotsInUse(): number {
    let n = 0;
    for (const attempt of this.inflightAttempts.values()) {
      // 'queued' = 纯等待;'cancelling' = 已决定本轮不执行、正在收口。两者都不占槽。
      if (attempt.phase !== 'queued' && attempt.phase !== 'cancelling') n += 1;
    }
    return n;
  }

  /**
   * 卡死守卫。挂在已有的 15s 心跳 loop 上(不新增定时器),两段式:
   *   1. 无进展超过 runStallMs → abort,给 runner 一个体面收口的机会(它若响应
   *      signal,会走正常的 aborted 终态路径,与用户 pause/delete 同款)。
   *   2. abort 后再过 runStallAbortGraceMs 仍不 settle → 强制收回槽位(见
   *      forceReleaseStalledRun)。槽位释放不能依赖对方配合。
   * 'queued' 的纯等待项不参与判定:等忙会话是正常状态,且它本来就不占槽。
   */
  private enforceStallGuard(now: number): void {
    if (this.runStallMs <= 0) return;
    for (const attempt of [...this.inflightAttempts.values()]) {
      if (attempt.phase === 'queued') continue;
      // script 模式不参与本守卫(review #944 P1)。本守卫的判据是"事件静默",而 script
      // run 的正常形态就是长时间不出声——静默跑两小时的 build / 同步脚本很常见,按"无
      // 反馈"判它卡死是错的语义。script 的超时治理归它自己的 scriptConfig.timeoutMs
      // (用户显式配置,ScriptScheduleRunner 第一方执行)。
      // 残留缺口:没配 timeoutMs 又真卡死的 script 仍会长期占槽,只能靠用户 pause/delete
      // (script runner 第一方接 signal,abort 对它有效)。要根治应给 script 补默认超时,
      // 属独立改动,不塞进本 PR。
      if ((attempt.executionMode ?? 'agent') === 'script') continue;
      // 强制收口只针对"runner 在场却不理 abort"这一种卡死。runner 不在场的两端都不能
      // 走强制收口,共同点是 abort 无从下手、而删掉 attempt 会让这条 fire 从槽位记账和
      // 守卫视野里一起消失 —— 挂起的 await 一旦返回它还会继续往下写:
      //   - controller 未注册:fire 卡在 claimDueFire / insertRun / runNow 的 storage.get
      //     上,runner 根本没启动(review #944 第五轮 P1);
      //   - phase === 'finalizing':runner 已经返回,但终态落库(updateRun / get / update)
      //     卡住。此时 unregisterInflight 已经摘掉 controller,"controller 缺席"并不等于
      //     "这条 fire 结束了" —— 第五轮我在 forceReleaseStalledRun 里正是这么断言的,
      //     于是 finalizing 卡死会被当成已收口而删掉 attempt,run 行停在 'running'、
      //     自动认领清空的 nextFireAt 也没人补,任务停摆到重启(第六轮 P1)。
      // 两端一律保持追踪(继续占槽、继续出现在诊断快照里)并节流告警。本地 SQLite 卡住
      // 一小时意味着整个宿主已经不可用,不是单条 run 能自愈的层级;真值得做的是把它暴露
      // 出来,而不是悄悄把账做平。
      if (!attempt.controllerRegistered || attempt.phase === 'finalizing') {
        // 先过阈值:正常 fire 也会有几毫秒处于这两个窗口,不能一进窗口就报卡死。
        // finalizing 从进入该阶段起算 —— 守卫 abort 生效的正常路径下 lastProgressAt
        // 已经旧了整个 runStallMs,用它判定会在落库刚开始那一刻就误报(见 finalizingSince)。
        const wedgedSince =
          attempt.phase === 'finalizing'
            ? attempt.finalizingSince ?? attempt.lastProgressAt
            : attempt.lastProgressAt;
        if (now - wedgedSince < this.runStallMs) continue;
        this.logStorageStall(attempt, now, now - wedgedSince);
        continue;
      }
      if (attempt.stallAbortedAt === undefined) {
        if (now - attempt.lastProgressAt < this.runStallMs) continue;
        attempt.stallAbortedAt = now;
        this.logger?.warn?.('scheduler: run stalled with no progress, aborting', {
          schedulerInstanceId: this.schedulerInstanceId,
          processId: this.processId,
          ...this.describeInflightRun(attempt, now),
          noProgressMs: now - attempt.lastProgressAt,
          runStallMs: this.runStallMs,
        });
        try {
          this.inflightControllers.get(attempt.runId)?.abort();
        } catch (err) {
          this.logger?.warn?.('scheduler: stall abort threw', err);
        }
        continue;
      }
      if (now - attempt.stallAbortedAt < this.runStallAbortGraceMs) continue;
      // fire-and-forget 必须自带 catch:本函数跑在心跳定时器回调里,emitEvent 的
      // listener 抛错会变成 unhandled rejection 并可能拖垮宿主进程(review P2)。
      void this.forceReleaseStalledRun(attempt, now).catch((err) => {
        this.logger?.error?.('scheduler: forceReleaseStalledRun threw', {
          schedulerInstanceId: this.schedulerInstanceId,
          processId: this.processId,
          runId: attempt.runId,
          scheduleId: attempt.scheduleId,
          error: String(err),
        });
      });
    }
  }

  /**
   * runner 不在场的卡死(前置 await 未注册 controller / 终态落库卡住)的告警。不做处置,
   * 只保证可发现 —— 见 enforceStallGuard 里的理由。心跳每 15s 重入,按 runStallMs 节流。
   */
  private logStorageStall(attempt: InflightAttempt, now: number, wedgedMs: number): void {
    const last = attempt.storageStallLoggedAt;
    if (last !== undefined && now - last < this.runStallMs) return;
    attempt.storageStallLoggedAt = now;
    this.logger?.error?.(
      attempt.controllerRegistered
        ? 'scheduler: run stalled while persisting its terminal state — storage await appears wedged'
        : 'scheduler: run stalled before its abort controller was registered — storage await appears wedged',
      {
        schedulerInstanceId: this.schedulerInstanceId,
        processId: this.processId,
        ...this.describeInflightRun(attempt, now),
        wedgedMs,
        runStallMs: this.runStallMs,
        slotsInUse: this.countSlotsInUse(),
        maxConcurrentRuns: this.maxConcurrentRuns,
      },
    );
  }

  /**
   * 强制收回一条卡死 run 的槽位并就地收口。abort 没能让 runner settle 时的最后手段。
   *
   * 收口顺序与 fireOneInner 的失败分支保持一致:先落 run 行终态,再按 recurring
   * 语义重排 schedule。**必须重排** —— claimDueFire 已把 nextFireAt 清空,不补排的话
   * 这条 recurring 任务会静默停摆到下次进程重启(与 rescheduleAfterSweep 同款理由)。
   *
   * run 记 'failed' 而不是 'aborted':卡死是异常,必须可见(红点 + 按任务 notify
   * 配置通知)。'aborted' 在 UI 上呈现为"用户中断",会把故障伪装成正常操作。
   */
  private async forceReleaseStalledRun(attempt: InflightAttempt, now: number): Promise<void> {
    const { runId, scheduleId } = attempt;
    // 竞态收窄:runner 在宽限最后一刻 settle 时,fire 的 finally 已经同步摘掉
    // controller、正在走自己的终态收口。此时不抢 —— 否则会把一次真实成功记成
    // failed。controller 还在 = runner 确实没动静,继续强制收口。
    //
    // 让位时**不删 attempt**:controller 缺席只说明"runner 返回了",不说明"这条 fire
    // 结束了" —— 它可能正卡在终态落库上。删掉就等于让一条仍在往下写的 fire 从槽位记账
    // 和守卫视野里一起消失(第六轮 P1)。槽位一律由 fire 自己的 finally 经
    // finishInflightAttempt 释放;真卡住了就留在账上,由 logStorageStall 持续暴露。
    if (!this.inflightControllers.has(runId)) return;
    // 摘 controller + 转 'finalizing':同步完成,保证本轮之后的 tick / 守卫都不再重复
    // 走强制收口(phase='finalizing' 会被守卫分流到 logStorageStall 那条只观测的分支)。
    //
    // **attempt 留到收口真正结束再删**(第七轮 P1)。下面的 updateRun / 重排若卡住,提前
    // 删掉 attempt 就等于:run 行还停在 'running'、自动认领清空的 nextFireAt 还没补,而这
    // 条 run 已经从槽位记账和守卫视野里一起消失 —— 与第六轮修的 runner-finalization
    // 同一个坑,只是这次发生在强制收口自己的落库上。槽位统一由下面 finally 里的
    // finishInflightAttempt 释放;真卡住就留在账上,由 logStorageStall 持续暴露。
    this.abandonedRuns.add(runId);
    this.inflightControllers.delete(runId);
    this.transitionAttempt(attempt, 'finalizing', 'force-release');
    const set = this.inflightByschedule.get(scheduleId);
    if (set) {
      set.delete(runId);
      if (set.size === 0) this.inflightByschedule.delete(scheduleId);
    }
    const sessionId = this.resolveTerminalSessionId(
      runId,
      undefined,
      this.activeSchedules.get(scheduleId)?.targetSessionId,
    );
    if (sessionId !== undefined) {
      if (this.sessionIdToRunId.get(sessionId) === runId) this.sessionIdToRunId.delete(sessionId);
      this.runIdToSessionId.delete(runId);
    }
    this.runIdToBoundSessionId.delete(runId);
    this.silencedRuns.delete(runId);
    const noProgressMs = now - attempt.lastProgressAt;
    this.logger?.error?.('scheduler: force-releasing stalled run slot (runner never settled)', {
      schedulerInstanceId: this.schedulerInstanceId,
      processId: this.processId,
      ...this.describeInflightRun(attempt, now),
      noProgressMs,
      abortGraceMs: this.runStallAbortGraceMs,
      // 槽位在下面的收口结束后才释放,所以这里的 slotsInUse 仍含本条。
      slotsInUse: this.countSlotsInUse(),
      slotReleasePending: true,
      maxConcurrentRuns: this.maxConcurrentRuns,
    });
    this.emitRuntimeState();
    // 认领 attempt 的清理权,**必须紧贴 try**:此后只有下面的 finally 能删它。
    // 否则一条迟到 settle 的 runner(在 abandonedRuns 标记之后、收口 await 期间返回)
    // 会让 fireOne / runNow 自己的外层 finally 先把 attempt 删掉 —— 未完成的收口
    // 就此从槽位记账和守卫视野里消失,落库若卡住,run 行停在 'running'、自动认领清空的
    // nextFireAt 也没人补,而新任务照常放行(review #944 第十三轮 P1)。
    attempt.forceReleaseOwnsCleanup = true;
    try {
      await this.finishForceReleasedRun(attempt, now, noProgressMs, sessionId);
    } finally {
      // 唯一的槽位释放出口(收口成功 / 落库失败 / 抛错都要走到)。
      attempt.forceReleaseOwnsCleanup = false;
      this.finishInflightAttempt(runId);
    }
  }

  /** forceReleaseStalledRun 的收口段:落 run 行终态 + 恢复排期。见那里的注释。 */
  private async finishForceReleasedRun(
    attempt: InflightAttempt,
    now: number,
    noProgressMs: number,
    sessionId?: string,
  ): Promise<void> {
    const { runId, scheduleId } = attempt;
    const errorMsg =
      `run stalled: no progress for ${Math.round(noProgressMs / 60_000)}min ` +
      `and did not stop within ${Math.round(this.runStallAbortGraceMs / 1000)}s of abort`;
    // 终态落库失败时**不能**继续按"已收口"广播:那样 UI 会显示 failed,而 DB 行仍是
    // 'running' 并稍后被僵尸清扫改成 interrupted,两边对不上(review P1)。此时槽位已经
    // 收回(目的达到),run 行交给心跳过期后的清扫兜底,并显式告警。
    let persisted = false;
    try {
      persisted = (await this.storage.updateRun(runId, {
        status: 'failed',
        finishedAt: now,
        errorMsg,
        ...(sessionId ? { sessionId } : {}),
      })) !== null;
    } catch (err) {
      this.logger?.warn?.('scheduler: stalled run updateRun failed', { runId, error: String(err) });
    }
    if (!persisted) {
      this.logger?.error?.(
        'scheduler: stalled run terminal state not persisted; leaving row to the stale-run sweep',
        { schedulerInstanceId: this.schedulerInstanceId, processId: this.processId, runId, scheduleId },
      );
      // 不广播 failed —— 不制造一个数据库里不存在的终态(UI 会显示失败,DB 行却还是
      // 'running' 并稍后被清扫改成 interrupted,两边分叉)。
      //
      // 但**排期照旧要恢复**:run 行的终态与 schedule 的下次触发是两件独立的事。
      // 自动 claim 已经清空 nextFireAt,这里若一并跳过重排,周期任务会静默停摆到
      // 进程重启 —— 上一轮为修"落库失败仍广播 failed"加的 early return 恰好引入了
      // 这个新问题(review #944 第三轮)。
      await this.replanAfterStalledClaim(attempt, now);
      this.emitEvent({ type: 'changed', scheduleId });
      // **通知也照旧要投**。它与 'failed' 事件是两条独立通道:不广播事件是为了不让 UI
      // 和 DB 分叉,但这一轮确实失败了,用户配的桌面 / 飞书提醒不该因为一次写盘失败就
      // 消失。尤其是 runner 迟到 settle 的那条竞态:它已经因为 isRunAbandoned 而主动
      // 让出了通知权,这里再跳过就等于两边都不投,用户什么都收不到
      // (review #944 第十五轮 P1)。
      if (this.needsForcedFailureNotification(runId)) {
        void this.notifyForcedFailure(scheduleId, runId, errorMsg);
      }
      return;
    }
    this.emitFailed(scheduleId, runId, errorMsg, sessionId);
    // 迟到 settle 的 runner 可能已经先投过失败通知(第十三轮起 attempt 在收口期间保留,
    // 所以 onRunnerNotified 的记录此刻是可读的)。两侧都自查才能做到"恰好一条":
    // runner 先投 → 这里跳过;这里先投 → runner 经 isRunAbandoned 跳过
    // (review #944 第十四轮 P1)。
    if (this.needsForcedFailureNotification(runId)) {
      void this.notifyForcedFailure(scheduleId, runId, errorMsg);
    }
    // 重排:**不能**复用 rescheduleAfterSweep —— 它遇到"该 schedule 仍有 running 行"
    // 就放弃补排,而同一 schedule 上并发的 runNow 正好构成这种情形;runNow 收口只写
    // lastFinishedAt、从不重排,于是没人恢复排期,任务永久停摆(review P1)。这里明确
    // 知道被弃的是一个自动 claim,直接按 recurring 语义补排。
    await this.replanAfterStalledClaim(attempt, now);
    this.emitEvent({ type: 'changed', scheduleId });
  }

  /**
   * 卡死自动 claim 的排期补偿。语义与 fireOneInner 的正常重排一致:读回真实行(run
   * 期间用户可能改过 cron / 暂停 / 删除)、尊重 manual 与已消耗的一次性任务、不覆盖
   * 已 paused 的行。与 rescheduleAfterSweep 的唯一区别:不因"还有别的 running 行"
   * 而放弃 —— 调用方已经确定这条自动 claim 的排期需要恢复。
   *
   * **只补偿自动 claim**。runNow 从不认领自动触发、也从不改 nextFireAt(见 runNow 顶注:
   * "手动触发不应改变下一次按 cron 排定的时间"),所以强制收口一条卡死的手动 run 时不能
   * 顺手补排:那会替一个自己没持有的 claim 写排期 —— 同 schedule 上真正在跑的自动 run
   * 可能与新排出来的这次重叠,一次性任务还会因为 lastFiredAt 尚未落定而被当成没消耗过、
   * 就此复活(第六轮 P1)。手动 run 卡死只收自己的槽位和 run 行。
   *
   * recurring=false 的自动 claim 走**过期**而不是重排 —— 见函数体内注释(第七轮 P1)。
   */
  private async replanAfterStalledClaim(attempt: StalledClaimPlan, now: number): Promise<void> {
    const { scheduleId } = attempt;
    try {
      await this.applyStalledClaimReplan(attempt, now);
      // **任何确定性结论都要摘除重试凭据**:补上了 / 行已删 / 已 paused / 已消耗 /
      // 别的路径已经补过。只要还留着,这条凭据就永久上膛 —— 等那次合法触发被认领、
      // nextFireAt 又被清空时,重叠的 tick 会把这条陈旧重试再应用一次,凭空排出一次
      // 触发,与正在跑的那一轮重叠(第十八轮 P1:上一版只在 try 尾部 delete,函数体里
      // 每一个早退分支都绕过了它)。
      this.pendingReplans.delete(scheduleId);
    } catch (err) {
      // 只有"这次没做成"才保留/上膛,由后续 tick 重试(见 retryPendingReplans)。
      this.pendingReplans.set(scheduleId, {
        scheduleId,
        runId: attempt.runId,
        startedAt: attempt.startedAt,
        source: attempt.source,
      });
      this.logger?.warn?.('scheduler: replan after stalled run failed — queued for retry', {
        scheduleId,
        runId: attempt.runId,
        error: String(err),
      });
    }
  }

  /** replanAfterStalledClaim 的函数体;抛错即"本次没做成",由调用方决定重试。 */
  private async applyStalledClaimReplan(attempt: StalledClaimPlan, now: number): Promise<void> {
    const { scheduleId } = attempt;
    if (attempt.source !== 'automatic') {
      this.logger?.info?.('scheduler: skipping replan for stalled non-automatic run', {
        schedulerInstanceId: this.schedulerInstanceId,
        processId: this.processId,
        scheduleId,
        runId: attempt.runId,
        source: attempt.source,
      });
      return;
    }
    {
      const current = await this.storage.get(scheduleId);
      if (!current) return; // 行已删,无需补排
      if (current.status !== 'active') return; // paused / expired:resume 时自己会重算
      if (current.nextFireAt !== undefined) return; // 已有排期(别的路径已补),不覆盖
      // 一次性任务(Once)必须**过期**而不是重排。强制收口没走 fireOneInner 的正常终态段,
      // lastFiredAt 从未落定,computeNextFireAt 因此把它当成"还没跑过"又排一次 —— 一个
      // 失败的 Once 任务会自己再跑一遍(第七轮 P1)。这里补上正常路径的那套写入:记下
      // 这次已消耗的触发 + 置 expired + 清 nextFireAt。
      // lastFiredAt 用 attempt.startedAt(登记时刻):强制收口路径手里没有 run 行的
      // firedAt,两者只差一次 claim 的毫秒级延迟。
      //
      // manual 排除在外(防御性):manual 的 nextFireAt 永不被设置,tick 也就永远不会产生
      // 自动 attempt,这个分支理论上到不了 manual 行;但真到了也不能把它标 expired ——
      // 那会让一个"只按需手动跑"的任务在 UI 上变成已过期。
      if (!current.recurring && !current.manual) {
        const updated = await this.storage.update(scheduleId, {
          lastFiredAt: attempt.startedAt,
          lastFinishedAt: now,
          status: 'expired',
          nextFireAt: undefined,
        });
        this.activeSchedules.delete(scheduleId);
        this.logger?.info?.('scheduler: expired one-shot schedule after stalled run', {
          schedulerInstanceId: this.schedulerInstanceId,
          processId: this.processId,
          scheduleId,
          runId: attempt.runId,
          persisted: updated !== null,
        });
        return;
      }
      const next = computeNextFireAt(current, now);
      if (next === undefined) return; // manual:按语义不续命
      const updated = await this.storage.update(scheduleId, { nextFireAt: next });
      if (updated && updated.status === 'active') {
        this.activeSchedules.set(scheduleId, updated);
      }
      this.logger?.info?.('scheduler: replanned schedule after stalled run', {
        schedulerInstanceId: this.schedulerInstanceId,
        processId: this.processId,
        scheduleId,
        nextFireAt: next,
      });
    }
  }

  /**
   * 重试上一次因存储瞬时错误而没做成的排期补偿。每个 tick 跑一次,顺序、串行、不并发 ——
   * 队列通常是空的,非空时也只有个别条目(卡死本身是罕见事件)。
   * 仍失败的条目留在队列里等下一个 tick;成功或确定无需补排的由 replanAfterStalledClaim
   * 自己摘除。
   */
  private async retryPendingReplans(now: number): Promise<void> {
    if (this.pendingReplans.size === 0) return;
    for (const pending of [...this.pendingReplans.values()]) {
      await this.replanAfterStalledClaim(pending, now);
    }
  }

  /** 卡死收口的 run 错误文案(强制释放与"守卫 abort 被 runner 响应"两条路径共用)。 */
  private describeStallAbort(runError: string | undefined): string {
    const base =
      `run aborted by stall guard: no progress for over ` +
      `${Math.round(this.runStallMs / 60_000)}min`;
    return runError ? `${base} (${runError})` : base;
  }

  /** 把卡死收口经 host 注入的出口投出去;通知失败绝不影响收口。 */
  private async notifyForcedFailure(
    scheduleId: string,
    runId: string,
    errorMsg: string,
  ): Promise<void> {
    if (!this.notifyForcedFailureHook) return;
    try {
      await this.notifyForcedFailureHook({ scheduleId, runId, errorMsg });
    } catch (err) {
      this.logger?.warn?.('scheduler: notifyForcedFailure hook threw', {
        scheduleId,
        runId,
        error: String(err),
      });
    }
  }

  /**
   * 该 run 是否已被卡死守卫强制收口。命中说明 run 行早已落终态、schedule 已重排,
   * 迟到 settle 的 fireOneInner / runNowInner 必须整体跳过收口动作(见 abandonedRuns)。
   * 顺带清理集合条目 —— 迟到的那次调用是它最后一个消费者。
   */
  private consumeAbandonedRun(runId: string): boolean {
    if (!this.abandonedRuns.has(runId)) return false;
    this.abandonedRuns.delete(runId);
    this.logger?.warn?.('scheduler: discarding late settle of force-released run', {
      schedulerInstanceId: this.schedulerInstanceId,
      processId: this.processId,
      runId,
    });
    return true;
  }
}

function computeNextFireAt(schedule: Schedule, fromMs: number): number | undefined {
  // manual schedule 永远不参与自动触发，跳过 cron 计算（runNow 是单独路径）
  if (schedule.manual) return undefined;
  if (!schedule.recurring && schedule.lastFiredAt !== undefined) return undefined;
  // interval schedules still persist cron metadata. Validate it before taking
  // the interval fast path so legacy rows accepted by older parsers cannot
  // evade startup/DB-sync quarantine and fire from a stale nextFireAt.
  nextCronOrMonthlyFire(schedule.cronExpr, fromMs, schedule.timezone);
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
