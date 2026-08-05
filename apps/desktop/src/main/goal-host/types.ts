/**
 * Goal host 共享类型。
 *
 * GoalController 放在 main、只消费 Session 的公共 API,所以这里用 `SessionLike`
 * 把依赖收敛成一个结构子集 —— 真 Session 结构上满足它,单测可注入 fake(规则 14)。
 */

import type {
  AgentEvent,
  AgentKind,
  SendOrigin,
  SessionSendResult,
  UserMessage,
} from '@cindy/maker-core';

/**
 * 目标状态机:
 *  - active        续跑中
 *  - paused        用户打断 / 用户暂停 / rewind / 连续空轮触顶 —— 用户可恢复
 *  - blocked       需人工(审批 / 模型自报 blocked / turn 出错)—— 用户处理后可恢复
 *  - complete      达成(终态)
 *  - budgetLimited 撞 token 预算或轮数上限(**仅当该目标设了对应上限时才可能**;终态)
 *  - usageLimited  账号/套餐用量受限(rate limit / quota),区别于自定预算 —— 非终态,
 *                  到 usageResetAt 自动续跑(或用户手动 resume)
 *
 * 首轮"目标质量自检"不是一个状态:agent 若有顾虑,直接用自带 AskUserQuestion 工具问
 * 用户(走 app 原生交互 UI),目标全程保持 active,无需独立状态。
 */
export type GoalStatus = 'active' | 'paused' | 'blocked' | 'complete' | 'budgetLimited' | 'usageLimited';

/** 终态:不再续跑,且不会被启动 resume 自动恢复。usageLimited **不是**终态(会自动续)。 */
export const TERMINAL_GOAL_STATUSES: ReadonlySet<GoalStatus> = new Set<GoalStatus>([
  'complete',
  'budgetLimited',
]);

/** 账号用量受限信息(由 getAccountLimit 依赖按 agent 读取对应配额快照得出)。 */
export interface AccountLimitInfo {
  limited: boolean;
  /** 限额重置的 unix ms;null = 未知(此时不排自动续跑 timer,留待用户手动 resume)。 */
  resetAtMs: number | null;
}

/**
 * 三个安全护栏上限,**全部可空**(null = 不设该上限)。创建时从 goal-settings-store
 * 读取默认值写进 goal 行;编辑器改上限只改当前 goal 行。
 */
export interface GoalLimits {
  /** 续跑轮数上限;null = 不限轮数。 */
  maxTurns: number | null;
  /** token 预算上限(只按 token,Codex 无 USD);null = 不设预算。 */
  budgetTokens: number | null;
  /** 连续空轮(无 tool_use)上限;null = 不做空轮抑制。 */
  noProgressLimit: number | null;
}

/** Goal 域对象(camelCase),GoalStorage 在 row ↔ 此结构间转换。 */
export interface GoalState {
  sessionId: string;
  objective: string;
  status: GoalStatus;
  /** token 预算上限,可空(null = 不设)。 */
  budgetTokens: number | null;
  /** 续跑轮数上限,可空(null = 不限)。 */
  maxTurns: number | null;
  /** 连续空轮上限,可空(null = 不抑制)。 */
  noProgressLimit: number | null;
  /** 已发起的 goal 续跑轮数。 */
  turnsUsed: number;
  tokensUsed: number;
  /** 连续"无 tool_use(空轮)"计数;有进展(用过工具)即清零。仅 noProgressLimit!=null 时有意义。 */
  noProgressStreak: number;
  /** usageLimited 时记录的限额重置时刻(unix ms);到点自动续跑。其它状态为 null。 */
  usageResetAt: number | null;
  /** 最近一次裁决 / 守卫给出的理由(UI 展示 + resume 续轮提示)。 */
  lastReason: string | null;
  agentKind: AgentKind;
  startedAt: number;
  updatedAt: number;
}

/** 设/替换目标入参(IPC GOAL_SET / 命令 `/goal` → controller.setGoal)。 */
export interface SetGoalInput {
  sessionId: string;
  objective: string;
  /** 留空则由 controller 从活动会话(SessionLike.agentKind)解析。 */
  agentKind?: AgentKind;
  /** 新建时的上限(GUI 新建弹窗的高级设置)。留空 → 走系统默认(getDefaults)。仅新建路径用;编辑改 objective 不动上限。 */
  limits?: GoalLimits;
}

export type GoalUpdatePatch = Partial<{
  objective: string;
  maxTurns: number | null;
  budgetTokens: number | null;
  noProgressLimit: number | null;
}>;

/** 推给 renderer 的扁平状态(GOAL_GET_STATUS 返回 GoalStatusPayload | null)。 */
export interface GoalStatusPayload {
  sessionId: string;
  status: GoalStatus;
  objective: string;
  turnsUsed: number;
  tokensUsed: number;
  maxTurns: number | null;
  noProgressLimit: number | null;
  /** null = 未设预算(renderer 据此只显示已用 token,不显示 "/ 预算")。 */
  budgetTokens: number | null;
  /** usageLimited 时的限额重置时刻(unix ms),供 chip 显示"X 恢复";其它状态 null。 */
  usageResetAt: number | null;
  /** 目标创建时刻(unix ms),供 chip 显示实时运行时长。 */
  startedAt: number;
  lastReason: string | null;
}

/**
 * 状态变化广播给 renderer 的 payload。goal=null 表示该 session 的 goal 已清除
 * (renderer 据此隐藏 GoalIndicator)。
 */
export interface GoalStatusUpdate {
  sessionId: string;
  goal: GoalStatusPayload | null;
}

/**
 * 目标达成时落进对话的持久记录摘要(写进 message.agentMeta.goalCompletion,
 * renderer 据此渲染"目标已达成 · N 轮 · 耗时 X"分隔条,重开会话仍在)。
 */
export interface GoalCompletionSummary {
  turnsUsed: number;
  tokensUsed: number;
  /** 从 setGoal 到达成的总耗时(ms)。 */
  elapsedMs: number;
  reason: string | null;
}

/** Session 的结构子集 —— 真 Session 满足之,fake 实现供单测。 */
export interface SessionLike {
  readonly id: string;
  readonly agentKind: AgentKind;
  send(
    message: UserMessage | string,
    opts?: {
      origin?: SendOrigin;
      planMode?: boolean;
      onAccepted?: () => void | Promise<void>;
      onDispatching?: () => void;
      signal?: AbortSignal;
    },
  ): Promise<SessionSendResult>;
  onEvent(listener: (event: AgentEvent) => void): () => void;
  isTurnRunning(): boolean;
  abort(): Promise<void>;
}

/** GoalStorage 接口 —— controller 只依赖这几个方法,便于 fake。全异步(localDb 是 async proxy)。 */
export interface GoalStorageLike {
  get(sessionId: string): Promise<GoalState | null>;
  upsert(state: GoalState): Promise<void>;
  update(sessionId: string, patch: Partial<GoalState>): Promise<GoalState | null>;
  clear(sessionId: string): Promise<void>;
  listActive(): Promise<GoalState[]>;
  /** 启动 resume 用:取所有 usageLimited 行,重排自动续跑 timer(到点 / 已过点立即续)。 */
  listUsageLimited(): Promise<GoalState[]>;
}

/** GoalController 注入依赖。 */
export interface GoalControllerDeps {
  storage: GoalStorageLike;
  /** ← Maker.getSession(同步只读);未活化返回 undefined。isBusy / attachListener 用。 */
  getSession(sessionId: string): SessionLike | undefined;
  /**
   * 确保会话活着并返回(发轮前用)。已活 → 直接返回;未活 → 按存档 SessionMeta
   * resume 出来(spawn agent 子进程),仿 scheduler 心跳的 resume。无法 resume
   * (无 meta)返回 undefined。这是修"用户开了对话但没发过消息 → getSession 为空 →
   * goal 设了却发不出第一轮"的关键。
   */
  ensureSession(sessionId: string): Promise<SessionLike | undefined>;
  /**
   * 锁住本 session、落实 deferred agent switch 并 bootstrap 新 live session。
   * 调用方在重新读取 live session 且 Session.send 返回后执行 release。
   */
  acquirePendingAgentSwitch?: (sessionId: string) => Promise<() => void>;
  /** ← maker-ipc/register.isSessionInTurn(main 侧 turn 活跃跟踪)。 */
  isSessionInTurn(sessionId: string): boolean;
  /**
   * 清除目标时中断由 GoalController 发起的当前 turn。生产环境接到 input coordinator
   * 的 Stop 边界，以便 vendor abort、输入队列和迟到终态事件一起收口。
   */
  stopActiveGoalTurn(sessionId: string): void;
  beforeDispatchUserTurn?: (sessionId: string) => void | Promise<void>;
  onUndispatchedUserTurn?: (sessionId: string) => void;
  /** 状态变化广播到 renderer(→ GOAL_STATUS_CHANGED);goal=null 表示已清除。 */
  emitStatus(update: GoalStatusUpdate): void;
  /**
   * 读当前"系统默认 + 用户 override"合并后的护栏默认(来自 goal-settings-store)。
   * 新建 goal 时读取最新值(规则 20)。
   */
  getDefaults(): GoalLimits;
  /**
   * 预留给未来 settings UI:写 goal-settings override(更新下次默认)。
   * 当前 goal 创建/编辑流程不调用;编辑器改上限只影响当前 goal 行。
   */
  persistGoalSettingsOverride?: (limits: GoalLimits) => void;
  logger: { info(msg: string, meta?: unknown): void; warn(msg: string, meta?: unknown): void; error(msg: string, meta?: unknown): void };
  /** 可注入时钟(默认 Date.now);测试用确定性时间。 */
  now?: () => number;
  /** 续跑前的防抖毫秒(默认 150;测试传 0 取消异步等待)。 */
  continuationDebounceMs?: number;
  /**
   * 持久化一条 goal 发起的 user 消息(注入 createMessage)。仅**首轮**用它落一条
   * 干净的目标文案,让对话有连贯起点;续轮不落(助手自然接着写,贴近 Codex 体验)。
   * 发给模型的仍是完整 directive(含裁决约定),与落库文案分离(仿 scheduler silent-instruction)。
   */
  persistUserMessage?: (
    sessionId: string,
    content: string,
    opts?: { goalObjective?: { updated: boolean } },
  ) => Promise<void>;
  /**
   * 持久化一条 goal 达成记录(注入 createMessage,role:'assistant' + agentMeta.goalCompletion)。
   * complete 收尾时调用 → 对话里留一条"目标已达成"分隔记录,然后删 goal 行(chip 消失)。
   * 与 persistUserMessage 对称:首轮落目标文案,完成落达成记录。
   */
  persistGoalCompletion?: (sessionId: string, summary: GoalCompletionSummary) => Promise<void>;
  /**
   * 读某 agent 当前账号用量是否受限 + 何时重置(主动检测)。注入端读对应配额快照:
   * codex → readCodexAccountUsageSnapshot(rateLimitReachedType / resetsAt);
   * claude → readClaudeAccountUsageSnapshot(spend>=maxBudget / budgetResetAt)。
   * 返回 null = 拿不到快照(按"未受限"处理)。
   */
  getAccountLimit?: (agentKind: AgentKind) => Promise<AccountLimitInfo | null>;
  /**
   * 持久化一条 goal 提示记录(注入 createMessage,role:'assistant' + agentMeta.goalNotice)。
   * 目前用于 usageLimited 到点自动续跑时落一条"用量已恢复,继续目标"。
   */
  persistGoalNotice?: (
    sessionId: string,
    kind: 'usage-resumed' | 'capacity-resumed',
  ) => Promise<void>;
}
