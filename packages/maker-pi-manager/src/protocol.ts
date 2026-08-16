/**
 * NDJSON RPC protocol between local desktop client and remote pi-manager daemon.
 *
 * Wire: each frame is one UTF-8 JSON object on its own line, terminated by '\n'.
 * Three message kinds:
 *   - request       : client → manager, expects matching response by id
 *   - response      : manager → client, carries result OR error for a request id
 *   - notification  : either direction, no id, no response expected
 *
 * This is pi-manager's OWN protocol namespace (`pi/*` methods) — deliberately
 * separate from cc-manager's `query/*` namespace. Both daemons may coexist on
 * the same remote host without any wire-level interference.
 *
 * Versioning: every connection must start with a protocol/hello handshake.
 * If client.protocolVersion !== server.protocolVersion the server replies with
 * INVALID_PROTOCOL_VERSION.
 */

/**
 * Bump on any breaking change. Minor additive changes don't bump.
 * v1: initial pi-manager protocol.
 */
export const PROTOCOL_VERSION = 1 as const;

/**
 * pi-manager bundle version — manual bump, mirroring cc-manager's model.
 * Only bump when pi-manager functionality/protocol has a substantive change.
 * Desktop compares this (not bundle sha256) to decide whether the remote
 * daemon needs a re-upload — avoids unrelated dependency churn triggering
 * full remote reinstalls.
 */
// 轮 40-w4-t17 HIGH:0.1.0 → 0.1.1 —— 本分支对 daemon 行为有实质改动
// (idle recycle 的 attachedSocket 二次复核、atomic env-file、shutdownAll survivor
// 保留、NUL/命令校验等), 不 bump 会让存量远端按旧版本号跳过新 bundle,
// 这些修复在已安装远端上静默失效。
// 轮 22 CRITICAL:0.1.1 → 0.1.2 —— env-file 写前展开字面 $HOME 前缀
// (LAZY_CREATE_FAILED 根因: PI_CODING_AGENT_DIR 字面 $HOME → pi 找不到
// models.json → Unknown provider → 秒退)。不 bump 存量远端跳过新 bundle。
// 轮 23-H1:0.1.2 → 0.1.3 —— pi/list 返回 ageMs/lastActivityMs(daemon 时钟算,
// 修跨机器时钟比较误杀); idle 回收改单调时钟(hrtime)。
// 轮 25:0.1.3 → 0.1.4 —— spawn debug 日志(排查 Unknown provider)。
// 轮 25 CRITICAL:0.1.4 → 0.1.5 —— childEnv 用展开后值(LAZY_CREATE_FAILED
// 真正根因: spawn env 里 PI_CODING_AGENT_DIR 是字面 $HOME, pi 找不到 models.json)。
export const PI_MANAGER_BUNDLE_VERSION = '0.1.5' as const;

export type RpcId = number;

export interface RpcError {
  code: RpcErrorCode;
  message: string;
  /** Optional structured details — e.g. process spawn error. */
  data?: unknown;
}

export type RpcErrorCode =
  | 'INVALID_PROTOCOL_VERSION'
  | 'UNKNOWN_METHOD'
  | 'INVALID_PARAMS'
  | 'NOT_INITIALIZED'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_ALREADY_EXISTS'
  /** pi process survived SIGKILL (uninterruptible state) — refuse to proceed. */
  | 'SESSION_KILL_SURVIVED'
  /** Session count limit reached (spawn flood DoS guard). */
  | 'SESSION_LIMIT_EXCEEDED'
  /** Per-client in-flight request limit reached (request flood guard). */
  | 'SERVER_BUSY'
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

export const METHODS = {
  // Lifecycle / handshake
  PROTOCOL_HELLO: 'protocol/hello',

  // pi session control (manager-level — ensure/kill/list/shutdown)
  PI_ENSURE: 'pi/ensure',
  PI_KILL: 'pi/kill',
  PI_LIST: 'pi/list',
  PI_SHUTDOWN: 'pi/shutdown',
} as const;

export type MethodName = (typeof METHODS)[keyof typeof METHODS];

/**
 * manager → client notification names.
 */
export const NOTIFICATIONS = {
  /** A session has been closed (terminal) — pi exited / killed / recycled. */
  SESSION_CLOSED: 'session/closed',
} as const;

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
 * pi/ensure — ensure a pi session exists (spawn if missing, conditional
 * restart if env changed, pure attach if env unchanged).
 */
export interface PiEnsureParams {
  /** Maker sessionId — the daemon-side session key. */
  sessionId: string;
  /** Full pi launch command (`bash -c` form, same as python daemon --cmd). */
  cmd: string;
  /** Env values written to the session's env-file before spawn. */
  env: Record<string, string>;
  /** sha256 of the env content — matched against the retained envHash for
   *  conditional restart (pure attach when unchanged). */
  envHash: string;
  /**
   * true = allow rebuild when envHash mismatches (kill old pi + respawn);
   * false = return existing socket even if envHash differs (pure attach).
   */
  restart: boolean;
}

export interface PiEnsureResult {
  sessionId: string;
  /** Absolute path to the session's unix socket (client bridges to it). */
  sockPath: string;
  /** true = attached to an existing pi without killing it; false = new spawn. */
  isReattach: boolean;
}

export interface PiKillParams {
  sessionId: string;
}

export interface PiListEntry {
  sessionId: string;
  pid: number;
  sockPath: string;
  envHash: string;
  /** Epoch ms of last activity (stdout output / bridge stdin). */
  lastActivity: number;
  /** Epoch ms of session spawn(轮 12 MEDIUM-4 —— cleanup 用年龄过滤新生会话)。 */
  startedAt: number;
  isAttached: boolean;
  /** 轮 23-H1 HIGH:daemon 侧算好的年龄 ms(本机时钟)—— desktop 不跨机器减
   *  epoch(时钟偏移会让 30s 新生保护失效)。 */
  ageMs: number;
  /** 轮 23-H1:daemon 侧算好的空闲时长 ms(本机时钟)。 */
  lastActivityMs: number;
}

export interface PiListResult {
  sessions: PiListEntry[];
}

/* ============================== Notification shapes ============================== */

export interface SessionClosedNotification {
  sessionId: string;
  /** Why the session ended. */
  reason: 'completed' | 'killed' | 'idle_timeout' | 'error';
  /** Optional human-readable detail. */
  detail?: string;
}

/* ============================== Type guards ============================== */

export function isRpcMessage(value: unknown): value is RpcMessage {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.type === 'request') {
    // Number.isSafeInteger:NaN/Infinity/float 通过 typeof number 但 Map.get(NaN)
    // 永不命中(NaN !== NaN), 会让响应静默落空(自审轮 1 M-2)。
    // 不在此处拒绝负数 id:server→client 反向请求使用负数 id 命名空间(-1,-2,…),
    // 客户端响应这些反向请求时需带负数 id 回传;若 isRpcMessage 全局拒绝负数 id,
    // 则服务端的 decoder 无法识别客户端对反向请求的响应(自审轮 9 补).
    // 客户端发负数 id 请求的拒绝在 ManagerServer.dispatch 层做(server.ts:301).
    return Number.isSafeInteger(v.id) && typeof v.method === 'string';
  }
  if (v.type === 'response') {
    return Number.isSafeInteger(v.id);
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
