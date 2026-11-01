/**
 * 伙伴自主跟进：主进程与渲染层共用的契约。
 *
 * 三层：
 * - 层 0 宿主观察（程序级，不经模型）：把本机与已授权在线电脑上的全部任务放进一张状态表，
 *   并在「卡住 / 等你 / 出错 / 用量上限 / 做完」时发布 `host:sessions` 事件到例行任务引擎。
 * - 层 1 每个伙伴的被动跟进：只对自己开的任务收到事件；内置的「跟进」例行任务被叫醒后用轻量
 *   摘要工具读任务，再决定继续 / 代答 / 换模型 / 汇报 / 更新待办。
 * - 层 2 唯一总调度伙伴：账号内最多一个（默认关闭，用户选择开启）；收全设备全任务事件，推送主人，
 *   其它伙伴开的任务默认只看不跟。
 *
 * 规则正文见 docs/product-rules/cindy-bots-runtime.md §6.3 与 docs/product-rules/bot-routines.md。
 */

/** 事件源 id；在引擎每次创建后由宿主重新登记。 */
export const HOST_SESSIONS_SOURCE_ID = 'host:sessions';
/** Host-started routines are not the owner's standing instructions. */
export const BUILTIN_ROUTINE_SCHEDULE_PREFIX = 'routine-builtin-';

/** 内置跟进例行任务的 id 前缀；完整 id 由主进程 builtinRoutine.ts 的 builtinFollowUpRoutineId 生成，幂等。 */
export { BUILTIN_FOLLOW_UP_ROUTINE_PREFIX } from '@cindy/companion-core/routines';

/** 内置「每天查待办」例行任务的 id 前缀；主人在近况里打开时才建，完整 id 见 todoCheckRoutine.ts。 */
export { BUILTIN_TODO_CHECK_ROUTINE_PREFIX } from '@cindy/companion-core/routines';

/** 出厂 Cindy 助理的稳定 id；仅用于邀请入口，不意味着已开启自动跟进。 */
export const DEFAULT_SCHEDULER_BOT_ID = 'cindy-default';

/** 程序级阈值（内部常量，不进设置）。 */
export const AUTONOMY_THRESHOLDS = {
  /** 运行中但无任何活动达到这么久 → stuck。 */
  stuckAfterMs: 10 * 60_000,
  /**
   * 前台工具调用在途（tool_use 已发、tool_result 未回，例如一次长构建）时没有任何活动事件，
   * 用更长的阈值判 stuck，避免把健康的长工具调用当成卡住。
   */
  stuckInToolAfterMs: 45 * 60_000,
  /** 等权限 / 等回答达到这么久 → waiting（主人不在时伙伴代答或提醒）。 */
  waitingAfterMs: 5 * 60_000,
  /** 同一任务同一类事件 24h 内最多发布次数，防止伙伴与任务互相推着打转。 */
  maxEventsPerSessionPerDay: 6,
  /** 远程电脑状态轮询间隔（仅有在线且已授权的电脑时才轮询）。 */
  remotePollMs: 60_000,
  /**
   * 条件兜底间隔：某伙伴还有待处理的任务（等你 / 出错 / 用量上限 / 卡住）且距它上次被叫醒已这么久，
   * 宿主发一条 `sweep` 事件叫醒它；没有待处理任务的伙伴不会被白叫醒。
   */
  fallbackIntervalMs: 2 * 60 * 60_000,
} as const;

export type WatchedPhase =
  | 'running'
  | 'waiting-permission'
  | 'waiting-answer'
  | 'errored'
  | 'usage-limit'
  | 'finished'
  | 'idle';

export type WatchedSource = 'user' | 'bot-task' | 'routine' | 'other';

/** Captured at the activity boundary; persisted events must not sample a later turn. */
export interface BotAutonomyExecution {
  instanceId: string;
  generation: number;
}

/** 状态表里的一行。远程任务的 `sessionId` 带 `deviceId::` 前缀，与历史工具一致。 */
export interface WatchedSession {
  sessionId: string;
  deviceId: string | null;
  deviceName: string | null;
  /** 远程电脑是否在线；本机恒为 true。离线电脑的行保留最后一次已知状态。 */
  online: boolean;
  title: string;
  workingDir: string | null;
  phase: WatchedPhase;
  /** 进入当前 phase 的时刻（ms）。同一 (phase, phaseSince) 只发布一次事件。 */
  phaseSince: number;
  lastActivityAt: number;
  startedAt: number | null;
  execution?: BotAutonomyExecution;
  /** 等回答 / 等权限时的一句摘要（≤ 140 字），否则 null。 */
  pendingQuestion: string | null;
  /**
   * 等权限时挂起请求的 id（工作台「允许」只回应这一条）；其它情况 null / 缺省。
   * （实现者 A 新增，可选字段。）
   */
  pendingRequestId?: string | null;
  /** 挂起交互自身的 id（任何种类）：只用来认出同一相位里换成了另一条请求，不用于批准。 */
  pendingInteractionId?: string | null;
  /**
   * 本机任务当前有前台工具调用在途（只是布尔事实，不含工具名与入参）；远程与缺省为 false。
   * stuck 判定据此改用 `stuckInToolAfterMs`。（实现者 A 新增，可选字段。）
   */
  toolInFlight?: boolean;
  /**
   * 这件任务是哪个伙伴自己的主任务（canonical）；不是则 null / 缺省。伙伴自己的主任务永远不是它自己的
   * 事件对象，也不出现在它自己的工作台；总调度是另一个伙伴时照常看到、照常跟。（实现者 A 新增，可选字段。）
   */
  canonicalOfBotId?: string | null;
  error: string | null;
  /**
   * 出错时 runtime 给的稳定原因(如 tool_use_loop_detected),不含原文;没有就是 null / 缺省。
   * 只用来判断换模型能不能解决,不展示给伙伴。
   */
  errorReason?: string | null;
  /** 哪个伙伴开的这件任务（bot_delegations / task-responsibility），没有就是 null。 */
  creatorBotId: string | null;
  /**
   * 谁在跟：creator 优先；creator 不存在 / 暂停时，若该伙伴允许总调度代跟则落到总调度；
   * 无 creator 的任务直接落到总调度；没有总调度时为 null（只进工作台看，没人叫醒）。
   * 另一台电脑上的任务恒为 null：每台电脑上的任务由那台电脑上的伙伴跟，这里只进工作台看。
   */
  followerBotId: string | null;
  source: WatchedSource;
  /**
   * 共享给访客的任务（来源 shared）：里面有账号外的人发的话。不叫醒任何伙伴、不让伙伴自动继续，只进工作台给主人看。
   */
  shared?: boolean;
}

/** `sweep`：条件兜底（按伙伴、不针对单个任务；subject 为伙伴 id，任务字段为空串）。 */
export type AutonomyEventType = 'stuck' | 'waiting' | 'errored' | 'usage-limit' | 'finished' | 'sweep';

export const AUTONOMY_EVENT_TYPES: readonly AutonomyEventType[] = [
  'stuck',
  'waiting',
  'errored',
  'usage-limit',
  'finished',
  'sweep',
];

/** `RoutineEvent.data` 的扁平字段（引擎要求 string|number|boolean）。 */
export interface AutonomyEventData {
  /** Optional for queues saved before execution attribution was introduced. */
  executionInstanceId?: string;
  executionGeneration?: number;
  sessionId: string;
  deviceId: string;
  deviceName: string;
  title: string;
  /** `sweep` 事件为空串。 */
  phase: WatchedPhase | '';
  /** 处于当前状态多少分钟（取整）。 */
  minutes: number;
  question: string;
  error: string;
  creatorBotId: string;
  followerBotId: string;
  /** 24h 内该任务同类事件已发布次数（含本次）。 */
  occurrence: number;
}

export function autonomyEventId(type: AutonomyEventType, sessionId: string, phaseSince: number): string {
  return `${type}:${sessionId}:${phaseSince}`;
}

/** 账号级设置：只存 override。 */
export interface BotAutonomySettings {
  /** 「自动跟进所有任务」归谁；null = 没有总调度。未自定义时关闭。 */
  schedulerBotId: string | null;
}

/**
 * 设置读写的返回（渲染层视图）：有效值 + 是否自定义 + 当前版本默认值。
 * 「恢复默认」= 删除 override（`resetSettings`），不是写一份等于默认的快照。
 * （实现者 C 新增。）
 */
export interface BotAutonomySettingsView {
  schedulerBotId: string | null;
  isCustomized: boolean;
  defaults: BotAutonomySettings;
}

/** 每伙伴能力位（存 capabilities_json）。 */
export interface BotAutonomyCapabilities {
  /** 它开的任务是否也交给总调度跟（默认 false：别的伙伴开的任务总调度只看不跟）。 */
  allowSchedulerFollow?: boolean;
}

/** 工作台「一眼」投影。 */
export type GlanceKind = 'waiting' | 'working';

export interface GlanceRow {
  sessionId: string;
  deviceId: string | null;
  deviceName: string | null;
  online: boolean;
  title: string;
  kind: GlanceKind;
  /**
   * 状态表里的当前 phase（在做里区分运行中与撞上用量上限）。本版宿主总会填；远程较旧版本的宿主
   * 经设备互联返回的行没有它，所以是可选字段。
   */
  phase?: WatchedPhase;
  /** 等了 / 做了多少分钟。 */
  minutes: number;
  /** waiting 行：等什么（问题或权限一句话）。 */
  question: string | null;
  /** waiting 行：等的是权限还是回答。 */
  waitingFor: 'permission' | 'answer' | 'error' | null;
  /** 哪个伙伴在跟（显示小头像用），null = 没人跟。 */
  followerBotId: string | null;
  /**
   * waiting 行（waitingFor = 'permission'）：挂起的权限请求 id。渲染层「允许」只回应这一条，
   * 请求已被换掉时不替主人批准新的那条（改为去任务里看）。缺省时按该任务当前唯一的权限请求处理。
   * （实现者 C 新增，可选字段，不改已有字段语义。）
   */
  requestId?: string | null;
}

export interface BotGlance {
  botId: string;
  /** 总调度伙伴看全设备全任务；其它伙伴只看自己开的任务。 */
  scope: 'all' | 'own';
  waiting: GlanceRow[];
  working: GlanceRow[];
  /** 上次程序级扫描时刻。 */
  lastSweepAt: number;
  /** 今天（本地日）做完的任务数。 */
  doneToday: number;
  /** 离线电脑（名字），用于底部一句话。 */
  offlineDevices: string[];
}

export const BOT_AUTONOMY_IPC = {
  glance: 'local-db:bots:autonomy:glance',
  settingsGet: 'local-db:bots:autonomy:settings-get',
  settingsSet: 'local-db:bots:autonomy:settings-set',
  /** 删除 override，跟随当前版本默认（实现者 C 新增，需 A 落地）。 */
  settingsReset: 'local-db:bots:autonomy:settings-reset',
  /** push：状态表或设置变化（节流 ≤ 1 次/秒）。payload: { botIds?: string[] } */
  changed: 'maker:bot-autonomy:changed',
} as const;
