export type ScheduleKind = 'cron';
export type AgentKind = 'claude-code' | 'codex';
export type ScheduleStatus = 'active' | 'paused' | 'expired';
export type ScheduleWorkspaceKind = 'project' | 'dialogue';
export type ScheduleExecutionMode = 'agent' | 'script';
export type ScriptCapability = 'jira.read' | 'jira.comment' | 'sessions.dispatch' | 'feishu.read';

/** 一次调度执行由自动到点触发，还是由用户显式 runNow 触发。 */
export type ScheduleFireSource = 'automatic' | 'run-now';

/**
 * Scheduler 内部执行阶段。阶段只用于运行期诊断，不持久化到 schedule_runs。
 * 它覆盖从抢占排期到终态落库的整个槽位生命周期。
 */
export type ScheduleRunPhase =
  | 'loading'
  | 'claiming'
  | 'persisting'
  | 'running'
  | 'finalizing';

/** 当前 Scheduler 实例中的一条结构化 in-flight 记录。 */
export interface SchedulerInflightRun {
  scheduleId: string;
  scheduleName?: string;
  runId: string;
  source: ScheduleFireSource;
  executionMode?: ScheduleExecutionMode;
  startedAt: number;
  /** 自动任务从到期到真正获得槽位的等待时间；runNow 没有此字段。 */
  slotWaitMs?: number;
  phase: ScheduleRunPhase;
}

/** 因自动并发闸门而尚未获得槽位的到期任务。 */
export interface SchedulerWaitingSchedule {
  scheduleId: string;
  scheduleName: string;
  /** 任务原定到期时间；当前等待时长可由 now - waitingSince 计算。 */
  waitingSince: number;
}

/**
 * Scheduler 的瞬时运行快照。通过 IPC 查询并在变化时推送给 renderer；不写数据库。
 */
export interface SchedulerRuntimeSnapshot {
  schedulerInstanceId: string;
  processId?: number;
  inFlight: number;
  maxConcurrentRuns: number;
  inFlightRuns: SchedulerInflightRun[];
  waitingSchedules: SchedulerWaitingSchedule[];
}

/**
 * script 模式可授予的全量能力目录(单一来源):引擎校验白名单与 UI 能力选择器
 * 都从这里枚举——host 侧新增能力时只改这一处,选择器自动出现新项。
 */
export const SCRIPT_CAPABILITIES: readonly ScriptCapability[] = [
  'jira.read',
  'jira.comment',
  'sessions.dispatch',
  'feishu.read',
];

/**
 * Host-executed script task. The command is selected by the user and runs in
 * the schedule workspace; capabilities are default-deny grants for host RPC.
 */
export interface ScriptExecutionConfig {
  command: string;
  timeoutMs?: number;
  capabilities: ScriptCapability[];
}
/**
 * 'interrupted': app 关闭/崩溃时残留为 'running' 的 run，下次启动时由
 * Scheduler.start() 统一改写为本状态，区别于用户主动 abort。视为终态。
 * 'skipped': 前置检查脚本（preRunHook）exit 2 拦截，本轮未启动 agent。
 * 视为终态；落库时自带 readAt（生而已读，不产生未读红点）。
 */
export type RunStatus = 'running' | 'success' | 'failed' | 'aborted' | 'interrupted' | 'skipped';
/**
 * Release-compat tombstone — issue-triage 子模式已下线（见 0028/0029 migration），
 * 新代码不再创建 'issue-triage' 任务，但类型与 DB 列保留，允许老 release 版本继续
 * 读写老数据，避免跨版本运行时崩溃。新流程恒为 'prompt'。
 */
export type JobType = 'prompt' | 'issue-triage';

export interface ScheduleNotifyConfig {
  desktop: boolean;
  feishu: boolean;
}

/**
 * 前置检查脚本（Pre-run Hook）配置。任务触发时 runner 先执行该脚本再决定是否
 * 真正启动 agent（不启动 = 零 token 消耗）。协议对齐 Claude Code hooks：
 *   - exit 0 → 放行本轮
 *   - exit 2 → 跳过本轮（run 记 'skipped'，照常重排下一次触发）
 *   - 其它退出码 / 超时 / 脚本不存在 → fail-closed：阻止本轮并记录失败结果
 * 脚本语言无关：command 是一条经系统 shell 执行的命令字符串，cwd = 本轮工作目录，
 * stdin 收到 JSON 上下文（scheduleId / name / firedAt / workingDir 等）。
 * Windows 下 shebang 不生效，command 应写显式解释器（`node x.mjs` / `python x.py`）。
 */
export interface PreRunHookConfig {
  /** 经系统 shell 执行的命令字符串。 */
  command: string;
  /** 超时毫秒；超时会阻止本轮执行。未配置 = 不限时（无默认超时）。 */
  timeoutMs?: number;
}

/** 前置检查一次执行的最终状态。 */
export type PreRunHookRunStatus = 'passed' | 'skipped' | 'failed' | 'timed_out' | 'aborted';

/** 前置检查对本轮任务的最终判定。 */
export type PreRunHookDecision = 'run' | 'skip' | 'block';

/**
 * 单轮前置检查的结构化结果。它独立于 agent 的 resultText：检查可能在创建 session
 * 之前就失败，也可能通过后继续得到正常的 agent 结果。
 */
export interface PreRunHookRunResult {
  status: PreRunHookRunStatus;
  decision: PreRunHookDecision;
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  /** 兼容现有执行/测试调用点的显式状态位。 */
  timedOut: boolean;
  aborted: boolean;
  spawnError?: string;
  /** spawn 失败或未形成有效退出结果时的诊断信息。 */
  error?: string;
}

export interface Schedule {
  id: string;
  name: string;
  prompt: string;
  /** Release-compat tombstone（见 JobType 注释）。新建恒为 'prompt'。 */
  jobType?: JobType;
  /** Release-compat tombstone：老 issue-triage 的 JSON 配置；新代码不读不写。 */
  jobConfig?: string;
  source?: 'user' | 'project';
  projectConfigId?: string;
  kind: ScheduleKind;
  cronExpr: string;
  timezone: string;
  recurring: boolean;
  /**
   * 手动触发模式：true 表示这条 schedule 不参与 cron 自动调度，
   * 永远只能通过 `runNow()` 触发。`cronExpr` 仍然保留（创建时仍要求合法）但不会被
   * 引擎读来计算 nextFireAt — 视作占位。`runNow` 不受影响。
   */
  manual: boolean;
  /**
   * Interval-mode 间隔毫秒。设了就走"上次完成 + intervalMs"语义（不再按 cron 槽位），
   * 引擎在 fireOne / start / resume / create 里都会优先检查本字段。
   *   - 首次触发：createdAt + intervalMs
   *   - 周期触发：finishedAt + intervalMs
   *   - 冷启动 / resume：now + intervalMs（不补发漏掉的，重新起 N 倒计时）
   * 没设（undefined）→ 维持 cron 槽位语义；`cronExpr` 在 interval 模式下仍保留为
   * 兼容/显式切回 Cron 时的表达式，但 UI 回显与引擎执行都必须以 intervalMs 为准。
   */
  intervalMs?: number;
  agentKind: AgentKind;
  model?: string;
  /**
   * 显式选定的供应商(来源)id。undefined / 空 → 回落该 agent 原生默认来源
   * （no-break，与未升级行为字节级一致）；非空才按 catalog RoutingDescriptor 路由。
   * 语义与 desktop `session-provider-store` 的 null 对齐。
   */
  providerId?: string;
  effort?: string;
  /**
   * Fast 模式：仅 Codex 有意义（agent capability `hasFastMode` 为 true）。
   * true → runner fire 时透传给 codex agent，落到 app-server 的 ServiceTier.Fast，
   * 输出更快。Claude agent 忽略此字段。undefined/false → 标准 tier。
   */
  fastMode?: boolean;
  /**
   * New-session workspace semantics.
   * - project: workingDir is a user-selected project directory.
   * - dialogue: runner allocates an app-managed dialogue cwd per fire.
   *
   * Heartbeat schedules ignore this and use the target session's existing cwd.
   */
  workspaceKind: ScheduleWorkspaceKind;
  workingDir?: string;
  useWorktree: boolean;
  targetSessionId?: string;
  /**
   * 持续会话模式：true → runner 在第一次 fire 成功创建 session 后自动把 sessionId
   * 回写到本字段 `targetSessionId`，后续 fire 都走 heartbeat resume 同一 session，
   * 拥有完整上下文。false（默认） → 每次 fire 新建 session（旧行为）。
   *
   * 与 MCP 显式指定 `targetSessionId` 的"手绑 session"模式正交：显式绑定本身已经
   * 达到等效效果，`persistentSession=true` 在那种 schedule 上是 no-op；
   * 绑定的 session 若被归档/删除：persistentSession=true → runner 自动清空
   * targetSessionId 并本次 fire 走新建分支（自我续命）；persistentSession=false
   * → 维持旧行为 pause 整条 schedule。
   */
  persistentSession?: boolean;
  /**
   * 静默运行:true → 成功 run 默认不发通知、不产生未读小红点;任务 prompt 可自行说明
   * 哪些业务条件值得提醒,agent 在满足时调用 schedule_notify_current_run 主动上报。
   * 失败/异常仍然通知。默认 false(每轮成功都按通知渠道提醒,旧行为)。
   */
  silentWhenIdle?: boolean;
  /** Execution mode; omitted/legacy schedules run an agent. */
  executionMode?: ScheduleExecutionMode;
  /** Required when executionMode is 'script'. */
  scriptConfig?: ScriptExecutionConfig;
  /**
   * 前置检查脚本。undefined = 未配置，完全走原有流程（零行为变化）。
   * 详见 PreRunHookConfig。
   */
  preRunHook?: PreRunHookConfig;
  notify: ScheduleNotifyConfig;
  status: ScheduleStatus;
  createdAt: number;
  updatedAt: number;
  lastFiredAt?: number;
  /** 上一次终态完成（success/failed/aborted）的时间戳。从未跑完过 = undefined。 */
  lastFinishedAt?: number;
  nextFireAt?: number;
  expireAt?: number;
}

export interface ScheduleRun {
  id: string;
  scheduleId: string;
  sessionId?: string;
  firedAt: number;
  finishedAt?: number;
  status: RunStatus;
  errorMsg?: string;
  /** 本次 run 产生的真实 API 账单费用。 */
  costUsd?: number;
  /** 本次 run 的订阅 token 估算价值，不计入真实账单。 */
  estimatedValueUsd?: number;
  /** 新版区域真实费用；旧 costUsd 仅作历史 USD 兼容。 */
  costMoney?: ScheduleRunMoney;
  /** 新版区域订阅价值估算；不代表实际账单。 */
  estimatedValueMoney?: ScheduleRunMoney;
  /**
   * exact = 已确认费用（可能是实际账单，也可能是 estimate-only）；direct = 费用仅来自
   * 无法挂载消息的直接账本；mixed = 快照同时包含直接账本和消息账本；zero = 已确认零费用；
   * unavailable = agent run 尚无可靠计价；legacy = 历史数据无法精确拆到单次 run。
   */
  costAttribution?: 'exact' | 'direct' | 'mixed' | 'zero' | 'unavailable' | 'legacy';
  /**
   * Agent 这一轮 turn 的最终文本（与飞书正常对话气泡显示内容同源 — 按 isFinal
   * 替换、否则追加 delta，done 时定格）。仅 prompt 类 run 在 success 时填，
   * 失败 run 留 undefined。供通知渲染 / 历史回顾用。
   */
  resultText?: string;
  /** 本轮实际执行过前置检查时的结构化结果。 */
  preRunHookResult?: PreRunHookRunResult;
  /** 用户已读时间戳（毫秒）；NULL 表示未读。仅对终态 run 有意义。 */
  readAt?: number;
  /**
   * In-flight 心跳时间戳（毫秒）——跨实例的"这条 run 仍有活实例在跑"租约信号。
   * 执行实例在 run 期间周期性续期；僵尸清理（markRunningAsInterrupted）只回收
   * 心跳过期的 'running' 行，不会误标另一个活实例正在执行的 run。
   * 仅 'running' 期间有意义；老版本写入的行可能为 NULL（按 firedAt 兜底判停滞）。
   */
  heartbeatAt?: number;
}

export interface ScheduleRunMoney {
  amount: number;
  currency: 'CNY' | 'USD';
  approximate: boolean;
  kind: 'actual-cost' | 'value-estimate';
  estimateReasons?: Array<
    'fixed-fx' | 'legacy-usd' | 'subscription-value' | 'reference-price'
  >;
}

export interface CreateScheduleInput {
  name: string;
  prompt: string;
  /** Release-compat tombstone（见 JobType 注释）。新建恒为 'prompt'，可省略。 */
  jobType?: JobType;
  /** Release-compat tombstone：老 issue-triage 的 JSON 配置；新代码不读不写。 */
  jobConfig?: string;
  kind: ScheduleKind;
  cronExpr: string;
  timezone: string;
  recurring: boolean;
  /** 默认 false。true → 永不自动触发，只能 runNow。详见 Schedule.manual。 */
  manual?: boolean;
  /** Interval 语义间隔（毫秒）。详见 Schedule.intervalMs。 */
  intervalMs?: number;
  agentKind: AgentKind;
  model?: string;
  /**
   * 显式选定的供应商(来源)id。undefined / 空 → 回落该 agent 原生默认来源
   * （no-break，与未升级行为字节级一致）；非空才按 catalog RoutingDescriptor 路由。
   * 语义与 desktop `session-provider-store` 的 null 对齐。
   */
  providerId?: string;
  effort?: string;
  /** Codex Fast 模式开关，仅 Codex 有意义。详见 Schedule.fastMode。 */
  fastMode?: boolean;
  /** Defaults to 'project' for backwards compatibility. */
  workspaceKind?: ScheduleWorkspaceKind;
  workingDir?: string;
  useWorktree: boolean;
  targetSessionId?: string;
  /** 默认 false。详见 Schedule.persistentSession。 */
  persistentSession?: boolean;
  /** 默认 false。详见 Schedule.silentWhenIdle("静默运行")。 */
  silentWhenIdle?: boolean;
  /** Execution mode; defaults to agent for legacy schedules. */
  executionMode?: ScheduleExecutionMode;
  /** Required when executionMode is 'script'. */
  scriptConfig?: ScriptExecutionConfig | null;
  /**
   * 前置检查脚本；undefined = 不启用。详见 PreRunHookConfig。
   * update patch 里允许显式传 null = 关闭并清空（跨 JSON 边界的调用方——MCP /
   * device-link——无法用“带 key 的 undefined”表达清列,null 是等价通道;
   * create 时 null 与 undefined 同义,引擎归一成 undefined）。
   */
  preRunHook?: PreRunHookConfig | null;
  notify: ScheduleNotifyConfig;
  expireAt?: number;
}

export type UpdateScheduleInput = Partial<CreateScheduleInput>;

export interface ListFilter {
  status?: ScheduleStatus;
}

export type SchedulerEvent =
  | { type: 'fired'; scheduleId: string; runId: string; silent?: boolean }
  | { type: 'completed'; scheduleId: string; runId: string; sessionId: string; silenced?: boolean }
  | { type: 'failed'; scheduleId: string; runId: string; error: string }
  /**
   * In-flight run 已被标记静默。该事件早于后续 agent done/completed 收口,
   * 消费方用它抑制普通 session completion attention；completed.silenced
   * 仍作为最终兜底清理信号。
   */
  | { type: 'silenced'; scheduleId: string; runId: string; sessionId: string }
  /**
   * 静默运行中的 agent 已主动声明本轮需要提醒用户。消费方用它恢复普通完成
   * attention / 音效路径。
   */
  | { type: 'notified'; scheduleId: string; runId: string; sessionId: string }
  /**
   * 本次 fire 被顺延(撞忙礼让):预插的 running run 已被撤销、不留可见记录,因此**不发**
   * 'completed' / 'failed'。但 'fired' 已先发出去,消费方(renderer useSchedules 的
   * ephemeral runningById)需要据此清掉"运行中"态,否则 chip 会卡在 running 直到下一次
   * 真 run 完成。携带 runId 让消费方精确匹配它当初因 'fired' 记下的那一条。
   */
  | { type: 'deferred'; scheduleId: string; runId: string }
  /**
   * 本次 fire 被前置检查脚本（preRunHook exit 2）拦截跳过：未启动 agent、零 token。
   * 与 'deferred' 的区别：run 记录**保留**（status='skipped'，生而已读），照常按
   * recurring 语义重排下一次触发（不是短延重试）。消费方需像 'deferred' 一样清掉
   * ephemeral running 态；不发通知、不亮红点。sessionId 为跳过留痕会话（可为空串）。
   */
  | { type: 'skipped'; scheduleId: string; runId: string; sessionId: string }
  /**
   * Runner 在 fire() 内部拿到 sessionId 时主动上报（在 'completed' / 'failed' 之前）。
   * 让 UI 能在 run 还在 running 状态时就拿到 sessionId，"Open session" 按钮即时可用。
   */
  | { type: 'session-bound'; scheduleId: string; runId: string; sessionId: string }
  | { type: 'changed'; scheduleId: string }
  /** in-flight 数量或并发闸门等待队列发生变化。 */
  | { type: 'runtime-state'; snapshot: SchedulerRuntimeSnapshot }
  /** 主进程在标记某个 schedule 下的已完成 run 为已读后广播，让 sidebar 未读 badge 重新拉数。 */
  | { type: 'read'; scheduleId: string }
  /** 主进程在 "Mark all as read" 一次性清掉全部未读后广播；不带 scheduleId,所有 schedule 都受影响。 */
  | { type: 'all-read' }
  /**
   * Scheduler 实例 ready 信号(冷启 / 切账号 relogin 都会发)。
   * 由 main 端在 scheduler.on(...) 全部挂完后 broadcast 一次。
   * 唯一用途:让 renderer 的 schedulesStore 在切账号场景下后台预热 cache(冷启动场景下
   * useSchedules.ensure() 已经在跑 list,'ready' 不会重复触发——store 用 wasReset flag
   * 区分这两种场景)。
   */
  | { type: 'ready' };

export type SchedulerEventType = SchedulerEvent['type'];

// ── Schedule Template Types ──

export type TemplateSource = 'builtin' | 'user' | 'project';

export interface TemplateParameter {
  key: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'select';
  required: boolean;
  default?: string;
  /** type='select' 时的选项。 */
  options?: string[];
  placeholder?: string;
}

export interface TemplateCategory {
  id: string;
  /** i18n key 或显示名。 */
  name: string;
  order: number;
}

/**
 * 模板能力标签，desktop 在模板卡片上渲染为能力 chip。
 * 词表收敛在这里而不是放开 string，让渲染端的图标/文案映射可以被 typecheck 兜住。
 */
export type TemplateCapability = 'worktree' | 'pr' | 'web' | 'params';

export interface ScheduleTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  icon?: string;
  source: TemplateSource;

  prompt?: string;
  cronExpr?: string;
  timezone?: string;
  recurring?: boolean;
  agentKind?: AgentKind;
  model?: string;
  /**
   * 显式选定的供应商(来源)id。undefined / 空 → 回落该 agent 原生默认来源
   * （no-break，与未升级行为字节级一致）；非空才按 catalog RoutingDescriptor 路由。
   * 语义与 desktop `session-provider-store` 的 null 对齐。
   */
  providerId?: string;
  effort?: string;
  /** Codex Fast 模式开关，仅 Codex 有意义。详见 Schedule.fastMode。 */
  fastMode?: boolean;
  useWorktree?: boolean;
  persistentSession?: boolean;
  silentWhenIdle?: boolean;
  notify?: ScheduleNotifyConfig;

  parameters?: TemplateParameter[];
  /** 能力标签（隔离工作区 / PR 自动化 / Web 搜索 / 可自定义），仅影响展示。 */
  capabilities?: TemplateCapability[];

  createdAt?: number;
  updatedAt?: number;
}
