/**
 * NDJSON RPC protocol between the Cindy desktop client and the local
 * hermes-mgr daemon (packages/maker-hermes-manager/bin, M1).
 *
 * Wire: one UTF-8 JSON object per line, '\n'-terminated. Three message kinds:
 *   - request       : client → daemon, expects a matching response by id
 *   - response      : daemon → client, result or error for a request id
 *   - notification  : either direction, no id, no response expected
 *
 * Shape mirrors packages/maker-cc-manager/src/protocol.ts (the established
 * harness-sidecar contract) but is deliberately a separate, smaller protocol:
 * Hermes is driven one process per turn via `hermes chat --format
 * stream-json`, so there is no long-lived Query object, no toolGuards, and no
 * OAuth refresh. Hermes JSONL events are forwarded verbatim inside
 * query/event — the maker-core `agents/hermes` translator owns reshaping.
 *
 * Versioning: every connection starts with protocol/hello. A version mismatch
 * answers INVALID_PROTOCOL_VERSION and the client must surface an upgrade
 * error rather than guess.
 */

/**
 * Bump on any breaking change. Additive changes don't bump.
 *
 * v1: initial protocol. Per-turn process model; sessions are logical
 * (sessionId ↔ Hermes session id map) and survive daemon restarts only via
 * the daemon's persisted session registry, not in-process state.
 */
export const PROTOCOL_VERSION = 1 as const;

/**
 * hermes-mgr bundle version — manual bump on substantive daemon changes.
 * Desktop uses this (not a content hash) to decide remote-style upgrades, so
 * unrelated tooling changes must not touch it.
 */
export const HERMES_MGR_BUNDLE_VERSION = '0.2.0' as const;

export type RpcId = number;

export interface RpcError {
  code: RpcErrorCode;
  message: string;
  /** Optional structured details — e.g. the Hermes process's stderr tail. */
  data?: unknown;
}

export type RpcErrorCode =
  | 'INVALID_PROTOCOL_VERSION'
  | 'UNKNOWN_METHOD'
  | 'INVALID_PARAMS'
  | 'NOT_INITIALIZED'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_ALREADY_EXISTS'
  /** A turn is already running for this session — interrupt before sending. */
  | 'TURN_ALREADY_RUNNING'
  /** Hermes process kill issued but the child hasn't exited yet — retryable. */
  | 'SESSION_KILL_PENDING'
  /** Child ignored SIGTERM/SIGKILL within the grace window — daemon is sick. */
  | 'SESSION_KILL_TIMEOUT'
  /** The Hermes process failed (non-zero exit without a parsed result event). */
  | 'HERMES_ERROR'
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

/** client → daemon methods, alphabetical within each namespace. */
export const METHODS = {
  // Lifecycle / handshake
  PROTOCOL_HELLO: 'protocol/hello',

  // Query (one Hermes process per turn; sessionId is the logical session)
  QUERY_START: 'query/start',
  QUERY_SEND: 'query/send',
  QUERY_SET_MODEL: 'query/setModel',
  QUERY_SET_PERMISSION_MODE: 'query/setPermissionMode',
  QUERY_INTERRUPT: 'query/interrupt',
  QUERY_CLOSE: 'query/close',

  // Session (daemon-level: list logical sessions, kill a live child)
  SESSION_ATTACH: 'session/attach',
  SESSION_LIST: 'session/list',
  SESSION_KILL: 'session/kill',

  // Config (daemon-level: runtime status, default model route, and MCP servers)
  CONFIG_STATUS: 'config/status',
  CONFIG_GET_DEFAULT_ROUTE: 'config/getDefaultRoute',
  CONFIG_SET_DEFAULT_ROUTE: 'config/setDefaultRoute',
  CONFIG_LIST_MODELS: 'config/listModels',
  CONFIG_LIST_MCP_SERVERS: 'config/listMcpServers',
  CONFIG_SET_MCP_SERVER: 'config/setMcpServer',
  CONFIG_REMOVE_MCP_SERVER: 'config/removeMcpServer',
  CONFIG_SET_PLUGIN_ENABLED: 'config/setPluginEnabled',
} as const;

export type MethodName = (typeof METHODS)[keyof typeof METHODS];

/** daemon → client notification names. */
export const NOTIFICATIONS = {
  /** One Hermes JSONL event (or daemon-synthesized lifecycle event) for a session. */
  QUERY_EVENT: 'query/event',
  /** A logical session ended (child exited terminally and is not resumable here). */
  SESSION_CLOSED: 'session/closed',
  /** The current attach was replaced by another client (single-attach policy). */
  CLIENT_REPLACED: 'client/replaced',
} as const;

export type NotificationName = (typeof NOTIFICATIONS)[keyof typeof NOTIFICATIONS];

/**
 * daemon → client request methods (reverse-request: daemon asks, desktop
 * answers). Reserved for M3+: Hermes approval hooks surfaced into Cindy's
 * permission UI. v1 never sends these; a v1 desktop that sees one should
 * answer UNKNOWN_METHOD, which the daemon treats as "deny".
 */
export const SERVER_METHODS = {
  APPROVAL_REQUEST: 'approval/request',
} as const;

export type ServerMethodName = (typeof SERVER_METHODS)[keyof typeof SERVER_METHODS];

/* ============================== Param shapes ============================== */

export interface HelloParams {
  protocolVersion: number;
  /** Optional client identifier for log correlation. */
  clientId?: string;
}

export interface HelloResult {
  protocolVersion: number;
  /** Daemon build / git SHA for diagnostics. */
  managerVersion?: string;
  /**
   * Absolute HERMES_HOME the daemon drives, when the daemon layer extends the
   * handshake result (the transport-level builtin does not know it).
   */
  hermesHome?: string;
}

/**
 * Permission modes mirror Cindy's session modes. The daemon maps them to
 * Hermes flags at spawn time (see hermes-spawn.ts in M1); the mapping is a
 * daemon implementation detail and may not change the wire shape.
 */
export type HermesPermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions';

export interface HermesQueryStartParams {
  /** Cindy's logical session id. Unique per start; reuse after close is an error. */
  sessionId: string;
  /** Resume this Hermes session id (from a previous run's system/init event). */
  resumeHermesSessionId?: string;
  cwd: string;
  /** Extra env merged over the daemon's environment (credentials ride the local socket, matching cc-mgr). */
  env?: Record<string, string>;
  /** Hermes model, passed as `-m` (e.g. `zai/glm-5.3`). Omit to use the Hermes home default. */
  model?: string;
  /** Hermes provider name from the Hermes home's config; omit for auto. */
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  permissionMode?: HermesPermissionMode;
  /**
   * Session preamble prepended to the first turn's query (Cindy context).
   * Hermes has no system-prompt flag on chat; v1 carries Cindy context in-band.
   */
  systemPromptPreamble?: string;
  /** Hard cap on agent turns for each spawned run (`--max-turns`). */
  maxTurns?: number;
  /** Wall-clock budget per spawned run in seconds (`--run-budget`). */
  runBudgetSeconds?: number;
}

export interface HermesQueryStartResult {
  sessionId: string;
  /**
   * Hermes session id bound to this logical session. Empty until the first
   * run's system/init event is observed (the daemon then emits a
   * session-bound query/event so the client learns it too).
   */
  hermesSessionId?: string;
}

export interface HermesQuerySendParams {
  sessionId: string;
  /** The user turn text, passed to Hermes via stdin (`--query-file -`). */
  text: string;
  /**
   * Reserved: local image paths or Cindy managed media URIs attached to this
   * turn. v1 daemons reject non-empty values with INVALID_PARAMS rather than
   * silently dropping attachments.
   */
  images?: string[];
}

export interface HermesQuerySetModelParams {
  sessionId: string;
  model: string;
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
}

export interface HermesQuerySetPermissionModeParams {
  sessionId: string;
  mode: HermesPermissionMode;
}

export interface HermesQueryInterruptParams {
  sessionId: string;
}

export interface HermesQueryCloseParams {
  sessionId: string;
}

export interface SessionAttachParams {
  sessionId: string;
  /** Replay events with seq > sinceSeq before switching to live. */
  sinceSeq?: number;
}

export interface SessionAttachResult {
  sessionId: string;
  currentSeq: number;
  /** True when a Hermes child process is running for this session right now. */
  running: boolean;
  /** True when the in-memory replay buffer could not cover sinceSeq. */
  replayLossy: boolean;
}

export interface SessionListEntry {
  sessionId: string;
  hermesSessionId?: string;
  cwd: string;
  model?: string;
  permissionMode?: HermesPermissionMode;
  lastSeq: number;
  running: boolean;
  startedAt: string;
  lastEventAt: string | null;
}

export interface SessionListResult {
  sessions: SessionListEntry[];
}

export interface SessionKillParams {
  sessionId: string;
}

/* ============================== Config / MCP shapes ============================== */

export interface ConfigStatusResult {
  installedVersion: string | null;
  pinnedVersion: string;
  matches: boolean | null;
}

export interface HermesMcpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  auth?: string;
  disabled?: boolean;
}

export interface ConfigListMcpServersResult {
  servers: Record<string, HermesMcpServerConfig>;
}

export interface ConfigSetMcpServerParams {
  name: string;
  server: HermesMcpServerConfig;
}

export interface ConfigSetMcpServerResult {
  servers: Record<string, HermesMcpServerConfig>;
}

export interface ConfigRemoveMcpServerParams {
  name: string;
}

export interface ConfigRemoveMcpServerResult {
  servers: Record<string, HermesMcpServerConfig>;
}

/* ============================== Server → Client request shapes ============================== */

/**
 * Reserved (M3): a Hermes approval hook fired and the daemon needs the
 * desktop to approve/deny. Shape intentionally mirrors cc-mgr's
 * ApprovalRequestParams so Cindy's existing interaction UI can consume it.
 */
export interface ApprovalRequestParams {
  sessionId: string;
  requestId: string;
  kind: 'permission' | 'ask_user_question' | 'plan_review';
  toolName?: string;
  input?: Record<string, unknown>;
  title?: string;
  description?: string;
}

export interface ApprovalRequestResult {
  kind: 'permission' | 'ask_user_question' | 'plan_review';
  behavior?: 'allow' | 'deny';
  reason?: string;
  answers?: Record<string, string>;
}

/* ============================== Notification shapes ============================== */

export interface HermesQueryEventNotification {
  sessionId: string;
  /** Daemon-assigned monotonic seq within the session; replay ordering key. */
  seq: number;
  /** ISO timestamp when the daemon observed the event. */
  ts: string;
  /**
   * Hermes stream-json event verbatim (parsed JSONL line), or a
   * daemon-synthesized lifecycle event of shape
   * `{ type: 'hermes-mgr', subtype: 'session-bound', hermesSessionId }`.
   */
  event: unknown;
}

export interface SessionClosedNotification {
  sessionId: string;
  reason: 'completed' | 'closed' | 'killed' | 'error';
  detail?: string;
}

export interface ClientReplacedNotification {
  sessionId: string;
  reason: 'another-client-attached';
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
