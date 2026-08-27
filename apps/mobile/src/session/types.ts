import type { MobileSessionAgentSwitchIntent } from '@cindy/maker-shared/device-link-contract';
import type { AgentInputReference } from '@cindy/maker-shared/agent-input-projection';
import type { RemoteMoney } from '@/session/remoteMoney';

export type RemoteSessionStatus = 'active' | 'archived' | 'deleted';
export type RemoteMessageRole =
  | 'user'
  | 'assistant'
  | 'tool_use'
  | 'tool_result'
  | 'ask_user'
  | 'plan_review'
  | 'thinking'
  | 'system'
  // turn 失败终态的持久化行(desktop main 落库,content = { message, reason? });
  // messageNormalize 解析出 message 文案按 system 样式展示,避免显示生 JSON。
  | 'error'
  // session-agent-switch 边界行(desktop main 落库,content = { fromAgentKind,
  // toAgentKind, fromModel, toModel, handoff });messageNormalize 派生成
  // 'agent-switch' 系统卡,避免显示生 JSON。
  | 'agent_switch';

export interface RemoteSession {
  id: string;
  userId: string;
  title: string;
  workingDir: string | null;
  worktreePath?: string | null;
  workspaceKind: 'project' | 'dialogue';
  model: string;
  /** 被控端落盘的来源(供应商)选择,null = 默认路由。用于会话内模型下拉高亮当前来源。 */
  providerId?: string | null;
  effort: string;
  permissionMode: string;
  fastMode: boolean;
  /** Temporary host runtime route; optional for older controlled Desktop versions. */
  runtimeGeneration?: number;
  runtimeBaseline?: RemoteSessionRuntimeProfile;
  runtimeEffective?: RemoteSessionRuntimeProfile;
  runtimePending?: RemoteSessionRuntimePending | null;
  /** 计划模式一级开关(#494,与 permissionMode 正交)。被控端 sessionToCamel 带出,
   *  一次性消耗(plan_mode_changed)后经 sessions:patched 回流置 false;老被控端缺省。 */
  planModeEnabled?: boolean;
  extraDirs?: string[];
  sdkSessionId?: string | null;
  /** 远端 SSH 会话的 host id(被控端 mapper 原样透出);排队消息 createOpts 需要
   *  带上——lazy-create 缺它会把远端 workingDir 当本地路径(对齐桌面 sendUiTrigger)。 */
  remoteHostId?: string | null;
  totalTokenUsage?: number;
  totalMoney?: RemoteMoney;
  /** 旧 Desktop / USD 账本兼容字段。 */
  totalCostUsd?: number;
  contextTokens?: number;
  contextWindow?: number;
  clearedAt?: string | null;
  /** interrupted-turn-resume:「疑似中断」判定的两个 unix ms 时间戳(被控端 mapper
   *  原样透出,startedAt > endedAt 且未被 /clear 越过 = 上次 turn 因应用退出被中断,
   *  见桌面 sessionActiveTurn.ts)。老被控端缺省 → 判定恒不命中,banner 不出现。 */
  activeTurnStartedAt?: number | null;
  lastTurnEndedAt?: number | null;
  status: RemoteSessionStatus;
  agentKind: 'cc' | 'codex' | 'pi';
  /** main 进程内的下一条消息跨 Agent 切换意图；null = 已确认没有。 */
  agentSwitchIntent?: MobileSessionAgentSwitchIntent | null;
  source?: string;
  orcaRole?: 'lead' | 'worker' | string | null;
  parentSessionId?: string | null;
  forkedAtMessageId?: string | null;
  pinnedAt?: string | null;
  userSendAt: string | null;
  createdAt: string;
  updatedAt: string;
  deviceLinkDeviceId?: string;
  deviceLinkDeviceName?: string;
  // 展示用规范设备 id(设备归并结果,由 remoteSessionStore 计算)。deviceLinkDeviceId 保持物理路由 key。
  canonicalDeviceId?: string;
  _count?: { messages: number };
  /** device-link 会话列表带的最近一条 user/assistant 消息纯文本预览(桌面 sessionToCamel 产出,
   *  已处理 clearedAt / rewind),供首页 idle 会话直接显示,无需 load 完整消息。 */
  preview?: string | null;
  /** client-local:冷启动由首页快照缓存种入的行(remoteSessionStore.hydrateDeviceSessionsIfEmpty
   *  打标)。缓存行字段经瘦身/截断,只能用于列表渲染与跳转,不能作为发送参数——会话页在
   *  fresh 元数据(getSession→upsert)到达前据此禁发。fresh 对象来自服务器,天然无此标记。 */
  cacheSeeded?: boolean;
  /** client-local:新建会话乐观管线合成的行(newSessionCreation 打标)。被控端
   *  createSession 还没确认,会话页据此禁发(输入可编辑存草稿)、syncSession 守卫
   *  跳过 NOT_FOUND。fresh 对象来自服务器,天然无此标记,权威 upsert 后自净。 */
  pendingLocalCreation?: boolean;
}

export interface RemoteSessionRuntimeProfile {
  agentKind: 'claude-code' | 'codex' | 'pi';
  model: string;
  providerId: string | null;
  effort: string | null;
  fastMode: boolean;
}

export interface RemoteSessionRuntimePending {
  generation: number;
  source: 'agent' | 'fallback';
  profile: RemoteSessionRuntimeProfile;
}

export interface RemoteMessage {
  id: string;
  clientId: string;
  sessionId: string;
  /** SQLite insertion order from the host; absent on legacy/synthetic rows. */
  rowid?: number;
  role: RemoteMessageRole;
  content: unknown;
  toolUseId: string | null;
  agentMeta: Record<string, unknown> | null;
  createdAt: string;
  systemCardData?: Record<string, unknown>;
  systemCardType?: 'help' | 'context' | 'cost' | 'pwd' | 'status' | 'compact' | 'cmd' | 'goal-complete' | 'goal-resumed' | 'auto-resume' | 'learn' | 'agent-switch';
}

export type RemoteAttachmentCategory = 'image' | 'pdf' | 'text' | 'office';

export interface RemoteFileRef {
  name: string;
  path: string;
  size?: number;
  sha256?: string;
}

/**
 * 图片引用的判别联合:编译期强制「originalName / name 至少存在其一」——两个都缺的
 * 引用会被桌面 renderer 的 coerceImageRef 运行时静默丢弃(手机贴图桌面不显示,
 * 2026-07 实踩),可选+可选的写法挡不住这种回归。
 * - originalName:桌面 ImageRef schema 的原始文件名字段,新写入必须用它;
 * - name:旧版手机端 persist 用的字段名,仅为读取存量数据保留,读侧两端均兼容。
 */
export type RemoteImageRef =
  | {
      url: string;
      originalName: string;
      name?: string;
      mimeType?: string;
      size?: number;
      sha256?: string;
    }
  | {
      url: string;
      originalName?: never;
      name: string;
      mimeType?: string;
      size?: number;
      sha256?: string;
    };

export interface RemoteSerializedAttachment {
  id: string;
  name: string;
  path: string;
  ext: string;
  size: number;
  sha256?: string;
  category: RemoteAttachmentCategory;
  mimeType: string;
  url?: string;
  originalName?: string;
  base64?: string;
  textContent?: string;
  truncated?: boolean;
  /**
   * 图片带用户手绘圈点标注(lightbox 标注模式的烧录产物)。字段随 wire 契约
   * 原样透传到被控端(materializeQueuedOssAttachments 只改写 url/path),桌面
   * 端 buildMakerUserMessage 据此给模型注入「红色笔迹是用户标注」的固定说明,
   * 与桌面 AgentInputSerializedFile.annotated 同一契约。
   */
  annotated?: boolean;
}

export interface QueuedRemoteMessage {
  clientId: string;
  text: string;
  persistedContent: string;
  files?: RemoteSerializedAttachment[];
  agentReferences?: AgentInputReference[];
  model: string;
  effort: string;
  permissionMode: string;
  workingDir: string;
  vendorOptions?: Record<string, unknown>;
  /** 会话深链的定位信息；真实正文由手机控制端从来源桌面读取后固化为可信快照。 */
  sessionRefs?: import('@/session/sessionReferences').MobileSessionReference[];
  /** 仅跨 device-link 入站使用；目标桌面投影回手机前会剥离其中的历史正文。 */
  trustedSessionReferenceContexts?: import('@/session/sessionReferences').MobileSessionReferenceContext[];
  /** 与桌面队列契约镜像；目标桌面据此禁止缺失快照时按自己的设备坐标重解引用。 */
  sessionReferencesRequireTrustedSnapshot?: boolean;
  userName?: string;
  createOpts: {
    agentKind: 'claude-code' | 'codex' | 'pi';
    workingDir: string;
    model: string;
    effort?: string;
    permissionMode?: string;
    fastMode?: boolean;
    displayReasoning?: string;
    resumeSessionId?: string;
    makerMemoryEnabled?: boolean;
    vendorOptions?: Record<string, unknown>;
    remoteHostId?: string;
    extraDirs?: string[];
    [key: string]: unknown;
  };
  chatMessage: {
    clientId: string;
    role: 'user';
    content: string;
    files?: RemoteFileRef[];
    images?: RemoteImageRef[];
    quotesEncoded?: boolean;
    pastedTextRanges?: Array<{ start: number; end: number; display: string }>;
    slashCommandRanges?: Array<{ start: number; end: number }>;
    isStreaming?: boolean;
    createdAt: string;
  };
  origin?: Record<string, unknown>;
}

/**
 * Whether the host projection can identify the owner of an in-flight continuation turn.
 * `legacy` is reserved for projections that omit the field entirely; an explicit `null`
 * is a supported projection with no continuation owner.
 */
export type ContinuationInFlightProjectionCapability = 'unknown' | 'legacy' | 'supported';

export interface InputProjection {
  sessionId: string;
  pendingQueue: QueuedRemoteMessage[];
  steeringQueueClientIds: string[];
  queuePaused: boolean;
  queueExpanded: boolean;
  queueInteractionLocks: string[];
  queueEditLocks: string[];
  queueAbortPending: boolean;
  error: string | null;
  recovery?: unknown;
  errorRetryText: string | null;
  autoResumePending?: Record<string, unknown> | null;
  /** Current vendor-turn owner for an auto-resume continuation, when supported by the host. */
  continuationTurnClientId?: string | null;
  /** Capability marker kept distinct from an explicit `continuationTurnClientId: null`. */
  continuationInFlightProjectionCapability?: ContinuationInFlightProjectionCapability;
  /**
   * 凭证切换等待态(对齐桌面 AgentInputProjection.credentialSwitchWait):发送需要
   * 重启共享 Codex 进程,但其它本地 Codex 任务在跑;消息保留在队首,挡路任务结束后
   * 桌面端自动重发。null / 缺省 = 无等待。历史上手机端读侧丢弃该字段,消息卡在队首
   * 却无任何解释(2026-07 排查发现)。
   */
  credentialSwitchWait: { clientId?: string; blockedBySessionIds: string[] } | null;
}

export interface PendingInteraction {
  request: {
    kind?: string;
    requestId?: string;
    [key: string]: unknown;
  };
  persistId?: string;
}
