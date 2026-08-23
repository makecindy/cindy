/**
 * NDJSON RPC protocol between local desktop client and remote cc-manager daemon.
 *
 * Wire: each frame is one UTF-8 JSON object on its own line, terminated by '\n'.
 * Three message kinds:
 *   - request       : client → manager, expects matching response by id
 *   - response      : manager → client, carries result OR error for a request id
 *   - notification  : either direction, no id, no response expected
 *
 * Designed to be a thin wrapper over the Claude Agent SDK Query surface,
 * NOT an attempt to re-abstract cc protocol — most params and event payloads
 * are passed through verbatim (SDK already gives us typed JSON-safe shapes).
 *
 * Versioning: every connection must start with a protocol/hello handshake.
 * If client.protocolVersion !== server.protocolVersion the server replies with
 * INVALID_PROTOCOL_VERSION and the client should toast "upgrade required".
 */

/**
 * Bump on any breaking change. Minor additive changes don't bump.
 *
 * v2: query/start 增加 host toolGuards，并要求 daemon 在权限规则之前重建
 * PreToolUse 闸门。旧 daemon 会无声忽略未知字段，导致 capability routing
 * fail-open，因此这项表面上的字段新增必须按不兼容协议升级处理。
 *
 * v3: toolGuards 增加 root-only，使用 SDK agent_id 阻止远端 subagent
 * 调用受保护工具。旧 daemon 无法证明调用来源，因此必须升级协议。
 *
 * v4: 增加 subagent/model-access 反向请求，并要求 daemon 在 Full access
 * 之前执行 Agent/Task 实时模型准入预检。旧 daemon 没有该执行边界，
 * 会继续发起无权限请求，因此必须升级协议。
 *
 * v1 (redesign): 删除 dead-session drain/archive 握手,对齐 codex 模式。
 * reattach 只接新 events (live-only subscription),不 replay 旧 ring buffer。
 * ring buffer 降级为纯内存 fast-path(同一 daemon 进程生命周期内的 mid-turn 续流)。
 * 断开期间跑完的输出暂不自动补回 chat(follow-up: jsonl recovery 统一 cc + codex)。
 */
export const PROTOCOL_VERSION = 4 as const;

/**
 * cc-mgr bundle 版本号 — 手动 bump。
 *
 * 只在 cc-mgr 功能/协议有实质变化时递增。不随 SDK patch / esbuild 版本 /
 * 无关依赖变化而变。desktop 用这个（而非 bundle sha256）判断远端 daemon
 * 是否需要 upgrade,避免无关的 pnpm install 触发全量远端重装。
 */
export const CC_MGR_BUNDLE_VERSION = '0.0.9' as const;

export type RpcId = number;

export interface RpcError {
  code: RpcErrorCode;
  message: string;
  /** Optional structured details — e.g. install log tail. */
  data?: unknown;
}

export type RpcErrorCode =
  | 'INVALID_PROTOCOL_VERSION'
  | 'UNKNOWN_METHOD'
  | 'INVALID_PARAMS'
  | 'NOT_INITIALIZED'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_ALREADY_EXISTS'
  /** forceful kill 终止窗口 (inputQueue 已 end, consume loop 未退出) — 可重试。 */
  | 'SESSION_KILL_PENDING'
  /** kill + close 升级后 consume loop 仍未退出 (daemon 病态) — 需重启 daemon。 */
  | 'SESSION_KILL_TIMEOUT'
  | 'SDK_ERROR'
  | 'INTERNAL';

export interface RpcRequest<P = unknown> {
  type: 'request';
  id: RpcId;
  method: string;
  params: P;
}

export interface RpcResponse<R = unknown> {
  type: 'response';
  id: RpcId;
  result?: R;
  error?: RpcError;
}

export interface RpcNotification<P = unknown> {
  type: 'notification';
  method: string;
  params: P;
}

export type RpcMessage = RpcRequest | RpcResponse | RpcNotification;

/* ============================== Method names ============================== */

/**
 * client → manager methods. Names are namespaced so we can group later.
 * Keep alphabetical inside each namespace.
 */
export const METHODS = {
  // Lifecycle / handshake
  PROTOCOL_HELLO: 'protocol/hello',

  // Query (1:1 with SDK Query object lifecycle)
  QUERY_START: 'query/start',
  QUERY_SEND: 'query/send',
  QUERY_SET_MODEL: 'query/setModel',
  QUERY_SET_PERMISSION_MODE: 'query/setPermissionMode',
  QUERY_APPLY_FLAG_SETTINGS: 'query/applyFlagSettings',
  QUERY_GET_CONTEXT_USAGE: 'query/getContextUsage',
  QUERY_INTERRUPT: 'query/interrupt',
  QUERY_STOP_TASK: 'query/stopTask',
  QUERY_CLOSE: 'query/close',

  // Session (manager-level — list / attach / kill independent of Query lifecycle)
  SESSION_ATTACH: 'session/attach',
  SESSION_LIST: 'session/list',
  SESSION_KILL: 'session/kill',
} as const;

export type MethodName = (typeof METHODS)[keyof typeof METHODS];

/**
 * manager → client notification names.
 */
export const NOTIFICATIONS = {
  /** SDK message event for a session. Carries seq for replay ordering. */
  QUERY_EVENT: 'query/event',
  /** A session has been closed (terminal). */
  SESSION_CLOSED: 'session/closed',
  /** Current attach has been replaced by another client (single-attach policy). */
  CLIENT_REPLACED: 'client/replaced',
} as const;

/**
 * manager → client request methods (reverse-request: server asks, client responds).
 *
 * Used for bi-directional interactions that need a response from the desktop:
 * permission approval, ask-user-question, plan review, etc.
 */
export const SERVER_METHODS = {
  /** SDK's canUseTool fired — daemon needs desktop to approve/deny a tool use. */
  APPROVAL_REQUEST: 'approval/request',
  /** Agent/Task PreToolUse 向 desktop 查询当前账号与路由的模型准入状态。 */
  SUBAGENT_MODEL_ACCESS: 'subagent/model-access',
  /**
   * SDK's getOAuthToken fired — remote cc hit a 401 on its subscription OAuth
   * token and the daemon needs desktop to mint a fresh one
   * (auth.getFreshSubscriptionToken). Additive (protocol version unchanged):
   * old desktops answer UNKNOWN_METHOD → daemon returns null to the SDK,
   * degrading to the pre-refresh behavior (session surfaces the auth error).
   */
  OAUTH_REFRESH: 'oauth/refresh',
} as const;

export type ServerMethodName = (typeof SERVER_METHODS)[keyof typeof SERVER_METHODS];

export type NotificationName = (typeof NOTIFICATIONS)[keyof typeof NOTIFICATIONS];

/* ============================== Param shapes ============================== */

export interface HelloParams {
  protocolVersion: number;
  /** Optional client identifier (logs / debugging). */
  clientId?: string;
}

export interface HelloResult {
  protocolVersion: number;
  /** Manager build / git SHA, surfaced for diagnostics. */
  managerVersion?: string;
}

/**
 * Subset of SDK options we forward. canUseTool is handled via bi-directional
 * RPC (SERVER_METHODS.APPROVAL_REQUEST). Hooks are not forwarded (Phase N).
 */
export interface QueryStartParams {
  sessionId: string;
  /**
   * Resume an existing SDK session by its UUID (the SDK's internal session_id,
   * NOT our manager sessionId). Optional.
   */
  resumeSdkSessionId?: string;
  cwd: string;
  model: string;
  env: Record<string, string>;
  /**
   * MCP servers — only stdio/sse/http transport configs are accepted.
   * In-process MCP (`McpSdkServerConfigWithInstance`) is rejected because
   * `instance` is a non-serializable McpServer object.
   */
  mcpServers?: Record<string, McpServerStdioConfig | McpServerSseConfig | McpServerHttpConfig>;
  /** Permission mode forwarded to SDK. Desktop passes through user's selection. */
  permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions';
  /** SDK options.systemPrompt — string or { type: 'preset', preset: 'claude_code', append? }. */
  systemPrompt?: unknown;
  /** SDK options.additionalDirectories. */
  additionalDirectories?: string[];
  /** SDK options.allowedTools / disallowedTools. */
  allowedTools?: string[];
  disallowedTools?: string[];
  /** SDK options.tools (preset). */
  tools?: unknown;
  /**
   * Host-owned, daemon-enforced tool routing guards.
   *
   * These are materialized as in-process PreToolUse hooks on the remote
   * machine. Keeping them outside `extraOptions` prevents remote user/project
   * permission allow rules (or bypassPermissions) from silently skipping the
   * host's capability-source choice.
   */
  toolGuards?: QueryToolGuard[];
  /** Any extra SDK options we want to pass through verbatim. */
  extraOptions?: Record<string, unknown>;
}

export interface QueryToolGuard {
  /** Exact SDK tool-name prefix, for example `mcp__plugin_x_server__`. */
  toolNamePrefix: string;
  /** Exact harness-owned MCP server id before Claude normalizes punctuation. */
  sourceServerId?: string;
  invocation: 'auto' | 'explicit-only' | 'disabled' | 'root-only';
  /** Explicit command tokens that select this source for the active turn. */
  explicitSelectors?: string[];
  /** Optional user-facing denial reason returned by the PreToolUse hook. */
  denialMessage?: string;
}

export interface QueryStartResult {
  sessionId: string;
  /** SDK-assigned session UUID once the first message arrives. May be empty initially. */
  sdkSessionId?: string;
}

export interface SubagentModelAccessParams {
  sessionId: string;
  /** 已按 CLAUDE_CODE_SUBAGENT_MODEL 优先级及 [1m] 后缀归一化。 */
  model: string;
}

export interface SubagentModelAccessResult {
  status: 'allowed' | 'denied' | 'unknown';
  reason?: string;
}

export interface QuerySendParams {
  sessionId: string;
  /**
   * The SDKUserMessage envelope verbatim. Manager pushes this into the
   * SDK's inputQueue → streamInput consumer.
   */
  message: unknown;
}

export interface QuerySetModelParams {
  sessionId: string;
  model: string;
}

export interface QuerySetPermissionModeParams {
  sessionId: string;
  mode: 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions';
}

export interface QueryApplyFlagSettingsParams {
  sessionId: string;
  settings: Record<string, unknown>;
}

export interface QueryGetContextUsageParams {
  sessionId: string;
}

export interface QueryInterruptParams {
  sessionId: string;
}

/** query/stopTask — 停止会话内单个后台任务(SDK Query.stopTask 透传)。 */
export interface QueryStopTaskParams {
  sessionId: string;
  /** SDK task_notification 事件里的 task id。 */
  taskId: string;
}

export interface QueryCloseParams {
  sessionId: string;
}

export interface SessionAttachParams {
  sessionId: string;
  /** If set, manager replays events with seq > sinceSeq before switching to live. */
  sinceSeq?: number;
}

export interface SessionAttachResult {
  sessionId: string;
  /** Highest seq currently buffered. Client should update its sinceSeq to this. */
  currentSeq: number;
  /** Whether the underlying Query is still alive (false = session has exited). */
  alive: boolean;
  /** True when the retained ring buffer could not cover the requested sinceSeq. */
  replayLossy: boolean;
}

export interface SessionListParams {
  /** Empty for now. */
}

export interface SessionListEntry {
  sessionId: string;
  sdkSessionId?: string;
  cwd: string;
  model: string;
  /** seq of latest buffered event. */
  lastSeq: number;
  /** Whether the underlying Query is still alive. */
  alive: boolean;
  /** ISO timestamp when manager created this session. */
  startedAt: string;
  /** ISO timestamp of last event. */
  lastEventAt: string | null;
}

export interface SessionListResult {
  sessions: SessionListEntry[];
}

export interface SessionKillParams {
  sessionId: string;
}

/* ============================== Server → Client request shapes ============================== */

/**
 * Approval request — daemon's SDK canUseTool callback fired, needs desktop to
 * approve/deny. Maps to the same InteractionRequest kinds in maker-core:
 * 'permission' | 'ask_user_question' | 'plan_review'.
 */
export interface ApprovalRequestParams {
  sessionId: string;
  /** Unique request ID (SDK's toolUseID). Used to correlate response. */
  requestId: string;
  /** Interaction kind — matches maker-core InteractionRequest.kind. */
  kind: 'permission' | 'ask_user_question' | 'plan_review';
  /** Tool name (for 'permission' kind). */
  toolName?: string;
  /** Tool input (for 'permission' kind). */
  input?: Record<string, unknown>;
  /** Display title (for 'permission' kind). */
  title?: string;
  /** Display name override (for 'permission' kind). */
  displayName?: string;
  /** Description (for 'permission' kind). */
  description?: string;
  /** Permission suggestions (for 'permission' kind). */
  suggestions?: unknown[];
  /** Metadata (for 'permission' kind). */
  metadata?: Record<string, unknown>;
  /** Questions (for 'ask_user_question' kind). */
  questions?: unknown[];
  /** Plan text (for 'plan_review' kind). */
  plan?: string;
  /** Plan file path (for 'plan_review' kind). */
  planFilePath?: string;
}

/**
 * OAuth refresh request — daemon's SDK getOAuthToken callback fired (remote cc
 * got a 401 on the spawn-time subscription token). Desktop should return a
 * fresh access token, or null when refresh is impossible (logged out, refresh
 * token revoked) — the SDK then surfaces the auth error to the session.
 */
export interface OAuthRefreshParams {
  /**
   * Session asking for the refresh. Deliberately the only field: desktop's own
   * env/credential store is the source of truth for the stale-token baseline,
   * and echoing the daemon-side token back over the wire would widen the
   * token's exposure surface for no consumer.
   */
  sessionId: string;
}

export interface OAuthRefreshResult {
  /** Fresh subscription access token, or null when refresh failed. */
  token: string | null;
}

/**
 * Response from desktop for an approval request.
 */
export interface ApprovalRequestResult {
  /** Decision kind — must match the request's kind. */
  kind: 'permission' | 'ask_user_question' | 'plan_review';
  /** For 'permission': 'allow' | 'deny'. */
  behavior?: 'allow' | 'deny';
  /** For 'permission': updated input if user modified. */
  updatedInput?: Record<string, unknown>;
  /** For 'permission': permission rule updates. */
  permissionUpdates?: unknown[];
  /** For 'permission'/'plan_review': denial reason. */
  reason?: string;
  /** For 'ask_user_question': user answers. */
  answers?: Record<string, string>;
  /** For 'plan_review': edited plan text. */
  editedPlan?: string;
  /** System dismissal rather than user-authored plan feedback. */
  dismissed?: boolean;
}

/* ============================== Notification shapes ============================== */

export interface QueryEventNotification {
  sessionId: string;
  /** Manager-assigned monotonic seq within the session. Used for replay. */
  seq: number;
  /** ISO timestamp when manager observed this event. */
  ts: string;
  /** SDKMessage verbatim (JSON-serializable per SDK design). */
  message: unknown;
}

export interface SessionClosedNotification {
  sessionId: string;
  /** Why the session ended — exit normally, killed, crashed, etc. */
  reason: 'completed' | 'closed' | 'killed' | 'error';
  /** Optional human-readable detail. */
  detail?: string;
}

export interface ClientReplacedNotification {
  sessionId: string;
  /** Always 'another-client-attached' for now — kept open for future reasons. */
  reason: 'another-client-attached';
}

/* ============================== MCP server config (cross-process safe) ============================== */

export interface McpServerStdioConfig {
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpServerSseConfig {
  type: 'sse';
  url: string;
  headers?: Record<string, string>;
}

export interface McpServerHttpConfig {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
}

/* ============================== Type guards ============================== */

export function isRpcMessage(value: unknown): value is RpcMessage {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.type === 'request') {
    return typeof v.id === 'number' && typeof v.method === 'string';
  }
  if (v.type === 'response') {
    return typeof v.id === 'number';
  }
  if (v.type === 'notification') {
    return typeof v.method === 'string';
  }
  return false;
}

export function isRpcRequest(value: RpcMessage): value is RpcRequest {
  return value.type === 'request';
}

export function isRpcResponse(value: RpcMessage): value is RpcResponse {
  return value.type === 'response';
}

export function isRpcNotification(value: RpcMessage): value is RpcNotification {
  return value.type === 'notification';
}

/* ============================== Helpers ============================== */

/** Construct a typed error result. Caller passes this as RpcResponse.error. */
export function makeRpcError(code: RpcErrorCode, message: string, data?: unknown): RpcError {
  return { code, message, ...(data !== undefined ? { data } : {}) };
}
