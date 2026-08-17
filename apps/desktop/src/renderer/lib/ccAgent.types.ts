import type { Effort, PermissionMode } from '@/lib/userPreferences.types';
import type { SessionSource } from '../../shared/sessionSource';
import type { TurnUsageDetails } from '../../shared/turnUsageDetails';
import type { RegionalMoney } from '../../shared/regionalMoney';
import type { AutoResumeInfo, RecoveryCheckpoint } from '../../shared/agentInputQueue';
import type { ReviewRunMeta } from '../../shared/reviewRun';
import type { AgentTaskTerminalStatus } from '@cindy/maker-shared/agent-task';

export type SessionStatus = 'active' | 'archived' | 'deleted';
export type WorkspaceKind = 'project' | 'dialogue';
export type DeviceLinkConnectionStatus = 'connected' | 'disconnected';

/**
 * 当前 session 接的是哪个 agent。决定 message.agentMeta 的 JSON 形态。
 * 暂时只有 'cc'（Claude Code）。未来扩展 'codex' 等时新增枚举值即可，
 * schema 不动；老 session DEFAULT 'cc' 兜底。
 */
export type AgentKind = 'cc' | 'codex' | 'pi';
export type MakerVendor = AgentKind | 'orca';
export type OrcaRole = 'lead' | 'worker';

/**
 * Host-side 消息来源标记：标识一条 user 消息是自动化任务注入的，
 * 而非用户手动输入。scheduler runner 落库时写入 agentMeta.origin，
 * renderer 据此在气泡上渲染"由自动化任务发送"标签。
 */
export interface MessageAutomationOrigin {
  kind: 'scheduler';
  scheduleId: string;
  scheduleName?: string;
  runId?: string;
}

/**
 * Claude Code SDK 元信息——按消息类型不同填不同子集。
 *
 *  - 通用字段（user/assistant 都有）：uuid / parentUuid / sdkSessionId
 *  - assistant 专属：model / stopReason / requestId / usage
 *  - result 专属：numTurns / durationMs / totalCostUsd / fastModeState ...
 *
 * uuid 来自 SDK transcript（非 renderer 自造）—— `forkSession.upToMessageId`
 * 只接受 SDK 自己分配的 uuid，所以这是 fork 的唯一主键。
 */
export interface CcMeta {
  uuid?: string;
  parentUuid?: string;
  /** Claude transcript chain parent. Do not confuse with parentUuid, which is parent_tool_use_id. */
  transcriptParentUuid?: string;
  sdkSessionId?: string;

  // assistant 专属
  model?: string;
  stopReason?: string;
  requestId?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
  };

  // result / host turn 边界
  /** Host 在 done 边界写到该 SDK turn 最后一条 assistant 上的持久化收尾标记。 */
  turnCompleted?: boolean;
  numTurns?: number;
  durationMs?: number;
  durationApiMs?: number;
  totalCostUsd?: number;
  fastModeState?: string;
  /** Host-persisted terminal lifecycle for the originating Agent/Task tool call. */
  agentTaskStatus?: AgentTaskTerminalStatus;

  /**
   * Host-side delivery marker. SDKs generally do not echo user steer messages in
   * a form we can rely on, so renderer persistence records whether a visible
   * user bubble was sent as a normal next-turn message or as same-turn 插话.
   */
  delivery?: 'turn' | 'steer';

  /**
   * Host-side origin marker（与 delivery 同类，非 SDK 字段）。
   * scheduler 注入的 user 消息携带；用户手动输入的消息无此字段。
   */
  origin?: MessageAutomationOrigin;

  /**
   * Host-side silent-stop 自动续跑标记(与 delivery 同类,非 SDK 字段)。
   * main 的守卫检测到上游空响应静默收尾后自动补发的「继续」user 消息携带;
   * renderer 据此不渲染用户气泡,改渲染「已自动继续」分隔线(SystemCard),
   * 同时也是 DB/transcript 里每次自动续跑的审计标记。
   */
  autoResume?: boolean;

  /**
   * 这次自动续跑的展示信息（中断原因 + 本轮第几次 + 会话累计）。
   *
   * 只有「中断自愈」路径会带（silent-stop 那条本身没有 error）。renderer 用它渲染
   * 「已重新连接」活动行的 param 位与展开详情——自愈成功时 error 行**不落库**，
   * 所以这是中断原因唯一的用户可见出口。
   */
  autoResumeInfo?: AutoResumeInfo;

  /** Bounded handoff shared by manual Retry and automatic resume. */
  recoveryCheckpoint?: RecoveryCheckpoint;

  /**
   * 这次自动续跑的**结果**,由后续事件回填(见 main 的 markAutoResumeOutcome)。
   * 缺省 = 还在等结果。renderer 据此三态渲染:重新连接中 / 已重新连接 / 未成功。
   */
  autoResumeOutcome?: 'succeeded' | 'failed';

  /**
   * Hook 来源元数据（IM 平台 + 用户干净原文 + 结构化 thread 上下文）。
   * hook session-runner 注入; renderer 据此渲染 Cindy 署名任务卡片
   * (userText 为卡片正文, 与发给 agent 的完整 prompt 分离)。
   */
  hookSource?: { im: string; channelName?: string | null; userText?: string; threadContext?: Array<{ author: string; text: string; isBot?: boolean }> };

  /** 历史 per-turn USD；新数据以 turnCost 为区域金额事实。 */
  turnCostUsd?: number;
  turnCost?: RegionalMoney;
  /** true = Codex token × 价格表折算的估算值; false / 缺省 = SDK 实报。 */
  turnCostIsEstimate?: boolean;
  /** Host-side immutable billing-route classification for this turn. */
  turnCostIsCustomProvider?: boolean;
  /** Provider id captured when this turn completed; null means the default route. */
  turnCostProviderId?: string | null;
  /** 历史用户轮累计 USD；新数据以 userTurnCost 为区域金额事实。 */
  userTurnCostUsd?: number;
  userTurnCost?: RegionalMoney;
  /** 累计值含订阅 token 价值估算时为 true。 */
  userTurnCostIsEstimate?: boolean;
  /** Per-turn token/cache 明细,与 turnCostUsd 同时由 main patch 到 agent_meta。 */
  turnUsageDetails?: TurnUsageDetails;

  /**
   * Host-side 模型降级标记:turn 结束时 main 检测到「所选模型家族在本轮实际
   * modelUsage 里整轮缺席」(上游静默降级,如 fable-5 高负载被路由到 opus-4-8)
   * → patch 到该轮收尾 assistant 的 agent_meta(modelMismatchBroadcaster)。
   * AssistantMessage 据此渲染降级提示行。判定纯函数见 shared/modelMismatch.ts。
   */
  modelMismatch?: { selected: string; actual: string };

  /**
   * device-link host-side marker:被控端为满足单帧上限返回了压缩历史内容。
   * 控制端 merge 时用它避免压缩历史覆盖已通过实时 push 收到的完整内容。
   */
  remoteContentTruncated?: boolean;
  /**
   * device-link host-side marker:被控端裁掉了 messages:list 页的部分行。
   * 控制端分页不能仅因当前页短于 page size 就判定历史到头。
   */
  remoteRowsTrimmed?: boolean;
  remoteOriginalRowCount?: number;

  /**
   * Host-side marker:一条 /goal 达成记录(由 goal-host 在目标 complete 时持久化,
   * role:'assistant' + 空 content)。renderer 据此把这条消息渲成"目标已达成 ·
   * N 轮 · 耗时 X"分隔条(仿 fork divider),而非普通气泡。重开会话仍在(持久 JSON)。
   * 注:此字段只用于消息历史展示,不参与发给模型的 prompt。
   */
  goalCompletion?: {
    turnsUsed: number;
    tokensUsed: number;
    elapsedMs: number;
    reason: string | null;
  };

  /**
   * Host-side marker:一条 /goal 提示记录(目前用于 usageLimited 到点自动续跑时的
   * "用量已恢复,继续目标")。同 goalCompletion,renderer 据此渲成 system card 分隔条,
   * 不进 prompt。
   */
  goalNotice?: 'usage-resumed' | 'capacity-resumed';

  /** /review 创建的独立只读审查任务及其来源卡状态。 */
  reviewRun?: ReviewRunMeta;

  /**
   * Host-side marker:这条 user 消息是一个 /goal 目标的设定 / 更新(goal-host 在新建或
   * 编辑目标时持久化的目标文案)。renderer 据此在该气泡上方渲一个「目标 / 目标已更新」徽标,
   * 让对话里看得出这条是目标。不进 prompt。
   */
  goalObjective?: { updated: boolean };

  /**
   * Host-side marker:一条定时任务「前置检查未放行,本轮已跳过」的留痕记录
   * (scheduler runner 在 preRunHook exit 2 时以 role:'assistant' 持久化,零模型
   * 调用)。renderer 可据此渲染专属跳过样式(胶囊系统消息);不进 prompt。
   */
  scheduleSkip?: {
    scheduleId: string;
    runId: string;
    exitCode: number | null;
    durationMs: number;
  };
}

/**
 * 调用方根据 session.agentKind narrow 到具体 variant。
 * 增加新 agent 时往这个 union 里加一种。
 */
export type AgentMeta = CcMeta;

export interface Session {
  id: string;
  userId: string;
  title: string;
  workingDir: string | null;
  /**
   * 侧边栏/产品归属语义。
   * - project: workingDir 是项目目录, 参与 Projects 分组。
   * - dialogue: workingDir 只是对话运行/文件目录, 不参与 Projects 分组。
   */
  workspaceKind: WorkspaceKind;
  model: string;
  effort: Effort;
  permissionMode: PermissionMode;
  /** per-session 选定的模型供应商来源 id（如 'anthropic' / 'openai' / 'xd'）。null = 跟随默认路由。 */
  providerId?: string | null;
  sdkSessionId: string | null;
  totalTokenUsage: number;
  totalCostUsd: number;
  /** 新版区域累计金额；旧会话仍只带 totalCostUsd。 */
  totalMoney?: RegionalMoney;
  contextTokens: number;
  contextWindow: number;
  fastMode: boolean;
  /**
   * 计划模式一级开关(与 permissionMode 正交):开启时 agent 先产出计划、经审批后再执行。
   * 计划批准后 agent 自动退出并经 plan_mode_changed → sessions:patched 回流为 false。
   * 老 payload(device-link 老被控端)可能缺失 → 消费方按 false 兜底。
   */
  planModeEnabled?: boolean;
  clearedAt: string | null; // ISO 8601 — messages before this timestamp are hidden
  pinnedAt: string | null;  // ISO 8601 — when pinned, null = not pinned
  /**
   * 用户最近一次"按下发送"的时刻（ISO 8601，null = 从未发过）。
   * Sidebar 排序唯一时间轴：null ⟺ 草稿（归未分类），非 null 即按倒序上浮。
   * 与 updatedAt 解耦——改 model/effort/title 等字段不会动它。
   */
  userSendAt: string | null;
  status: SessionStatus;
  /** 当前 session 接的 agent。老 session DEFAULT 'cc'。 */
  agentKind: AgentKind;
  /** 会话来源。scheduler 表示由自动化任务创建；缺失时按 desktop 兼容旧 payload。 */
  source?: SessionSource;
  /** Orca split-session role marker. null/undefined means a regular Maker session. */
  orcaRole?: OrcaRole | null;
  /** fork-session：派生来源会话 id（self-FK，源被删 → SET NULL）。null = 顶层会话。 */
  parentSessionId?: string | null;
  /** fork-session：在源会话哪条 user 消息上发起 fork（仅作溯源信息）。 */
  forkedAtMessageId?: string | null;
  /**
   * interrupted-turn-resume:「疑似中断」判定时间戳(unix ms)。startedAt >
   * endedAt(且 > clearedAt、会话空闲)= 上次任务被 app 退出打断,打开会话时
   * 显示「继续任务 / 忽略」banner。老 payload(device-link 老被控端)可能缺失,
   * 消费方按 null 兜底(不提示)。
   */
  activeTurnStartedAt?: number | null;
  lastTurnEndedAt?: number | null;
  /**
   * worktree-parallel-sessions: 本 session 绑定的 git worktree 绝对路径（null = 无 worktree）。
   * 反范式快照——真 source of truth 是 main 进程 electron-store；DB 字段仅为 sidebar 一次性渲染优化。
   * 删除 worktree 时**不**清此字段（保留历史值）；徽标按 worktree:get-for-session 是否有结果判定。
   */
  worktreePath?: string | null;
  /**
   * project-context 实验功能：本 session 创建时是否注入了 .cindy/project-knowledge/ 内的项目知识。
   * Render 端用此字段决定 sidebar stripe / chat header chip 显示。
   * 升级前已存在的 session 默认 false（不追溯）。
   */
  usedProjectContext?: boolean;
  /**
   * 附加只读引用目录列表(绝对路径)。Claude session 才会真正用到;
   * Codex session 此字段恒为空数组(capability 不支持,UI 不暴露入口)。
   * 未升级到 0019 migration 之前的老 session 反序列化时也是 [],无追溯。
   */
  extraDirs: string[];
  /**
   * Remote codex (P2): 远端 SSH host alias (`@cindy/maker-remote-ssh`
   * ConnectionPool 里的 id)。设置后 codex agent 跑在远端机器, workingDir
   * 是远端路径。null/undefined = 本地。仅 Codex 支持。
   */
  remoteHostId?: string | null;
  /**
   * device-link 跨设备远程控制:本 session 实际归属的**被控设备 deviceId**。
   * 仅存在于控制端**内存**里(由 remoteProjectsStore 注入),**永不落本地 DB**——
   * 从本地 DB 反序列化出来的 session 此字段恒为 undefined。
   * 设置后:sidebar 归到 device-link 远程项目(独立 `device:` 分组键 + 设备 icon),
   * 且所有会话操作经 deviceLink.invoke 透明隧道到该设备,而非本机 IPC。
   * 与 `remoteHostId`(Codex SSH 专用)是**两个互不相干的维度**,不可混用。
   */
  deviceLinkDeviceId?: string;
  /** device-link:被控设备的友好名(sidebar tooltip 展示),与 deviceLinkDeviceId 同源注入。 */
  deviceLinkDeviceName?: string;
  /** device-link:控制端最近一次确认到的连接状态。断线时 session 仍保留在侧边栏缓存里。 */
  deviceLinkConnectionStatus?: DeviceLinkConnectionStatus;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
  _count?: { messages: number };
  /**
   * sidebar-card-mode：最近一条 user/assistant 消息的纯文本摘要（≤140 字符，
   * 换行已折叠）。由 main 进程 mapper.extractMessagePreview 提炼；
   * null = 无可预览消息（空草稿等），渲染端隐藏预览行。
   */
  preview?: string | null;
  /**
   * 任务现状一句话摘要（main/sessionTaskSummary.ts 仅在置顶段为卡片模式时
   * 为置顶会话生成）。卡片置顶行优先展示它，列表/文字模式只用 preview。
   */
  summary?: string | null;
}

// 'error':turn 失败的 terminal error 持久化行(main 的 onTurnErrorEvent 落库)。
// 让"你没开着会话时发生的失败"重开会话 / 重启 app 后仍可见 —— 此前 error 只存
// 内存(coordinator projection + store.error),事后点进会话毫无痕迹,红点无从追溯。
// 'agent_switch':session 内 agent 引擎切换边界行(session-agent-switch,main 落库)。
// content 为 AgentSwitchContent;渲染成分隔条(可展开查看交接摘要),不是对话正文。
export type MessageRole = 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'ask_user' | 'plan_review' | 'thinking' | 'error' | 'agent_switch';

/**
 * role='agent_switch' 行的 content 结构(JSON 存于 messages.content)。
 * handoff 是发给新引擎的交接摘要全文——只用于 UI 展开查看与 debug,
 * 不作为对话正文渲染,也绝不回发给 agent(注入走 main 的 wire 前缀通道)。
 */
export interface AgentSwitchContent {
  fromAgentKind: 'cc' | 'codex' | 'pi';
  toAgentKind: 'cc' | 'codex' | 'pi';
  fromModel: string | null;
  toModel: string | null;
  handoff: string;
  /** Phase 2:true = 目标引擎续接(resume)了自己的停泊原生会话,交接为增量模式。 */
  resumed?: boolean;
}

export interface Message {
  id: string;
  /**
   * SQLite insertion order for DB-backed history rows. Remote controllers use it
   * as the monotonic tie-breaker when multiple rows share the same millisecond.
   */
  rowid?: number;
  clientId: string;
  sessionId: string;
  role: MessageRole;
  content: unknown; // Json — 文本或结构化
  toolUseId: string | null;
  /**
   * SDK 元信息。null 表示：老消息 / pending（user echo 之前）/ 非 SDK 来源消息。
   * 解析时按本行 agentKind（null 时回落所属 session.agentKind）走对应 variant。
   */
  agentMeta: AgentMeta | null;
  /**
   * 产出本行的 agent 引擎（值域同 session.agentKind:'cc' / 'codex'）。
   * session-agent-switch 后 session.agentKind 只代表当前活跃引擎,历史行按本字段解析;
   * null = 切换功能上线前的老消息(回落 session.agentKind)。
   */
  agentKind?: 'cc' | 'codex' | 'pi' | null;
  createdAt: string; // ISO 8601
}
