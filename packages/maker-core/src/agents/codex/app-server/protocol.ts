/**
 * Codex app-server JSON-RPC 协议 — TypeScript 类型层。
 *
 * 仅手写 maker-core 实际用到的子集 (Phase 1: initialize + thread/start + turn/start +
 * turn/interrupt + 7 类核心 Notification)。Phase 2/3 再补 ServerRequest (approval) /
 * ThreadResume / ThreadFork / ThreadRollback。
 *
 * 真值参考 (只读, 不要在这边猜):
 *   - E:\AIWork\codex\codex-rs\app-server-protocol\src\jsonrpc_lite.rs
 *     ↑ 注意: Codex 的 JSON-RPC **不**发 jsonrpc: "2.0" 字段
 *   - E:\AIWork\codex\codex-rs\app-server-protocol\src\protocol\v1.rs (Initialize)
 *   - E:\AIWork\codex\codex-rs\app-server-protocol\src\protocol\v2.rs (Thread/Turn/Item)
 *   - E:\AIWork\codex\codex-rs\app-server-protocol\src\protocol\common.rs:1406-1487 (Notification 方法名表)
 */

import type {
  AccountCreditsSnapshot,
  AccountRateLimitsResponse,
  AccountRateLimitSnapshot,
  AccountRateLimitWindow,
  ConsumeAccountRateLimitResetCreditParams,
  ConsumeAccountRateLimitResetCreditResponse,
} from '../../../types/account-rate-limits.js';

// ── JSON-RPC envelope (字段对齐 Rust JSONRPCRequest/Notification/Response/Error) ──

/** 自增 id 我们用 number; Rust 那边 RequestId 是 string|number untagged。 */
export type JsonRpcId = number | string;

export interface JsonRpcRequest {
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccessResponse {
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcErrorResponse {
  id: JsonRpcId;
  error: JsonRpcErrorObject;
}

/** 入站消息的三类区分 (无 jsonrpc 字段, 仅靠 id/method/result/error 判别)。 */
export type IncomingMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcSuccessResponse
  | JsonRpcErrorResponse;

// ── JSON-RPC 错误码 (Rust app-server 自定义) ──────────────────────────────────

export const JSONRPC_ERROR_CODE = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  /** Codex 自定义 — 模型 overloaded。 */
  OVERLOADED: -32001,
} as const;

// ── Initialize (v1.rs) ───────────────────────────────────────────────────────

export interface ClientInfo {
  name: string;
  title?: string;
  version: string;
}

export interface InitializeCapabilities {
  /**
   * 必须 true 才能拿到 v2 thread/turn/item.* 的 experimental 字段
   * (我们重度依赖, 默认开)。
   */
  experimentalApi?: boolean;
  /**
   * 告诉 server: 这些 notification 别推 (省带宽 + 主线程压力)。
   * Rust 默认会过滤一批 delta — 我们 Phase 1 也跟着过, 后续要消费 delta 再去掉对应项。
   */
  optOutNotificationMethods?: string[];
}

export interface InitializeParams {
  clientInfo: ClientInfo;
  capabilities?: InitializeCapabilities;
}

export interface InitializeResponse {
  userAgent: string;
  /** server 端 $CODEX_HOME 绝对路径。 */
  codexHome: string;
  platformFamily?: string;
  platformOs?: string;
  /** 其余字段不消费, 用 unknown 兜底防 schema 漂移。 */
  [k: string]: unknown;
}

// ── ModelList (v2.rs) ───────────────────────────────────────────────────────

/**
 * `model/list` 返回的单个运行时模型。这里只维护 desktop 动态目录需要的字段子集；
 * app-server 后续增加字段时由结构化类型自然忽略，避免把整份生成协议复制进 maker-core。
 */
export interface CodexModelListItem {
  id: string;
  /** 真正传给 turn/thread 的模型 slug；当前通常与 id 相同。 */
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  supportedReasoningEfforts: Array<{
    reasoningEffort: ReasoningEffort;
    description: string;
  }>;
  defaultReasoningEffort: ReasoningEffort;
  additionalSpeedTiers: string[];
  serviceTiers: Array<{ id: string; name: string; description: string }>;
  isDefault: boolean;
  [k: string]: unknown;
}

export interface CodexModelListParams {
  cursor?: string | null;
  limit?: number | null;
  includeHidden?: boolean | null;
}

export interface CodexModelListResponse {
  data: CodexModelListItem[];
  nextCursor: string | null;
}

// ── ThreadStart / TurnStart / TurnInterrupt (v2.rs) ───────────────────────────

/**
 * Codex 的 approval 策略 — v2.rs `#[serde(rename_all = "kebab-case")]`
 * + UnlessTrusted 显式 rename 'untrusted'。**注意是 kebab-case 不是 camelCase**,
 * 错了 server 直接 -32600 Invalid request。
 */
export type AskForApproval = 'untrusted' | 'on-request' | 'on-failure' | 'never';

/** Codex app-server approval reviewer. */
export type ApprovalsReviewer = 'user' | 'auto_review' | 'guardian_subagent';

/**
 * sandbox 模式 — v2.rs `#[serde(rename_all = "kebab-case")]`。
 * 同上, kebab-case 不是 camelCase。
 */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

/**
 * 推理 effort — codex_protocol::openai_models::ReasoningEffort
 * `#[serde(rename_all = "lowercase")]` (注意是全小写不是 kebab/camel),
 * `XHigh → "xhigh"` 而不是 "x-high"; 同理 `Max → "max"`、`Ultra → "ultra"`。
 *
 * max / ultra 是较新档 (GPT-5.6 Sol 等), server 按模型的 supported_reasoning_levels
 * 决定是否接受; 不支持的模型仍只到 xhigh。这里放开为全集, 由目录 efforts + UI 门控
 * 保证只对声明支持的模型透传 (不做全局硬塞)。
 *
 * 协议层只有 turn/start 接 `effort: Option<ReasoningEffort>` (v2.rs:5800);
 * thread/start 不接 effort (走 server config 默认), 想让 first turn 用用户选的
 * effort, 必须在 first turn/start 透传。
 */
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';

/**
 * 推理 summary 偏好 — codex_protocol::config_types::ReasoningSummary
 * `#[serde(rename_all = "lowercase")]`, 默认 'auto' (跟 OpenAI Responses API 默认一致)。
 *
 * 协议层在 turn/start (v2.rs:5801-5803) 接 summary 字段, 设置后会 override 用户
 * ~/.codex/config.toml 的 model_reasoning_summary, 持续到后续 turn。我们启动 codex
 * 时强制传 'auto' — 不依赖用户配置, 让 reasoning 流式输出和 claude code 一致。
 *
 * 'none' = OpenAI 不返 summary (UI 看不到 thinking 文本); 不要传这个。
 */
export type ReasoningSummary = 'auto' | 'concise' | 'detailed' | 'none';

/**
 * Codex service tier — v2.rs ServiceTier.
 * Most app-server builds use the semantic value "fast"; some builds echo the
 * OpenAI Responses API value "priority" back in responses for the same mode.
 * 'default' = 显式 standard 档:关 Fast 后 server 在 thread/settings/updated 通知里
 * 实际回带的就是这个值 (实测 0.142.0, 切到不支持 fast 的模型时 serviceTier→'default')。
 */
export type ServiceTier = 'default' | 'fast' | 'priority' | 'flex';

export interface ThreadStartParams {
  /** 缺省走 server 端 config 的默认 model。 */
  model?: string;
  /**
   * 覆盖本 thread 的 model provider(config `model_providers` 里的 key)。
   * 缺省走 config 顶层 model_provider。用于订阅直连 thread 选 OpenAI 身份
   * provider(开远端压缩);provider 身份是 thread 级冻结,settings/update 改不了。
   */
  modelProvider?: string;
  cwd?: string;
  approvalPolicy?: AskForApproval;
  /** Route interactive approvals to the user or Codex's built-in reviewer. */
  approvalsReviewer?: ApprovalsReviewer;
  sandbox?: SandboxMode;
  /** Fast mode override. Undefined = 不覆盖; null = 清空/standard; 'fast' = Fast mode. */
  serviceTier?: ServiceTier | null;
  /**
   * 替换 codex 默认 base prompt (codex-rs/protocol/src/prompts/base_instructions/default.md)。
   * 谨慎使用 — 会覆盖 codex 自带的 persona / AGENTS.md spec / tool 说明,
   * 一般场景请改用 developerInstructions(append 而非 replace)。
   */
  baseInstructions?: string;
  /**
   * 在 codex 默认 base 之后追加 developer message。等价于 Claude 的
   * `systemPrompt.append`,host 产品级 prompt 走这里注入。
   */
  developerInstructions?: string;
  /**
   * EXPERIMENTAL. Dynamic tools exposed to the model for this thread.
   * Present in Codex app-server 0.135.0 `generate-ts --experimental` output
   * for thread/start only; resume/fork do not currently accept this field.
   */
  dynamicTools?: DynamicToolSpec[] | null;
  /**
   * Codex 协议是 per-thread 设这些, 不是 per-turn。后续 setModel/setEffort
   * 在我们这边记 mutable, 下一个 turn 通过 turn/start 透传 (Codex app-server
   * 当前 turn/start 也接 model 覆盖)。
   */
  [k: string]: unknown;
}

export interface ThreadStartResponse {
  thread: { id: string; [k: string]: unknown };
  model: string;
  modelProvider: string;
  cwd: string;
  serviceTier?: ServiceTier | null;
  [k: string]: unknown;
}

/**
 * Codex UserInput — v2.rs:6006 `#[serde(tag = "type", rename_all = "camelCase")]`
 *
 * 关键字段名 (踩坑后定稿, 不是猜的):
 *  - Image.url   字段名是 `url`, 不是 `imageUrl` (即使 core 内部叫 image_url)
 *  - LocalImage.path: 本地文件用这个变体, 字段名 `path` (绝对路径裸字符串, 不带 file:// 前缀)
 *
 * 本地图像附件 → LocalImage; 远程 http(s):// → Image。Skill/Mention 用于
 * Codex skill / app / plugin 这类工具注入; 普通文件附件没有协议级 file 变体,
 * 需要作为文本路径引用发给模型, 让 Codex 自己用读文件能力打开。
 */
export type UserInput =
  | { type: 'text'; text: string }
  | { type: 'image'; url: string }
  | { type: 'localImage'; path: string }
  | { type: 'skill'; name: string; path: string }
  | { type: 'mention'; name: string; path: string };

/**
 * v2 config_types.rs CollaborationMode — EXPERIMENTAL (`turn/start.collaborationMode` /
 * `thread/settings/update.collaborationMode`, initialize 已恒开 experimentalApi)。
 *
 * 序列化注意:
 *  - ModeKind 是 `#[serde(rename_all = "snake_case")]` → 'plan' | 'default'。
 *  - Settings 结构体**没有** rename_all → 字段保持 snake_case
 *    (model / reasoning_effort / developer_instructions), 不是 camelCase。
 *  - settings.developer_instructions 三态:
 *      null  → server 端 normalize_collaboration_mode 填该模式的**内置指令**
 *              (plan 模式即官方 plan-mode developer 段, 作为独立 <collaboration_mode>
 *              fragment 注入, 不覆盖我们 thread/start 的 developerInstructions);
 *      ''    → 不注入任何模式指令 (normalize 只在 null 时才填内置文案);
 *      文本  → client 自定指令。
 *  - 设置后 collaborationMode 对模型/effort 有覆盖优先级, settings.model /
 *    reasoning_effort 必须带上当前 mutable 值, 否则会把用户的模型选择顶掉。
 */
export interface CollaborationModeParam {
  mode: 'plan' | 'default';
  settings: {
    model: string;
    reasoning_effort: ReasoningEffort | null;
    developer_instructions: string | null;
  };
}

export interface TurnStartParams {
  threadId: string;
  input: UserInput[];
  /** 覆盖 thread 的默认 model (用于运行时切换 — Phase 3)。 */
  model?: string;
  /** 覆盖 reasoning effort (v2.rs:5800). thread/start 不接, 只在 turn/start 这里透传。 */
  effort?: ReasoningEffort;
  /**
   * 覆盖 reasoning summary 策略 (v2.rs:5801-5803). 我们恒传 'auto', 让
   * reasoning summary 文本一定出现 — 不依赖用户 ~/.codex/config.toml 里
   * 写没写 model_reasoning_summary。设 'none' 会让 OpenAI 不返摘要文本。
   */
  summary?: ReasoningSummary;
  cwd?: string;
  approvalPolicy?: AskForApproval;
  /** Route interactive approvals to the user or Codex's built-in reviewer. */
  approvalsReviewer?: ApprovalsReviewer;
  /** Fast mode override. Undefined = 不覆盖; null = 清空/standard; 'fast' = Fast mode. */
  serviceTier?: ServiceTier | null;
  /**
   * **关键**: turn/start 用的是 `sandboxPolicy: SandboxPolicy` (复杂 tag union),
   * **不是** thread/start 那套简单 `sandbox: SandboxMode` (kebab-case enum)。
   * 字段名 + 类型都不一样, 写错 server 直接忽略 → mid-session 切 mode 不生效。
   * 见 v2.rs:5778 + 1886 (SandboxPolicy 定义)。
   */
  sandboxPolicy?: SandboxPolicy;
  /**
   * EXPERIMENTAL 计划模式 (collaboration mode)。sticky 语义 — 对本 turn 及后续
   * turn 生效, 退出计划模式后必须显式发 mode:'default' 复位。见 CollaborationModeParam。
   */
  collaborationMode?: CollaborationModeParam;
  [k: string]: unknown;
}

export interface TurnStartResponse {
  turn: { id: string; [k: string]: unknown };
  /** 当前 Codex schema 未返回；保留防御字段，若上游补齐可直接读取并校准本地状态。 */
  serviceTier?: ServiceTier | null;
  [k: string]: unknown;
}

export interface TurnSteerParams {
  threadId: string;
  input: UserInput[];
  /**
   * app-server 要求客户端带上当前 active turn id。这个字段是 stale-client 防线：
   * renderer/main 可能还以为 turn 在跑，但 server 已经完成；没有 expectedTurnId
   * 会把这种竞态伪装成成功插话，造成队列消息丢失或 UI 状态错乱。
   */
  expectedTurnId: string;
  [k: string]: unknown;
}

export interface TurnSteerResponse {
  turnId: string;
  [k: string]: unknown;
}

export interface TurnInterruptParams {
  threadId: string;
  turnId: string;
}

export type TurnInterruptResponse = Record<string, unknown>;

// ── ThreadResume / ThreadFork / ThreadRollback (Phase 3) ─────────────────────

export interface ThreadResumeParams {
  threadId: string;
  /** 可选覆盖, 缺省继承 thread 原有配置。 */
  model?: string;
  /** 同 ThreadStartParams.modelProvider —— resume 也接受 provider 覆盖(v2.rs ThreadResumeParams)。 */
  modelProvider?: string;
  cwd?: string;
  approvalPolicy?: AskForApproval;
  /** Route interactive approvals to the user or Codex's built-in reviewer. */
  approvalsReviewer?: ApprovalsReviewer;
  sandbox?: SandboxMode;
  /** Fast mode override. Undefined = 不覆盖; null = 清空/standard; 'fast' = Fast mode. */
  serviceTier?: ServiceTier | null;
  /**
   * 在 codex 默认 base 之后追加 developer message。thread/resume 支持该字段,
   * 用于重启后恢复 host 产品级 prompt。
   */
  developerInstructions?: string;
  [k: string]: unknown;
}

export interface ThreadResumeResponse {
  thread: { id: string; [k: string]: unknown };
  model: string;
  modelProvider: string;
  cwd: string;
  approvalPolicy: AskForApproval;
  sandbox: SandboxPolicy;
  serviceTier?: ServiceTier | null;
  [k: string]: unknown;
}

/**
 * v2.rs SandboxPolicy (line 1886): `#[serde(tag = "type", rename_all = "camelCase")]`,
 * 各结构变体内部字段也是 `#[serde(rename_all = "camelCase")]` + `#[serde(default)]`
 * 所以可以全部省略, 走 server 默认值。
 *
 * - dangerFullAccess: 无 sandbox, 任何 write OK
 * - readOnly:        只读, networkAccess 默认 false
 * - workspaceWrite:  workspace 内可写, networkAccess 默认 false
 * - externalSandbox: 外部 sandbox 接管 (我们不用)
 */
export type SandboxPolicy =
  | { type: 'dangerFullAccess' }
  | { type: 'readOnly'; networkAccess?: boolean }
  | {
      type: 'workspaceWrite';
      writableRoots?: string[];
      networkAccess?: boolean;
      excludeTmpdirEnvVar?: boolean;
      excludeSlashTmp?: boolean;
    }
  | { type: 'externalSandbox'; networkAccess?: 'restricted' | 'enabled' };

export interface ThreadForkParams {
  threadId: string;
  /** 可选: 从特定 rollout path fork (绝大多数场景用 threadId)。 */
  path?: string;
  /** Codex 自家前端 fork 精确节点时会开启, 保留完整历史供后续 rollback。 */
  persistExtendedHistory?: boolean;
  model?: string;
  cwd?: string;
  approvalPolicy?: AskForApproval;
  /** Route interactive approvals to the user or Codex's built-in reviewer. */
  approvalsReviewer?: ApprovalsReviewer;
  sandbox?: SandboxMode;
  [k: string]: unknown;
}

export interface ThreadForkResponse {
  thread: { id: string; [k: string]: unknown };
  model: string;
  modelProvider: string;
  [k: string]: unknown;
}

export interface ThreadRollbackParams {
  threadId: string;
  /** 从 thread 尾部回滚多少个完整 turn。 */
  numTurns: number;
}

export interface ThreadRollbackResponse {
  thread: { id: string; [k: string]: unknown };
  [k: string]: unknown;
}

// ── ThreadSettingsUpdate (v2.rs ThreadSettingsUpdateParams) ──────────────────
// 会话中途单独推 model / serviceTier / effort 等设置, server 写入后续 turn 的
// sticky context (不必等下一个 turn/start 携带)。需要 experimentalApi capability
// (host.ts 已恒开)。响应仅是 ack, 真正状态经 thread/settings/updated 通知回带。
// **只镜像我们会发的字段** — 上游 params 还有 approvalPolicy / approvalsReviewer /
// sandboxPolicy /
// personality / collaborationMode 等, 用到再加, 保持最小协议面。
export interface ThreadSettingsUpdateParams {
  threadId: string;
  /** 覆盖后续 turn 的 model。省略 = 不变。 */
  model?: string;
  /** Route subsequent interactive approvals to the user or built-in reviewer. */
  approvalsReviewer?: ApprovalsReviewer;
  /**
   * Fast mode override (双 Option 语义): 省略字段 = 不变; `null` = 清空/standard;
   * 'fast' = Fast mode。发送侧必须用 `...(v !== undefined ? { serviceTier: v } : {})`
   * 才能区分"省略"与"显式 null", 否则 null 会被当成不变。
   */
  serviceTier?: ServiceTier | null;
  /** 覆盖后续 turn 的 reasoning effort。省略 = 不变。 */
  effort?: ReasoningEffort;
}

/** thread/settings/update 仅返回 ack, 不消费。 */
export type ThreadSettingsUpdateResponse = Record<string, unknown>;

/**
 * thread/settings/updated 通知回带的 server 权威设置快照 (v2.rs ThreadSettings)。
 * 只列我们消费的字段, 其余用索引签名兜底防 schema 漂移。serviceTier 在 server 端
 * 是裸 string (可能回 'priority'), 由 normalizeServiceTier 归一回 'fast'。
 */
export interface ThreadSettings {
  serviceTier?: ServiceTier | null;
  model?: string;
  effort?: ReasoningEffort | null;
  [k: string]: unknown;
}

export interface ThreadSettingsUpdatedNotification {
  method: 'thread/settings/updated';
  params: {
    threadId: string;
    threadSettings: ThreadSettings;
  };
}

// ── SkillsList (v2.rs) ──────────────────────────────────────────────────────

export interface SkillsListParams {
  cwds?: string[];
  forceReload?: boolean;
  perCwdExtraUserRoots?: Array<{ cwd: string; extraUserRoots: string[] }> | null;
}

export type SkillScope = 'user' | 'repo' | 'system' | 'admin';

export interface SkillInterface {
  displayName?: string;
  shortDescription?: string;
  iconSmall?: string;
  iconLarge?: string;
  brandColor?: string;
  defaultPrompt?: string;
}

export interface SkillDependencies {
  tools: Array<{
    type: string;
    value: string;
    description?: string;
    transport?: string;
    command?: string;
    url?: string;
  }>;
}

export interface SkillMetadata {
  name: string;
  description: string;
  shortDescription?: string;
  interface?: SkillInterface;
  dependencies?: SkillDependencies;
  path: string;
  scope: SkillScope;
  enabled: boolean;
}

export interface SkillErrorInfo {
  path: string;
  message: string;
}

export interface SkillsListEntry {
  cwd: string;
  skills: SkillMetadata[];
  errors: SkillErrorInfo[];
}

export interface SkillsListResponse {
  data: SkillsListEntry[];
}

// ── ServerRequest: Approval (Phase 2) ────────────────────────────────────────
//
// 入站 ServerRequest, 我们必须 setRequestHandler 接住并回 response, 否则 server 卡 turn。
// v2.rs 字段 (camelCase serde):
//   - CommandExecution: { threadId, turnId, itemId, approvalId?, reason?, command?, cwd?, ... }
//   - FileChange:        { threadId, turnId, itemId, reason?, grantRoot? }

export interface CommandExecutionRequestApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  /** zsh-exec-bridge 子命令场景, 一个 itemId 可能有多个 callback, 用此 id 区分; 普通 shell 是 null。 */
  approvalId?: string | null;
  reason?: string | null;
  command?: string | null;
  cwd?: string | null;
  availableDecisions?: unknown[] | null;
  [k: string]: unknown;
}

export interface FileChangeRequestApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  reason?: string | null;
  /** [UNSTABLE] server 要求允许向某根目录写入。 */
  grantRoot?: string | null;
  [k: string]: unknown;
}

/**
 * v2.rs CommandExecutionApprovalDecision (camelCase serde):
 *   accept | acceptForSession | decline | cancel
 *   (acceptWithExecpolicyAmendment / applyNetworkPolicyAmendment 是结构变体, 我们不实现)
 *
 * v2.rs FileChangeApprovalDecision:
 *   accept | acceptForSession | decline | cancel
 *
 * Phase 2 我们只发 accept/decline/cancel; acceptForSession 留 Phase 5+ ("Allow for session" 按钮)。
 */
export type ApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';

export interface CommandExecutionRequestApprovalResponse {
  decision: ApprovalDecision;
}

export interface FileChangeRequestApprovalResponse {
  decision: ApprovalDecision;
}

export type McpServerElicitationAction = 'accept' | 'decline' | 'cancel';

export type McpServerElicitationRequestParams = {
  threadId: string;
  turnId: string | null;
  serverName: string;
} & (
  | {
      mode: 'form';
      _meta: unknown | null;
      message: string;
      requestedSchema: unknown;
    }
  | {
      mode: 'url';
      _meta: unknown | null;
      message: string;
      url: string;
      elicitationId: string;
    }
);

export interface McpServerElicitationRequestResponse {
  action: McpServerElicitationAction;
  content: unknown | null;
  _meta: unknown | null;
}

// ── ServerRequest: Permissions Approval (MCP 工具等权限请求) ─────────────────
//
// Codex v2 新增 — item/permissions/requestApproval。
// 与 command/fileChange 不同: response 不是 { decision } 而是 { permissions, scope }。
// permissions 为空对象 = 拒绝; 非空 = 批准 (scope 决定粒度)。

export interface PermissionsRequestApprovalParams {
  threadId: string;
  turnId: string;
  itemId?: string | null;
  reason?: string | null;
  /** 请求的权限列表 — 原样透传给 UI,批准时原样回传给 server。 */
  permissions: unknown;
  [k: string]: unknown;
}

export type PermissionsApprovalScope = 'turn' | 'session';

export interface PermissionsRequestApprovalResponse {
  permissions: Record<string, unknown> | unknown;
  scope: PermissionsApprovalScope;
}

// ── ServerRequest: User input + dynamic tools (experimental, Codex 0.135.0) ──
//
// Generated schema source:
//   codex app-server generate-ts --experimental
//   - method: item/tool/requestUserInput
//   - params: ToolRequestUserInputParams
//   - response: ToolRequestUserInputResponse
//   - notification: serverRequest/resolved

export interface ToolRequestUserInputOption {
  label: string;
  description: string;
}

export interface ToolRequestUserInputQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: ToolRequestUserInputOption[] | null;
}

export interface ToolRequestUserInputParams {
  threadId: string;
  turnId: string;
  itemId: string;
  questions: ToolRequestUserInputQuestion[];
}

export interface ToolRequestUserInputAnswer {
  answers: string[];
}

export interface ToolRequestUserInputResponse {
  answers: Record<string, ToolRequestUserInputAnswer | undefined>;
}

export interface ServerRequestResolvedNotification {
  method: 'serverRequest/resolved';
  params: {
    threadId: string;
    requestId: JsonRpcId;
  };
}

export interface DynamicToolSpec {
  namespace?: string;
  name: string;
  description: string;
  inputSchema: unknown;
  deferLoading?: boolean;
}

export type DynamicToolCallOutputContentItem =
  | { type: 'inputText'; text: string }
  | { type: 'inputImage'; imageUrl: string };

export interface DynamicToolCallParams {
  threadId: string;
  turnId: string;
  callId: string;
  namespace: string | null;
  tool: string;
  arguments: unknown;
}

export interface DynamicToolCallResponse {
  contentItems: DynamicToolCallOutputContentItem[];
  success: boolean;
}

// ── Notification 联合 (Phase 1: 7 类) ────────────────────────────────────────
//
// 方法名作 discriminator。**绝大多数** notification 的 params 都带顶层 threadId,
// 但 thread/started 是例外 — threadId 在嵌套的 params.thread.id 里。
// AppServerHost 路由要 special-case 它 (见 host.ts extractThreadId)。

/**
 * v2.rs ThreadStartedNotification: pub thread: Thread (无顶层 thread_id)。
 * Host 端从 params.thread.id 取 threadId。
 */
export interface ThreadStartedNotification {
  method: 'thread/started';
  params: { thread: { id: string; [k: string]: unknown }; [k: string]: unknown };
}

export interface TurnStartedNotification {
  method: 'turn/started';
  params: { threadId: string; turn: { id: string; [k: string]: unknown }; [k: string]: unknown };
}

/**
 * v2.rs TurnCompletedNotification: { thread_id, turn: Turn }
 * Turn 包含 status (TurnStatus enum: completed/interrupted/failed/inProgress)
 * + 可选 error (TurnError)。**注意**: usage 不在 Turn 上, 走单独的
 * thread/tokenUsage/updated notification (translator 那边把两个事件归到一个 turn 处理)。
 */
export type TurnStatus = 'completed' | 'interrupted' | 'failed' | 'inProgress';

export interface TurnError {
  message: string;
  codexErrorInfo?: { [k: string]: unknown } | null;
  additionalDetails?: string | null;
}

export interface TurnCompletedNotification {
  method: 'turn/completed';
  params: {
    threadId: string;
    turn: {
      id: string;
      status: TurnStatus;
      error?: TurnError | null;
      startedAt?: number | null;
      completedAt?: number | null;
      durationMs?: number | null;
      items?: unknown[];
      [k: string]: unknown;
    };
  };
}

/**
 * v2.rs ThreadTokenUsageUpdatedNotification: { thread_id, turn_id, token_usage: ThreadTokenUsage }
 * - total: 整个 thread 累计 (我们用它当 cumulative snapshot)
 * - last: 上次 turn 的增量 (我们用它给 usage tracker ingestApiCallUsage)
 */
export interface TokenUsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface ThreadTokenUsageUpdatedNotification {
  method: 'thread/tokenUsage/updated';
  params: {
    threadId: string;
    turnId: string;
    tokenUsage: {
      total: TokenUsageBreakdown;
      last: TokenUsageBreakdown;
      modelContextWindow?: number | null;
    };
  };
}

/**
 * item.* 的 type / 内部字段 translator 那边按 discriminator narrow,
 * 这里只保证 envelope shape。
 */
export interface ItemStartedNotification {
  method: 'item/started';
  params: { threadId: string; turnId: string; item: ItemEnvelope; startedAtMs?: number };
}

export interface ItemUpdatedNotification {
  method: 'item/updated';
  params: { threadId: string; turnId: string; item: ItemEnvelope };
}

export interface ItemCompletedNotification {
  method: 'item/completed';
  params: { threadId: string; turnId: string; item: ItemEnvelope; completedAtMs?: number };
}

export type PlanEntryStatus = 'pending' | 'in_progress' | 'completed';

export interface PlanEntry {
  step: string;
  status: PlanEntryStatus;
}

/**
 * turn/plan/updated — Codex native plan/todo updates produced by update_plan.
 *
 * App-server README documents params as { turnId, explanation?, plan }; newer
 * protocol revisions also carry threadId so clients can route per thread.
 */
export interface TurnPlanUpdatedNotification {
  method: 'turn/plan/updated';
  params: {
    threadId?: string;
    turnId: string;
    explanation?: string | null;
    plan: PlanEntry[];
  };
}

/**
 * v2.rs ReasoningSummaryTextDeltaNotification (line 7234-7241):
 *   { thread_id, turn_id, item_id, delta, summary_index }
 *
 * 一次 turn 内 OpenAI reasoning summary 是分段的 (Vec<String>), 每个 part 通过
 * SummaryPartAdded 开启, 后续 SummaryTextDelta 携带该 part 的文本增量。
 * summaryIndex 标识当前 part 的下标 (0-based)。
 */
export interface ReasoningSummaryTextDeltaNotification {
  method: 'item/reasoning/summaryTextDelta';
  params: { threadId: string; turnId: string; itemId: string; delta: string; summaryIndex: number };
}

/**
 * v2.rs ReasoningSummaryPartAddedNotification (line 7246-7252):
 *   { thread_id, turn_id, item_id, summary_index }
 *
 * summary 数组开新一段时发, 没有 delta 文本; 用来在多段 summary 之间插分隔 ('\n\n')。
 */
export interface ReasoningSummaryPartAddedNotification {
  method: 'item/reasoning/summaryPartAdded';
  params: { threadId: string; turnId: string; itemId: string; summaryIndex: number };
}

/**
 * v2.rs ReasoningTextDeltaNotification (line 7257-7264):
 *   { thread_id, turn_id, item_id, delta, content_index }
 *
 * 原始内部 reasoning (raw_content) 的增量, OpenAI 通常不返 (只返 summary), 开源 /
 * self-hosted 模型才填。我们一并接通 — 没的话 server 不会推, 不浪费。
 */
export interface ReasoningTextDeltaNotification {
  method: 'item/reasoning/textDelta';
  params: { threadId: string; turnId: string; itemId: string; delta: string; contentIndex: number };
}

/**
 * v2.rs AccountRateLimitsUpdatedNotification (line 8120-8125):
 *   { rate_limits: RateLimitSnapshot }
 *
 * **账号级 notification, 没有 threadId / turnId** — codex_protocol::protocol::RateLimitSnapshot
 * (protocol/src/protocol.rs:2129-2173). server 在每 turn 完后推, 反映 ChatGPT 账号当前
 * 各滚动限额窗口的配额占用。窗口构成完全以服务端下发为准, 消费侧不得假设固定窗口
 * (OpenAI 会调整策略:典型是 5h + weekly 双窗, 2026-07 曾一度取消 5h, 且可能随时恢复)。
 *
 * host 端走全局 fan-out 路径 (无 threadId 不能走 routeNotification 的 per-thread 分发),
 * 所有 active subscriber 各收到一份 — 账号级数据天然跨 session 共享。
 */
export type RateLimitWindow = AccountRateLimitWindow;
export type CreditsSnapshot = AccountCreditsSnapshot;
export type RateLimitSnapshot = AccountRateLimitSnapshot;

export interface AccountRateLimitsUpdatedNotification {
  method: 'account/rateLimits/updated';
  params: { rateLimits: RateLimitSnapshot };
}

/**
 * v2.rs ThreadStatus (line 4611) — 线程级粗粒度运行状态。
 *
 *   #[serde(tag = "type", rename_all = "camelCase")]
 *   enum ThreadStatus { NotLoaded, Idle, SystemError, Active { active_flags: Vec<ThreadActiveFlag> } }
 *
 * Active 是"在跑"的总称, 具体跑啥(reasoning / agentMessage / 工具)不在这条事件里 —
 * 那些走 item.* 流。这里只关心 active_flags 的两类"等用户"信号。
 */
export type ThreadActiveFlag = 'waitingOnApproval' | 'waitingOnUserInput';

export type ThreadStatus =
  | { type: 'notLoaded' }
  | { type: 'idle' }
  | { type: 'systemError' }
  | { type: 'active'; activeFlags: ThreadActiveFlag[] };

/**
 * v2.rs ThreadStatusChangedNotification (line 6961) — 线程状态机广播。
 *
 * server 端 ThreadWatchManager 在 turn 起/落、approval 请求起/落、user_input 请求起/落、
 * system_error、shutdown 时发。turn lifecycle 我们已从 turn/started+turn/completed 自己
 * 拼了 'Done' / isRunning, 不重复消费; 唯一新增语义 = active_flags 里的两类等待标志。
 */
export interface ThreadStatusChangedNotification {
  method: 'thread/status/changed';
  params: { threadId: string; status: ThreadStatus };
}

/**
 * v2.rs ErrorNotification:
 *   pub error: TurnError, pub will_retry: bool, pub thread_id: String, pub turn_id: String
 * willRetry=true 时 server 会自动重试, 不应当中断 turn (translator 可降级为 warn)。
 */
export interface ErrorNotification {
  method: 'error';
  params: {
    threadId: string;
    turnId: string;
    willRetry: boolean;
    /** Host-synthesized transport failures are session lifecycle errors, not turn-scoped SDK errors. */
    scope?: 'turn' | 'transport';
    error: { message?: string; [k: string]: unknown };
    [k: string]: unknown;
  };
}

/** Codex 0.144.x automatic Guardian approval review lifecycle. */
export type GuardianApprovalReviewStatus =
  | 'inProgress'
  | 'approved'
  | 'denied'
  | 'timedOut'
  | 'aborted';
export type GuardianRiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type GuardianUserAuthorization = 'unknown' | 'low' | 'medium' | 'high';

export type GuardianCommandSource = 'shell' | 'unifiedExec';
export type GuardianNetworkProtocol = string;

/** The action shape emitted by item/autoApprovalReview/* notifications. */
export type GuardianApprovalReviewAction =
  | { type: 'command'; source: GuardianCommandSource; command: string; cwd: string }
  | { type: 'execve'; source: GuardianCommandSource; program: string; argv: string[]; cwd: string }
  | { type: 'applyPatch'; cwd: string; files: string[] }
  | { type: 'networkAccess'; target: string; host: string; protocol: GuardianNetworkProtocol; port: number }
  | {
      type: 'mcpToolCall';
      server: string;
      toolName: string;
      connectorId: string | null;
      connectorName: string | null;
      toolTitle: string | null;
    }
  | { type: 'requestPermissions'; reason: string | null; permissions: Record<string, unknown> };

export interface GuardianApprovalReview {
  status: GuardianApprovalReviewStatus;
  riskLevel: GuardianRiskLevel | null;
  userAuthorization: GuardianUserAuthorization | null;
  rationale: string | null;
}

export interface ItemGuardianApprovalReviewStartedNotification {
  threadId: string;
  turnId: string;
  startedAtMs: number;
  reviewId: string;
  targetItemId: string | null;
  review: GuardianApprovalReview;
  action: GuardianApprovalReviewAction;
}

export interface ItemGuardianApprovalReviewCompletedNotification {
  threadId: string;
  turnId: string;
  startedAtMs: number;
  completedAtMs: number;
  reviewId: string;
  targetItemId: string | null;
  decisionSource: 'agent';
  review: GuardianApprovalReview;
  action: GuardianApprovalReviewAction;
}

export interface GuardianWarningNotification {
  threadId: string;
  message: string;
}

/** JSON-RPC envelopes for the Guardian notification params above. */
export interface ItemGuardianApprovalReviewStartedServerNotification {
  method: 'item/autoApprovalReview/started';
  params: ItemGuardianApprovalReviewStartedNotification;
}

export interface ItemGuardianApprovalReviewCompletedServerNotification {
  method: 'item/autoApprovalReview/completed';
  params: ItemGuardianApprovalReviewCompletedNotification;
}

export interface GuardianWarningServerNotification {
  method: 'guardianWarning';
  params: GuardianWarningNotification;
}

/**
 * v2 ThreadItem 的 envelope — 至少有 id / type, 余字段按 type narrow。
 * 完整 union 在 v2.rs ThreadItem (太大, 不在 Phase 1 全列)。translator 用
 * type as discriminator + 字段守卫。
 */
export interface ItemEnvelope {
  id: string;
  type: string;
  [k: string]: unknown;
}

export type ServerNotification =
  | ThreadStartedNotification
  | TurnStartedNotification
  | TurnCompletedNotification
  | ThreadTokenUsageUpdatedNotification
  | ItemStartedNotification
  | ItemUpdatedNotification
  | ItemCompletedNotification
  | ReasoningSummaryTextDeltaNotification
  | ReasoningSummaryPartAddedNotification
  | ReasoningTextDeltaNotification
  | AccountRateLimitsUpdatedNotification
  | ThreadStatusChangedNotification
  | ThreadSettingsUpdatedNotification
  | ServerRequestResolvedNotification
  | ItemGuardianApprovalReviewStartedServerNotification
  | ItemGuardianApprovalReviewCompletedServerNotification
  | GuardianWarningServerNotification
  | ErrorNotification;

// ── 方法名常量 (避免 string typo) ────────────────────────────────────────────

export const Method = {
  Initialize: 'initialize',
  ModelList: 'model/list',
  SkillsList: 'skills/list',
  ThreadStart: 'thread/start',
  ThreadResume: 'thread/resume',
  ThreadFork: 'thread/fork',
  ThreadRollback: 'thread/rollback',
  ThreadSettingsUpdate: 'thread/settings/update',
  TurnStart: 'turn/start',
  TurnSteer: 'turn/steer',
  TurnInterrupt: 'turn/interrupt',
  AccountRateLimitsRead: 'account/rateLimits/read',
  AccountRateLimitResetCreditConsume: 'account/rateLimitResetCredit/consume',
  // Memory (实验性, experimentalApi 必须 true 才能用):
  // app-server/README.md:202-203 + 155
  ConfigRead: 'config/read',
  ExperimentalFeatureEnablementSet: 'experimentalFeature/enablement/set',
  MemoryReset: 'memory/reset',
  // ServerRequest (Phase 2 + permissions):
  CommandExecutionRequestApproval: 'item/commandExecution/requestApproval',
  FileChangeRequestApproval: 'item/fileChange/requestApproval',
  McpServerElicitationRequest: 'mcpServer/elicitation/request',
  PermissionsRequestApproval: 'item/permissions/requestApproval',
  ToolRequestUserInput: 'item/tool/requestUserInput',
  DynamicToolCall: 'item/tool/call',
  ItemGuardianApprovalReviewStarted: 'item/autoApprovalReview/started',
  ItemGuardianApprovalReviewCompleted: 'item/autoApprovalReview/completed',
  GuardianWarning: 'guardianWarning',
} as const;

export type {
  AccountRateLimitsResponse,
  ConsumeAccountRateLimitResetCreditParams,
  ConsumeAccountRateLimitResetCreditResponse,
};
