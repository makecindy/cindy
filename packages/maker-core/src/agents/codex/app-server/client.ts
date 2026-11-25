/**
 * Codex app-server JSON-RPC NDJSON client.
 *
 * 职责:
 *  - 接收一个已经在跑的 Transport (StdioTransport / SshDaemonTransport / ...)
 *  - JSON-RPC 2.0 (无 jsonrpc 字段, 见 jsonrpc_lite.rs) request/response 关联
 *  - ServerRequest 路由到 setRequestHandler
 *  - Notification 路由到 onNotification
 *  - close() 关 transport + reject 所有挂起 request
 *
 * 1:1 范本 (只读):
 *  - codex-rs/app-server-test-client/src/lib.rs:1378-1484 spawn_stdio
 *  - codex-rs/app-server-transport/src/transport/stdio.rs NDJSON framing
 *
 * 性能纪律 (plan 强制要求):
 *  - 全部异步 IO (transport 内部本来就 async)
 *  - readline 增量按行喂, 不 buffer 整个 stdout (在 transport 实现里)
 *  - JSON.parse 单行有 maxLineBytes 守卫, 超限只处置这一条消息 (见 handleOversizedLine)
 *  - 主线程不被任何同步操作卡 — handler 全是 async fn
 */

import type { Logger } from '../../../interfaces/logger.js';
import {
  JSONRPC_ERROR_CODE,
  Method,
  type ClientInfo,
  type IncomingMessage,
  type InitializeCapabilities,
  type InitializeParams,
  type InitializeResponse,
  type JsonRpcErrorObject,
  type JsonRpcId,
  type TurnInterruptParams,
} from './protocol.js';
import { isCodexResponseTimingLine, parseCodexResponseTiming, type CodexResponseTiming } from './response-timing.js';
import type { Transport, TransportCloseInfo } from './transport.js';

/**
 * 单条 NDJSON line 的上限, 按 JS 字符串长度 (UTF-16 code unit) 计, 不是字节。
 * Codex 单 notification 正常 < 1MB; 设 16Mi 给极端 reasoning text 留余量。超限的行不做
 * JSON.parse (避免主线程卡几百 ms), 只读开头的信封决定怎么处置这一条, 见 handleOversizedLine。
 */
const DEFAULT_MAX_LINE_BYTES = 16 * 1024 * 1024;
/** 识别超限行信封时, 行首和行尾各最多读这么多字符; diff / 文件内容这类大字段不在读取范围内。 */
const OVERSIZED_ENVELOPE_PEEK_CHARS = 4_096;
const MAX_STDERR_LOG_CHARS = 2_000;
// Covers the SSH host's five 20 s attempts plus 31 s of backoff. The host
// normally supplies the terminal result; this cap also covers wedged auth I/O.
const SSH_RECONNECT_WAIT_TIMEOUT_MS = 150_000;
const SSH_TURN_RESTORE_TIMEOUT_MS = 12_000;
const MAX_RECOVERY_THREADS = 16;

type RecoveredItem = { id: string; type: string; status?: string };
type RecoveredTurn = { id: string; status: string; items: RecoveredItem[] };
type ObservedTurn = { id: string; completedItems: Set<string>; restoredItems: Set<string> };
type RecoveryMessage = { line: string; message: { id?: JsonRpcId; method: string; params?: unknown } };
type RecoveryInterrupt = {
  params: TurnInterruptParams;
  result: ReturnType<typeof Promise.withResolvers<unknown>>;
};
type TransportRecovery = {
  controller: AbortController;
  messages: RecoveryMessage[];
  size: number;
  ownedThreads: ReadonlySet<string>;
  reconnected: boolean;
  replaying?: boolean;
  interrupts: Map<string, RecoveryInterrupt>;
  ready: ReturnType<typeof Promise.withResolvers<Error | undefined>>;
  acknowledgedStarts: Array<{ id: JsonRpcId; request: PendingRequest; threadId: string; turnId: string }>;
};

/** 响应超过单行上限被丢弃: 只有对应的这一个请求失败, 连接继续可用。 */
export class AppServerMessageTooLargeError extends Error {
  constructor(
    public readonly method: string,
    public readonly length: number,
    public readonly limit: number,
  ) {
    super(`codex app-server ${method} response exceeds maxLineBytes (${length} > ${limit})`);
    this.name = 'AppServerMessageTooLargeError';
  }
}

/**
 * 超限通知的信封, 正文已丢弃。字段从行首或行尾读取, 读不到时为空: turn/diff/updated 的
 * threadId / turnId 排在 diff 之前, item/* 的排在 item 之后; itemId / itemType 是 item 里
 * 排在大字段之前的标量。turn/completed 的 turnId 取 turn.id, turn 是 turn 在大字段 (items)
 * 之后的成员 (status / error / 时间戳)。
 */
export interface OversizedNotification {
  method: string;
  threadId?: string;
  turnId?: string;
  itemId?: string;
  itemType?: string;
  itemStatus?: string;
  turn?: Record<string, unknown>;
  /** 原始行长度 (UTF-16 code unit)。 */
  length: number;
}

interface OversizedEnvelope extends Partial<Omit<OversizedNotification, 'length'>> {
  id?: JsonRpcId;
}

/** 信封读取只进入 message → params → params.item / params.turn 这几层。 */
type EnvelopeScope = 'message' | 'params' | 'item' | 'turn';

const ENVELOPE_MEMBER_RE = /\s*"((?:[^"\\]|\\.)*)"\s*:\s*/y;
const ENVELOPE_SCALAR_RE = /"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y;
const ENVELOPE_SEPARATOR_RE = /\s*([,}])/y;

function recordEnvelopeMember(
  envelope: OversizedEnvelope,
  scope: EnvelopeScope,
  key: string,
  raw: string,
): void {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return;
  }
  if (scope === 'message') {
    if (key === 'id' && (typeof value === 'number' || typeof value === 'string')) envelope.id = value;
    else if (key === 'method' && typeof value === 'string') envelope.method = value;
    return;
  }
  if (typeof value !== 'string') return;
  if (scope === 'params') {
    if (key === 'threadId') envelope.threadId ??= value;
    else if (key === 'turnId') envelope.turnId ??= value;
  } else if (scope === 'turn') {
    if (key === 'id') envelope.turnId ??= value;
  } else if (key === 'id') {
    envelope.itemId = value;
  } else if (key === 'type') {
    envelope.itemType = value;
  } else if (key === 'status') {
    envelope.itemStatus = value;
  }
}

/**
 * 从 `{` 起顺序读标量成员; 遇到路径之外的对象、数组, 或读不完的长字符串 (大字段) 就停。
 */
function readEnvelopeMembers(text: string, envelope: OversizedEnvelope): void {
  let pos = text.search(/\S/);
  if (pos < 0 || text[pos] !== '{') return;
  pos += 1;
  const scopes: EnvelopeScope[] = ['message'];
  for (;;) {
    const current = scopes[scopes.length - 1]!;
    ENVELOPE_MEMBER_RE.lastIndex = pos;
    const member = ENVELOPE_MEMBER_RE.exec(text);
    if (!member) return;
    pos = ENVELOPE_MEMBER_RE.lastIndex;
    const key = member[1]!;
    const nested = current === 'message' && key === 'params'
      ? 'params'
      : current === 'params' && (key === 'item' || key === 'turn')
        ? key
        : null;
    if (nested && text[pos] === '{') {
      scopes.push(nested);
      if (nested === 'turn') envelope.turn ??= {};
      pos += 1;
      continue;
    }
    ENVELOPE_SCALAR_RE.lastIndex = pos;
    const scalar = ENVELOPE_SCALAR_RE.exec(text);
    if (!scalar) return;
    // 标量后面必须紧跟分隔符, 防止把截在读取边界上的半个数字当成完整值。
    ENVELOPE_SEPARATOR_RE.lastIndex = ENVELOPE_SCALAR_RE.lastIndex;
    let separator = ENVELOPE_SEPARATOR_RE.exec(text);
    if (!separator) return;
    pos = ENVELOPE_SEPARATOR_RE.lastIndex;
    recordEnvelopeMember(envelope, current, key, scalar[0]);
    // `}` 关闭当前对象, 回到外层继续读; 外层同样必须紧跟分隔符。
    while (separator[1] === '}') {
      scopes.pop();
      if (scopes.length === 0) return;
      ENVELOPE_SEPARATOR_RE.lastIndex = pos;
      separator = ENVELOPE_SEPARATOR_RE.exec(text);
      if (!separator) return;
      pos = ENVELOPE_SEPARATOR_RE.lastIndex;
    }
  }
}

/**
 * 从行尾读出某一层对象收尾处的成员 (可以含 turn.error 这样的嵌套对象), 不碰前面的大字段。
 * `closers` 是这一层连同外层要关闭的右括号总数: params 为 2, params.turn 为 3。取能解析成
 * JSON 的最长成员序列: 起点落在大字段内部或更深的嵌套里时, 剩余部分括号不配平, 解析不了。
 */
function readTrailingMembers(line: string, closers: number): Record<string, unknown> | null {
  const tail = line.slice(-OVERSIZED_ENVELOPE_PEEK_CHARS);
  const closing = new RegExp(String.raw`(?:\s*\}){${closers}}\s*$`).exec(tail);
  if (!closing) return null;
  const body = tail.slice(0, closing.index);
  for (let pos = body.indexOf(',"'); pos !== -1; pos = body.indexOf(',"', pos + 1)) {
    try {
      const members: unknown = JSON.parse(`{${body.slice(pos + 1)}}`);
      if (members && typeof members === 'object') return members as Record<string, unknown>;
    } catch {
      // 起点不在这一层的成员边界上, 换下一个。
    }
  }
  return null;
}

/**
 * 只读超限行两端, 不碰中间的大字段。app-server 由 serde 按结构体声明顺序输出:
 *  - id / method 在最前;
 *  - turn/diff/updated 的 threadId / turnId 在 diff 之前, 从行首读到;
 *  - item/* 的 threadId / turnId 在 item 之后, 从行尾读到, item 自身的 type / id 在大字段之前;
 *  - turn/completed 的 turn.id 在 items 之前, status / error 等在 items 之后, 分别从两端读到。
 * 两端都读不到的字段留空, 由调用方按「认不出」保守处理。
 */
function peekOversizedEnvelope(line: string): OversizedEnvelope {
  const envelope: OversizedEnvelope = {};
  readEnvelopeMembers(line.slice(0, OVERSIZED_ENVELOPE_PEEK_CHARS), envelope);
  if (envelope.turn) {
    Object.assign(envelope.turn, readTrailingMembers(line, 3));
  } else if (envelope.threadId === undefined || envelope.turnId === undefined) {
    const params = readTrailingMembers(line, 2);
    if (typeof params?.threadId === 'string') envelope.threadId ??= params.threadId;
    if (typeof params?.turnId === 'string') envelope.turnId ??= params.turnId;
  }
  return envelope;
}

/** A correlated native error response, distinct from an unconfirmed transport failure. */
export class AppServerResponseError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(method: string, error: JsonRpcErrorObject) {
    super(`codex app-server ${method} error ${error.code}: ${error.message}`);
    this.code = error.code;
    this.data = error.data;
  }
}

export class AppServerRequestTimeoutError extends Error {
  constructor(
    public readonly method: string,
    public readonly timeoutMs: number,
    /** 超时时的诊断(只含计数与耗时)，附在消息末尾。 */
    detail?: string,
  ) {
    super(`codex app-server ${method} timed out after ${timeoutMs}ms${detail ? ` (${detail})` : ''}`);
    this.name = 'AppServerRequestTimeoutError';
  }
}

/**
 * 有进展就顺延的请求上限：到 timeoutMs 时若最近 idleMs 内仍有进展就继续等，直到连续 idleMs 没有
 * 进展，或从发出起等满 maxMs。用于设备托管会话：线程启动要经设备互联逐个读项目文件，慢链路下
 * 合法地超过固定上限(#5764)；真正卡住(没有任何往来)时仍按原上限结束。
 */
export interface RequestProgressDeadline {
  /** 最近一次有进展的时间(Date.now 毫秒)；没有记录时为 null。 */
  lastProgressAt(): number | null;
  idleMs: number;
  maxMs: number;
  /** 超时时附在错误消息里的诊断。 */
  describe?(): string;
}

/**
 * Keep a small bounded correlation window for writes that rejected after the
 * transport may already have handed bytes to the OS / websocket buffer.
 */
const MAX_WRITE_FAILURE_TOMBSTONES = 128;
// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC 是 ANSI escape 序列的协议字节。
const ANSI_ESCAPE_RE = /\x1B\[[0-?]*[ -/]*[@-~]/g;

function normalizeStderrLine(line: string): string {
  if (line.length <= MAX_STDERR_LOG_CHARS) return line;
  const omitted = line.length - MAX_STDERR_LOG_CHARS;
  return `${line.slice(0, MAX_STDERR_LOG_CHARS)}... [truncated ${omitted} chars]`;
}

const NORMALIZE_ORPHAN_OUTPUT_RE =
  /\bcodex_core::context_manager::normalize:\s*Orphan (?:function call|custom tool call|tool search) output for call id:\s*\S+/;

const RMCP_TARGET_RE =
  /\b(rmcp(?:::[A-Za-z0-9_]+)*|codex_rmcp_client(?:::[A-Za-z0-9_]+)*):\s*([^\r\n]+)$/;

const UNEXPECTED_DELETE_HTTP_STATUS_RE = /\b(?:401|403|429|5\d\d)\b/;

/**
 * Benign stderr warnings/errors emitted by codex-rs or rmcp:
 * 1. `codex_core::context_manager::normalize` strips orphaned `*_output` items left by
 *    history truncation/compaction/interruption before calling Responses API, re-logging
 *    `WARN` on every subsequent request of that thread.
 * 2. `rmcp` / `codex_rmcp_client` teardown messages, gated by Rust module target, client
 *    closing state (`closing === true`), and expected outcomes:
 *    - During active runs (`closing === false`), only `Server does not support delete session`,
 *      `fail to delete session:` with an expected already-closed `404` / `Unknown session`
 *      from `codexHttpBridge.closeSessionInstance`, and intentional `ClientClosed` / `Cancelled`
 *      worker exits are downgraded. Mid-run `TransportClosed`, transport fatal closes, and
 *      `fail to delete session` with `401`/`403`/`5xx`/timeouts stay `warn` / `error`.
 *    - During client shutdown (`closing === true`), transport/sink/session close races on
 *      `rmcp` / `codex_rmcp_client` are also downgraded, while `401`/`403`/`5xx` delete
 *      failures, protocol/handshake/startup errors, join panics, and non-close I/O fatals
 *      still surface as `warn` / `error`.
 */
function isBenignCodexStderrNoise(plain: string, closing: boolean): boolean {
  if (NORMALIZE_ORPHAN_OUTPUT_RE.test(plain)) return true;
  const rmcpMatch = RMCP_TARGET_RE.exec(plain);
  if (!rmcpMatch) return false;
  const target = rmcpMatch[1]!;
  const body = rmcpMatch[2]!.trim();

  if (target.startsWith('rmcp::transport::streamable_http_client')) {
    if (/^Server does not support delete session\b/i.test(body)) return true;
    if (/^fail to delete session:\s*/i.test(body)) {
      if (UNEXPECTED_DELETE_HTTP_STATUS_RE.test(body)) return false;
      if (/\b(?:404\b|unknown session\b|session not found\b)/i.test(body)) return true;
      return closing && /\b(?:connection refused|channel closed|broken pipe|connection reset)\b/i.test(body);
    }
    if (closing && /^session cleanup timed out after\b/i.test(body)) return true;
    return false;
  }

  if (target.startsWith('rmcp::transport::worker')) {
    if (/^worker quit with reason:\s*(?:ClientClosed|Cancelled)\b/.test(body)) return true;
    if (!closing) return false;
    return (
      /^worker quit with reason:\s*(?:TransportClosed|HandlerTerminated|StreamClosed)\b/.test(body) ||
      /^worker quit with fatal:\s*(?:Transport (?:channel |\[[^\r\n\]]+\]\s*(?:channel )?)?(?:is )?closed|Channel closed)\b/i.test(
        body,
      )
    );
  }

  if (!closing) return false;

  if (target.startsWith('rmcp::service')) {
    if (/^fail to close sink\b/i.test(body)) return true;
    if (/^Failed to close session\b/i.test(body) && !UNEXPECTED_DELETE_HTTP_STATUS_RE.test(body)) {
      return true;
    }
    return false;
  }

  if (target.startsWith('codex_rmcp_client')) {
    return /^Could not schedule remote MCP server process termination on drop\b/i.test(body);
  }

  return false;
}

export function classifyStderrLine(
  line: string,
  opts?: { closing?: boolean },
): 'debug' | 'warn' | 'error' {
  const plain = line.replace(ANSI_ESCAPE_RE, '').trim();
  if (!plain) return 'debug';
  if (isBenignCodexStderrNoise(plain, opts?.closing === true)) return 'debug';
  if (/\b(warn|warning)\b/i.test(plain)) return 'warn';
  if (
    /\b(error|fatal|panic|panicked|exception|unhandled|aborted|stack backtrace)\b/i.test(plain) ||
    /^error:/i.test(plain)
  ) {
    return 'error';
  }
  return 'debug';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Detect a definitive Codex authentication failure from a correlated JSON-RPC
 * error response. Codex Desktop uses this same protocol boundary: stderr stays
 * diagnostic-only, while auth state changes require a structured Auth/relogin
 * signal from app-server (cloudRequirements / cloudConfigBundle), or the
 * narrowly-matched config-load wrapper around codex-rs' permanent token
 * refresh failure.
 */
export function detectAuthInvalidationReason(
  error: JsonRpcErrorObject,
  method?: string,
): string | null {
  const data = isRecord(error.data) ? error.data : null;
  // 两种结构化 provenance 都是 app-server 主动声明的鉴权失效:
  //  - cloudRequirements: turn 级 cloud 依赖检查失败 (Auth/relogin)。
  //  - cloudConfigBundle: 配置加载阶段 cloud config bundle 拉取撞鉴权失败
  //    (config_errors.rs 对 Auth code 附 action=relogin)。
  const hasStructuredAuthSignal =
    (data?.reason === 'cloudRequirements' || data?.reason === 'cloudConfigBundle') &&
    (data?.errorCode === 'Auth' || data?.action === 'relogin');
  // 文本兜底 (窄门): 非 cloud-config-bundle 的错误链不带结构化 data, 但 message 仍是
  // app-server 生成的 "failed to load configuration: {err}" 包装; 其中 codex-rs 的
  // "Your access token could not be refreshed ..." 句族只出自永久性 refresh 失败
  // (revoked / expired / reused / account mismatch), 重试必然复现。两段都要求命中,
  // 避免 correlated response error 里偶发回显的孤立关键词触发凭证清除。
  const isTextualConfigLoadRefreshFailure =
    !hasStructuredAuthSignal &&
    /failed to load configuration:/i.test(error.message) &&
    /access token could not be refreshed/i.test(error.message);
  // account/rateLimits/read 与 reset-credit consume 是明确绑定 ChatGPT OAuth 账号的
  // 控制面 RPC。codex-rs 当前会把 wham/usage 的 401 包成普通 -32603，既没有
  // cloudRequirements provenance，也没有 config-load 包装；但 method 已由 request id
  // 可靠关联。只对这两个账号级 RPC 放行「401 + 机器可读 token 原因」窄门，避免工具
  // 输出或 model/list 偶然回显 token_revoked 时误清凭证。
  const isAccountAuthRpc =
    method === Method.AccountRateLimitsRead ||
    method === Method.AccountRateLimitResetCreditConsume;
  const isCorrelatedAccountAuthFailure =
    isAccountAuthRpc &&
    /\b401\b|Unauthorized/i.test(error.message) &&
    /token_revoked|token_invalidated|refresh token (?:was|has been) revoked|refresh token was already used|refresh_token.*already used/i.test(
      error.message,
    );
  if (
    !hasStructuredAuthSignal &&
    !isTextualConfigLoadRefreshFailure &&
    !isCorrelatedAccountAuthFailure
  ) {
    return null;
  }

  const nestedError = isRecord(data?.error) ? data.error : null;
  const diagnostic = [
    error.message,
    typeof data?.message === 'string' ? data.message : '',
    typeof data?.detail === 'string' ? data.detail : '',
    typeof data?.code === 'string' ? data.code : '',
    typeof nestedError?.message === 'string' ? nestedError.message : '',
    typeof nestedError?.code === 'string' ? nestedError.code : '',
  ].join('\n');

  if (/app_session_terminated|Your session has ended/i.test(diagnostic)) {
    return 'app_session_terminated';
  }
  if (/token_invalidated|authentication token has been invalidated/i.test(diagnostic)) {
    return 'token_invalidated';
  }
  if (
    /token_revoked|authentication token has been revoked|refresh token (?:was|has been) revoked/i.test(
      diagnostic,
    )
  ) {
    return 'token_revoked';
  }
  if (/refresh token was already used|refresh_token.*already used/i.test(diagnostic)) {
    return 'refresh_token_reused';
  }

  // Both gates above are definitive on their own (structured Auth/relogin, or the
  // permanent refresh-failure sentence family — e.g. the "has expired" / account
  // mismatch variants) even without a provider-specific token error code.
  return 'token_invalidated';
}

export interface AppServerClientOptions {
  /** Live thread owners to reattach when a reconnectable transport is replaced. */
  getSubscribedThreadIds?: () => string[];
  getRecoveryRootThreadId?: (threadId: string) => string | undefined;
  /**
   * Transport 工厂; 在 start() 时调用一次, 之后由 client 独占 transport 生命周期。
   *
   * 为什么是 factory 而非 instance: client 必须保证 "register handlers → start transport"
   * 的顺序 — 否则 stdin/stdout 已经在产数据但 onNotification handler 还没注册时, line 会
   * 直接走 "unhandled notification" 丢掉。factory 把 transport 的实际启动 (spawn / ssh
   * exec / ws handshake) 推迟到 start() 那一刻, 跟原版 spawnProcess() 时序等价。
   */
  createTransport: () => Transport;
  logger: Logger;
  /** 单行 NDJSON 上限 (UTF-16 code unit), 缺省 16Mi。超限的处置见 handleOversizedLine。 */
  maxLineBytes?: number;
  /**
   * 已注册 handler 的通知超过单行上限时调用, 正文已丢弃。返回 true 表示上层已安全降级;
   * 返回 false 或未提供时沿用整连接退役 —— 只有上层知道丢掉哪种通知不会卡住任务。
   */
  onOversizedNotification?: (notification: OversizedNotification) => boolean;
  /**
   * Server-reported generation time of one response, read from Codex's timing trace
   * line on stderr (see response-timing.ts). Display only; the line is not logged.
   */
  onResponseTiming?: (timing: CodexResponseTiming) => void;
  /**
   * Transport 异常退出 / IO 错误时调用; 上层 (CodexAgent) 用它 emit
   * `error` AgentEvent + end event queue。
   */
  onTransportError?: (err: Error) => void;
  /**
   * 关联中的 JSON-RPC response 明确返回 cloudRequirements Auth/relogin 时调用一次。
   * 任意 stderr 与工具输出均不得触发；上层 (CodexAgent) 用它注销旧凭证并通知 UI 重登。
   */
  onAuthInvalidated?: (
    reason: string,
    context?: { credentialGeneration?: string | null },
  ) => void;
  /**
   * Return the generation frozen for this concrete transport. It must not resnapshot mutable
   * credential storage; the client binds the returned host fact to each correlated request id.
   */
  captureCredentialGeneration?: () => string | null;
}

export type NotificationHandler = (params: unknown) => void | Promise<void>;
export type ServerRequestHandler = (
  params: unknown,
  meta: { id: JsonRpcId; method: string },
) => Promise<unknown>;

export interface AppServerRequestOptions {
  timeoutMs?: number;
  extendWhileProgress?: RequestProgressDeadline;
  beforeDispatch?: () => void;
  /** Cancels a request before it is sent. */
  signal?: AbortSignal;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  method: string;
  start?: { threadId: string; turnId?: string };
  credentialGeneration?: string | null;
  timeoutId: ReturnType<typeof setTimeout> | null;
}

/**
 * 单 session 单实例 (plan D5)。oneShot 也单独 spawn 一个。
 */
export class AppServerClient {
  private readonly logger: Logger;
  private readonly maxLineBytes: number;
  private readonly onOversizedNotification?: AppServerClientOptions['onOversizedNotification'];
  private readonly onResponseTiming?: AppServerClientOptions['onResponseTiming'];
  private readonly onTransportError?: (err: Error) => void;
  private readonly onAuthInvalidated?: AppServerClientOptions['onAuthInvalidated'];
  private readonly captureCredentialGeneration?: () => string | null;
  /** 单次 latch — 结构化鉴权失败只通知一次, 防 cloud_requirements 周期性 retry 刷屏。 */
  private authInvalidatedFired = false;

  private readonly createTransport: () => Transport;
  private transport: Transport | null = null;
  private started = false;

  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  /**
   * A write callback can report failure after the peer has already received
   * the request. Preserve only the request id/method so a late structured auth
   * error remains correlated without keeping the already-rejected Promise.
   */
  private readonly writeFailureTombstones = new Map<
    JsonRpcId,
    { method: string; credentialGeneration?: string | null }
  >();
  private readonly notificationHandlers = new Map<string, NotificationHandler>();
  private readonly requestHandlers = new Map<string, ServerRequestHandler>();

  private initialized = false;
  private initializeParams: InitializeParams | undefined;
  private recovery: TransportRecovery | undefined;
  private readonly activeTurns = new Map<string, ObservedTurn>();
  private readonly restoredTerminals = new Map<string, string>();
  private serverRequestsInFlight = 0;
  private readonly getSubscribedThreadIds?: () => string[];
  private readonly getRecoveryRootThreadId?: AppServerClientOptions['getRecoveryRootThreadId'];
  /** close() 调用后置 true, 阻止后续 request / 重复 close 的副作用。 */
  private closed = false;
  private closePromise: Promise<void> | null = null;

  constructor(opts: AppServerClientOptions) {
    if (typeof opts.createTransport !== 'function') {
      throw new Error('AppServerClient: createTransport factory is required');
    }
    this.createTransport = opts.createTransport;
    this.getSubscribedThreadIds = opts.getSubscribedThreadIds;
    this.getRecoveryRootThreadId = opts.getRecoveryRootThreadId;
    this.logger = opts.logger.child('codex-app-server');
    this.maxLineBytes = opts.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    this.onOversizedNotification = opts.onOversizedNotification;
    this.onResponseTiming = opts.onResponseTiming;
    this.onTransportError = opts.onTransportError;
    this.onAuthInvalidated = opts.onAuthInvalidated;
    this.captureCredentialGeneration = opts.captureCredentialGeneration;
  }

  /**
   * 启动 transport (调 factory) + 接管 onLine/onStderr/onClose。
   * 必须在所有 onNotification / setRequestHandler 注册完毕之后调用一次,
   * 否则 transport 刚启动就推出的 banner / 启动通知会落到 "unhandled notification".
   *
   * 与 initialize() 的关系: start() 只激活 transport, initialize() 发握手 RPC。
   * 必须先 start() 后 initialize()。
   */
  start(): void {
    if (this.started) {
      throw new Error('AppServerClient: already started');
    }
    if (this.closed) {
      throw new Error('AppServerClient: cannot start after close()');
    }
    this.started = true;
    const transport = this.createTransport();
    this.attachTransport(transport);
  }

  private attachTransport(transport: Transport): void {
    this.transport = transport;
    transport.onLine((line) => {
      if (this.transport === transport && !this.closed) this.handleLine(line);
    });
    transport.onStderr?.((line) => {
      if (this.transport === transport) this.handleStderrLine(line);
    });
    transport.onClose((info) => {
      if (this.transport === transport) this.handleTransportClose(info);
    });
  }

  // ── 生命周期 ──────────────────────────────────────────────────────────────

  /**
   * 必须在 transport 已经连通后第一件事调用。返回 server 端 InitializeResponse。
   * 重复调用会被守卫拒绝。
   */
  async initialize(
    clientInfo: ClientInfo,
    capabilities?: InitializeCapabilities,
  ): Promise<InitializeResponse> {
    if (!this.started) {
      throw new Error('AppServerClient: must start() before initialize()');
    }
    if (this.closed) {
      throw new Error('AppServerClient: cannot initialize after close()');
    }
    if (this.initialized) {
      throw new Error('AppServerClient: already initialized');
    }
    const params: InitializeParams = { clientInfo, capabilities };
    const response = await this.request<InitializeResponse>(Method.Initialize, params);
    this.initialized = true;
    this.initializeParams = params;
    this.logger.info('initialized', {
      userAgent: response.userAgent,
      codexHome: response.codexHome,
      platformOs: response.platformOs,
    });
    return response;
  }

  async sampleResumeStack(): Promise<string[]> {
    return await this.transport?.sampleResumeStack?.() ?? [];
  }

  /** Only local transports can prove this pre-protocol failure and process exit. */
  nativeSqliteInitializationFailed(): boolean {
    return !this.initialized && this.transport?.nativeSqliteInitializationFailed?.() === true;
  }

  /**
   * close() 是幂等的; reason 仅用于 reject pending requests 的错误消息。
   * - reject 所有挂起 promise
   * - 关闭 transport (杀子进程 / 关 ssh channel)
   */
  async close(opts?: { reason?: string; throwOnTransportError?: boolean }): Promise<void> {
    if (!this.closePromise) {
      this.closed = true;
      const recovery = this.recovery;
      recovery?.controller.abort();
      this.recovery = undefined;
      this.activeTurns.clear();
      this.restoredTerminals.clear();
      const reason = opts?.reason ?? 'AppServerClient.close()';
      // 缓存未吞错的完成结果，各调用方独立选择是否传播失败。
      const closePromise = Promise.resolve().then(() => this.transport?.close(reason)).catch((error) => {
        // 保留 closed，后续调用仅重查幂等关闭，不重新开放协议。
        if (this.closePromise === closePromise) this.closePromise = null;
        this.logger.warn('transport.close threw', { message: (error as Error).message });
        throw error;
      });
      this.closePromise = closePromise;

      // reject 所有挂起 request — 包括正在 initialize 的调用。
      const err = new Error(`codex app-server closed: ${reason}`);
      recovery?.ready.resolve(err);
      for (const { request } of recovery?.acknowledgedStarts ?? []) request.reject(err);
      for (const interrupt of recovery?.interrupts.values() ?? []) interrupt.result.reject(err);
      for (const [, pending] of this.pending) {
        if (pending.timeoutId) clearTimeout(pending.timeoutId);
        pending.reject(err);
      }
      this.pending.clear();
      this.writeFailureTombstones.clear();
    }
    try {
      await this.closePromise;
    } catch (error) {
      if (opts?.throwOnTransportError) throw error;
    }
  }

  // ── 请求 / 通知 / handler 注册 ────────────────────────────────────────────

  /**
   * 发送一个 JSON-RPC request, 等待对应 id 的 response。
   * server 返回 error 时 reject 一个携带 code+message 的 Error。
   * `extendWhileProgress` 只在给了 timeoutMs 时生效(见 RequestProgressDeadline)。
   */
  request<R = unknown>(
    method: string,
    params?: unknown,
    opts?: AppServerRequestOptions,
  ): Promise<R> {
    const recovery = this.recovery;
    if (!recovery) return this.sendRequest<R>(method, params, opts);

    const startsTask = method === Method.ThreadStart || method === Method.ThreadResume ||
      method === Method.ThreadFork || method === Method.TurnStart;
    if (startsTask) return this.requestAfterRecovery<R>(method, params, opts);
    if (recovery.replaying) return this.sendRequest<R>(method, params, opts);

    // Stop is a new user intent, not a replay of an uncertain write. Keep it
    // only for the acknowledged turn this recovery is already tracking.
    if (method === Method.TurnInterrupt && params && typeof params === 'object') {
      if (opts?.signal?.aborted) return Promise.reject(opts.signal.reason);
      const { threadId, turnId } = params as Partial<TurnInterruptParams>;
      if (threadId && turnId && recovery.ownedThreads.has(threadId) && this.activeTurns.get(threadId)?.id === turnId) {
        let interrupt = recovery.interrupts.get(threadId);
        if (!interrupt) {
          interrupt = { params: { threadId, turnId }, result: Promise.withResolvers<unknown>() };
          recovery.interrupts.set(threadId, interrupt);
        }
        return interrupt.result.promise as Promise<R>;
      }
    }
    return Promise.reject(new Error('Codex SSH transport is reconnecting'));
  }

  private async requestAfterRecovery<R>(
    method: string, params: unknown, opts?: AppServerRequestOptions,
  ): Promise<R> {
    const timeoutMs = opts?.timeoutMs ?? SSH_RECONNECT_WAIT_TIMEOUT_MS + SSH_TURN_RESTORE_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error(`AppServerClient.request(${method}): timeoutMs must be a positive finite number`);
    }
    const deadline = Date.now() + timeoutMs;
    while (this.recovery) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new AppServerRequestTimeoutError(method, timeoutMs);
      const signal = opts?.signal;
      signal?.throwIfAborted();
      const { ready } = this.recovery;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abort: (() => void) | undefined;
      try {
        const error = await Promise.race([
          ready.promise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new AppServerRequestTimeoutError(method, timeoutMs)), remaining);
            timer.unref?.();
            abort = () => reject(signal?.reason);
            signal?.addEventListener('abort', abort, { once: true });
          }),
        ]);
        if (error) throw error;
      } finally {
        clearTimeout(timer);
        if (abort) signal?.removeEventListener('abort', abort);
      }
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new AppServerRequestTimeoutError(method, timeoutMs);
    return this.sendRequest<R>(method, params, { ...opts, timeoutMs: opts?.timeoutMs === undefined ? undefined : remaining });
  }

  private sendRequest<R>(
    method: string,
    params?: unknown,
    opts?: AppServerRequestOptions,
  ): Promise<R> {
    if (this.closed) {
      return Promise.reject(new Error(`AppServerClient.request(${method}) after close()`));
    }
    if (!this.transport) {
      return Promise.reject(new Error(`AppServerClient.request(${method}): not started`));
    }
    const transport = this.transport;
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    let credentialGeneration: string | null | undefined;
    try {
      credentialGeneration = this.captureCredentialGeneration?.();
    } catch (error) {
      credentialGeneration = null;
      this.logger.warn('credential generation capture failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    const timeoutMs = opts?.timeoutMs;
    if (
      timeoutMs !== undefined &&
      (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    ) {
      return Promise.reject(
        new Error(`AppServerClient.request(${method}): timeoutMs must be a positive finite number`),
      );
    }
    try {
      opts?.signal?.throwIfAborted();
      opts?.beforeDispatch?.();
    } catch (error) {
      return Promise.reject(error);
    }
    const threadId = method === Method.TurnStart && transport.reconnect
      ? (params as { threadId?: unknown } | undefined)?.threadId : undefined;
    return new Promise<R>((resolve, reject) => {
      const pending: PendingRequest = {
        resolve: resolve as (v: unknown) => void,
        reject,
        method,
        credentialGeneration,
        ...(typeof threadId === 'string' && threadId ? { start: { threadId } } : {}),
        timeoutId: null,
      };
      this.pending.set(id, pending);
      if (timeoutMs !== undefined) {
        const progress = opts?.extendWhileProgress;
        const startedAt = Date.now();
        let extended = false;
        const expire = (): void => {
          if (this.pending.get(id) !== pending) return;
          if (progress) {
            const now = Date.now();
            let last: number | null = null;
            try {
              last = progress.lastProgressAt();
            } catch {
              last = null;
            }
            const idleLeft = last === null ? 0 : progress.idleMs - (now - last);
            const capLeft = progress.maxMs - (now - startedAt);
            if (idleLeft > 0 && capLeft > 0) {
              extended = true;
              pending.timeoutId = setTimeout(expire, Math.min(idleLeft, capLeft));
              pending.timeoutId.unref?.();
              return;
            }
          }
          this.pending.delete(id);
          let detail: string | undefined;
          try {
            detail = progress?.describe?.();
          } catch {
            detail = undefined;
          }
          // 没顺延过时照旧报配置的上限；顺延过报实际等了多久。
          reject(new AppServerRequestTimeoutError(method, extended ? Date.now() - startedAt : timeoutMs, detail));
        };
        pending.timeoutId = setTimeout(expire, timeoutMs);
        pending.timeoutId.unref?.();
      }
      transport.writeLine(payload).then(undefined, (err: Error) => {
        // transport 拒绝就立刻 reject 这一 request, 不要让它在 pending 里等到 close。
        // 只有 response 尚未先到时才留 tombstone；否则迟到的 write callback 不应
        // 重新关联已经完成的 id。
        if (this.pending.get(id) !== pending) return;
        this.pending.delete(id);
        if (pending.timeoutId) clearTimeout(pending.timeoutId);
        this.rememberWriteFailure(id, method, credentialGeneration);
        reject(err);
      });
    });
  }

  onNotification(method: string, handler: NotificationHandler): void {
    if (this.notificationHandlers.has(method)) {
      this.logger.warn('overwriting notification handler', { method });
    }
    this.notificationHandlers.set(method, handler);
  }

  setRequestHandler(method: string, handler: ServerRequestHandler): void {
    if (this.requestHandlers.has(method)) {
      this.logger.warn('overwriting request handler', { method });
    }
    this.requestHandlers.set(method, handler);
  }

  // ── 内部: 入站消息分发 ───────────────────────────────────────────────────

  private handleLine(line: string, replayingRecovery = false): void {
    if (!line) return;
    if (line.length > this.maxLineBytes) {
      if (this.recovery) {
        this.handleTransportFailure(new Error('Codex SSH recovery exceeded the line limit'));
      } else {
        this.handleOversizedLine(line);
      }
      return;
    }

    let msg: IncomingMessage;
    try {
      msg = JSON.parse(line) as IncomingMessage;
    } catch (e) {
      // 非法 JSON: 单行错误不杀 session (server 可能偶尔吐 banner), warn 跳过。
      this.logger.warn('invalid JSON line', {
        message: (e as Error).message,
        preview: line.slice(0, 200),
      });
      return;
    }

    // 三类区分 (jsonrpc_lite.rs untagged enum 顺序: Request → Notification → Response → Error)
    // - id 存在 + method 存在 → ServerRequest
    // - id 存在 + result 存在 → 我们 request 的 SuccessResponse
    // - id 存在 + error 存在 → 我们 request 的 ErrorResponse
    // - id 不存在 + method 存在 → Notification
    if ('method' in msg && this.recovery && !replayingRecovery) {
      const recovery = this.recovery;
      recovery.size += line.length;
      if (recovery.size > this.maxLineBytes) recovery.controller.abort();
      else recovery.messages.push({ line, message: msg });
      return;
    }
    if ('id' in msg && 'method' in msg) {
      this.serverRequestsInFlight++;
      void this.dispatchServerRequest(msg).finally(() => { this.serverRequestsInFlight--; });
      return;
    }
    if ('id' in msg && 'result' in msg) {
      this.dispatchResponse(msg.id, msg.result, null);
      return;
    }
    if ('id' in msg && 'error' in msg) {
      this.dispatchResponse(msg.id, null, msg.error);
      return;
    }
    if ('method' in msg) {
      const params = (msg as { params?: unknown }).params;
      const trackTurns = this.transport?.reconnect || this.activeTurns.size || this.restoredTerminals.size;
      if (trackTurns && this.observeTurn(msg.method, params)) return;
      void this.dispatchNotification(msg.method, params);
      return;
    }
    this.logger.warn('unrecognized incoming message', { preview: line.slice(0, 200) });
  }

  /**
   * 超限的一行只影响它自己。一个 host 由多个会话共享, 整连接退役会把挂在上面的全部在飞任务
   * 一起打断, 所以按信封分别处置:
   *  - 我们请求的响应: 只让对应请求失败;
   *  - server 发来的请求: 回 JSON-RPC error, 免得 server 一直等;
   *  - 没人订阅的通知: 本来就会被忽略, 直接丢;
   *  - 已订阅的通知: 交给 onOversizedNotification, 它确认能安全降级才丢。
   * 认不出信封, 或上层不能丢这条通知 (turn/completed 之类状态机消息, 丢了任务永远等不到终态)
   * 时, 沿用整连接退役。
   */
  private handleOversizedLine(line: string): void {
    const length = line.length;
    const limit = this.maxLineBytes;
    const { id, method, ...scope } = peekOversizedEnvelope(line);
    if (id !== undefined && method !== undefined) {
      this.logger.warn('oversized server request rejected', { method, id, length, limit });
      void this.sendErrorResponse(id, {
        code: JSONRPC_ERROR_CODE.INVALID_REQUEST,
        message: `${method} request exceeds client line limit (${length} > ${limit})`,
      });
      return;
    }
    if (id !== undefined) {
      const pending = this.pending.get(id);
      this.logger.warn('oversized response dropped', { id, method: pending?.method, length, limit });
      this.writeFailureTombstones.delete(id);
      if (!pending) return;
      this.pending.delete(id);
      if (pending.timeoutId) clearTimeout(pending.timeoutId);
      pending.reject(new AppServerMessageTooLargeError(pending.method, length, limit));
      return;
    }
    if (method !== undefined && this.dropOversizedNotification({ method, ...scope, length })) {
      // 只记路由字段; turn 里的 error 文案等内容不进日志。
      const { threadId, turnId, itemId, itemType } = scope;
      this.logger.warn('oversized notification dropped', { method, threadId, turnId, itemId, itemType, length, limit });
      return;
    }
    const err = new Error(`codex app-server NDJSON line exceeds maxLineBytes (${length} > ${limit})`);
    this.logger.error(err.message, { method, length });
    this.handleTransportFailure(err);
  }

  private dropOversizedNotification(notification: OversizedNotification): boolean {
    if (!this.notificationHandlers.has(notification.method)) return true;
    if (!this.onOversizedNotification) return false;
    try {
      return this.onOversizedNotification(notification) === true;
    } catch (e) {
      this.logger.error('onOversizedNotification handler threw', {
        method: notification.method,
        message: (e as Error).message,
      });
      return false;
    }
  }

  private handleStderrLine(line: string): void {
    // The timing trace carries thread and response ids: read it for the speed, never log it.
    if (isCodexResponseTimingLine(line)) {
      const timing = parseCodexResponseTiming(line);
      if (timing && this.onResponseTiming) {
        try {
          this.onResponseTiming(timing);
        } catch (e) {
          this.logger.error('onResponseTiming handler threw', { message: (e as Error).message });
        }
      }
      return;
    }
    const logLine = normalizeStderrLine(line);
    const level = classifyStderrLine(line, { closing: this.closed });
    this.logger[level]('stderr', { line: logLine });
  }

  /**
   * Transport close 回调: 区分 "我们主动 close" vs "transport 自己断了"。
   * - 主动: this.closed === true (close() 已先 set), 直接 no-op
   * - 自然: 必须走 handleTransportFailure 触发 onTransportError, 让 host 清空
   *   subscribers + 重置 client/startPromise, 否则下个 session 调 ensureStarted
   *   会拿到缓存的 startPromise → request 撞 "after close()" 全军覆没
   */
  private handleTransportClose(info: TransportCloseInfo): void {
    const wasExternalClose = this.closed;
    this.logger.info('transport closed', { reason: info.reason, wasExternalClose });
    if (wasExternalClose) return;
    const failure = new Error(`codex app-server transport closed: ${info.reason}`);
    if (this.recovery) {
      this.recovery.controller.abort();
      this.handleTransportFailure(failure);
      return;
    }
    const transport = this.transport;
    const init = this.initializeParams;
    if (!info.reconnectable || !transport?.reconnect || !init ||
        this.writeFailureTombstones.size || this.serverRequestsInFlight ||
        !this.activeTurns.size) {
      this.handleTransportFailure(failure);
      return;
    }
    const roots = new Set(this.getSubscribedThreadIds?.() ?? []);
    const ownedThreads = new Set(roots);
    let ownsActiveTurn = false;
    for (const threadId of this.activeTurns.keys()) {
      const rootId = this.getRecoveryRootThreadId?.(threadId);
      if (roots.has(threadId) || (rootId && roots.has(rootId))) {
        ownedThreads.add(threadId);
        ownsActiveTurn = true;
      }
    }
    if (!ownsActiveTurn || ownedThreads.size > MAX_RECOVERY_THREADS) {
      this.handleTransportFailure(failure);
      return;
    }
    // Only a uniquely matched start notification can account for a missing
    // response. Every other pending operation still prevents recovery.
    const acknowledgedStarts: TransportRecovery['acknowledgedStarts'] = [];
    for (const [id, request] of this.pending) {
      const start = request.start;
      if (!start?.turnId || !ownedThreads.has(start.threadId)
          || this.activeTurns.get(start.threadId)?.id !== start.turnId) {
        this.handleTransportFailure(failure);
        return;
      }
      acknowledgedStarts.push({ id, request, threadId: start.threadId, turnId: start.turnId });
    }
    for (const { id, request } of acknowledgedStarts) {
      this.pending.delete(id);
      if (request.timeoutId) clearTimeout(request.timeoutId);
    }
    const recovery: TransportRecovery = {
      ready: Promise.withResolvers<Error | undefined>(), acknowledgedStarts,
      controller: new AbortController(), messages: [], size: 0, ownedThreads, reconnected: false, interrupts: new Map(),
    };
    this.recovery = recovery;
    void this.recoverTransport(transport, init, recovery).catch(() => {
      if (this.closed) return;
      this.handleTransportFailure(recovery.reconnected
        ? failure
        : new Error('Codex SSH did not reconnect; the remote turn status could not be confirmed'));
    });
  }

  /** Suppress duplicates only for item snapshots emitted during SSH recovery. */
  private observeTurn(method: string, raw: unknown): boolean {
    if (!raw || typeof raw !== 'object') return false;
    const { threadId, turnId, turn, item, itemId } = raw as {
      threadId?: string; turnId?: string; turn?: { id: string }; item?: { id: string }; itemId?: string;
    };
    if (!threadId) return false;
    const active = this.activeTurns.get(threadId);
    if (method === 'turn/completed' && turn?.id && turn.id === this.restoredTerminals.get(threadId)) return true;
    if (method === 'turn/started' && turn?.id && active?.id !== turn.id) {
      if (!active && turn.id !== this.restoredTerminals.get(threadId)) {
        let matchingStart: PendingRequest['start'];
        for (const { start } of this.pending.values()) {
          if (start?.threadId !== threadId) continue;
          if (matchingStart) {
            matchingStart = undefined;
            break;
          }
          matchingStart = start;
        }
        if (matchingStart && !matchingStart.turnId) matchingStart.turnId = turn.id;
      }
      this.recordActiveTurn(threadId, turn.id);
    } else if (method === 'turn/completed' && active && active.id === turn?.id) {
      this.activeTurns.delete(threadId);
    } else if (active && active.id === turnId && method.startsWith('item/')) {
      const id = item?.id ?? itemId;
      if (id && active.restoredItems.has(id)) return true;
      if (method === 'item/completed' && id) active.completedItems.add(id);
    }
    return false;
  }

  private recordActiveTurn(threadId: string, turnId: string): void {
    if (this.activeTurns.get(threadId)?.id === turnId || this.restoredTerminals.get(threadId) === turnId) return;
    this.restoredTerminals.delete(threadId);
    this.activeTurns.set(threadId, { id: turnId, completedItems: new Set(), restoredItems: new Set() });
  }

  private async recoverTransport(
    previous: Transport,
    init: InitializeParams,
    recovery: TransportRecovery,
  ): Promise<void> {
    const reconnectSignal = AbortSignal.any([
      recovery.controller.signal, AbortSignal.timeout(SSH_RECONNECT_WAIT_TIMEOUT_MS),
    ]);
    const replacement = await previous.reconnect!(reconnectSignal);
    if (reconnectSignal.aborted || this.closed) {
      await replacement.close('Codex SSH recovery was cancelled');
      reconnectSignal.throwIfAborted();
      return;
    }
    recovery.reconnected = true;
    const deadline = Date.now() + SSH_TURN_RESTORE_TIMEOUT_MS;
    const signal = AbortSignal.any([
      recovery.controller.signal, AbortSignal.timeout(SSH_TURN_RESTORE_TIMEOUT_MS),
    ]);
    const request = <R>(method: string, params: unknown): Promise<R> => {
      signal.throwIfAborted();
      return this.sendRequest<R>(method, params, { timeoutMs: Math.max(1, deadline - Date.now()) });
    };
    this.attachTransport(replacement);
    await request(Method.Initialize, init);
    const snapshots: Array<{ threadId: string; turn: RecoveredTurn; observed: ObservedTurn }> = [];
    let outstandingInteraction = false;
    for (const threadId of recovery.ownedThreads) {
      const { thread } = await request<{
        thread: { id: string; status: { type: string; activeFlags?: string[] } };
      }>(Method.ThreadResume, { threadId, excludeTurns: true });
      if (thread.id !== threadId || !['active', 'idle'].includes(thread.status.type)) {
        throw new Error('SSH recovery could not prove thread identity');
      }
      outstandingInteraction ||= Boolean(thread.status.activeFlags?.length);
      if (outstandingInteraction && recovery.interrupts.size === 0) {
        throw new Error('SSH recovery found an outstanding interaction');
      }
      const observed = this.activeTurns.get(threadId);
      if (!observed) continue;
      const { data } = await request<{ data: RecoveredTurn[] }>(Method.ThreadTurnsList, {
        threadId, limit: 1, sortDirection: 'desc', itemsView: 'full',
      });
      const [turn] = data;
      if (!turn || turn.id !== observed.id ||
          !['inProgress', 'completed', 'interrupted', 'failed'].includes(turn.status) ||
          !Array.isArray(turn.items) ||
          turn.items.some((item) => typeof item?.id !== 'string' || typeof item.type !== 'string')) {
        throw new Error('SSH recovery could not find the original Codex turn');
      }
      snapshots.push({ threadId, turn, observed });
    }
    // Map iteration includes intents received while another interrupt is in
    // flight; the same thread/turn shares one acknowledgement.
    for (const { params, result } of recovery.interrupts.values()) {
      const snapshot = snapshots.find(({ threadId }) => threadId === params.threadId);
      if (snapshot?.turn.id !== params.turnId) {
        throw new Error('SSH recovery could not confirm the turn to stop');
      }
      const alreadyCompleted = () => recovery.messages.some(({ message }) => {
        if (message.method !== 'turn/completed') return false;
        const event = message.params as { threadId?: string; turn?: { id: string } } | undefined;
        return event?.threadId === params.threadId && event.turn?.id === params.turnId;
      });
      if (snapshot.turn.status !== 'inProgress' || alreadyCompleted()) {
        result.resolve({});
        continue;
      }
      try {
        result.resolve(await request(Method.TurnInterrupt, params));
      } catch (error) {
        // The daemon can finish between the snapshot and the interrupt. Only
        // settle without an acknowledgement when its terminal event proves it.
        if (!alreadyCompleted()) throw error;
        result.resolve({});
      }
    }
    signal.throwIfAborted();
    if (outstandingInteraction || recovery.messages.some(({ message }) => {
      if ('id' in message) return true;
      if (message.method !== 'thread/status/changed') return false;
      const params = message.params as { status?: { activeFlags?: string[] } } | undefined;
      return Boolean(params?.status?.activeFlags?.length);
    })) {
      throw new Error('SSH recovery received an interactive server request');
    }
    const liveItems = new Set<string>();
    const liveTurns = new Set<string>();
    for (const { message } of recovery.messages) {
      const params = message.params as { threadId?: string; turnId?: string; turn?: { id: string }; item?: { id: string } } | undefined;
      if (message.method === 'item/completed' && params?.item) {
        liveItems.add(JSON.stringify([params.threadId, params.turnId, params.item.id]));
      } else if (message.method === 'turn/completed' && params?.turn) {
        liveTurns.add(JSON.stringify([params.threadId, params.turn.id]));
      }
    }
    const restoredStarts = recovery.acknowledgedStarts.map(({ request, threadId, turnId }) => {
      const snapshot = snapshots.find(({ threadId: id, turn }) => id === threadId && turn.id === turnId);
      if (!snapshot) throw new Error('SSH recovery could not confirm the acknowledged turn start');
      return { request, turn: snapshot.turn };
    });
    // Synchronous notification handlers can start work too. Keep the startup
    // gate closed while delivering the recovered items and terminal events.
    recovery.replaying = true;
    for (const { threadId, turn, observed } of snapshots) {
      for (const item of turn.items) {
        if (item.type === 'userMessage' || item.status === 'inProgress' ||
            observed.completedItems.has(item.id) ||
            liveItems.has(JSON.stringify([threadId, turn.id, item.id]))) continue;
        // The full turn view returns persisted items, not uncommitted deltas.
        this.handleLine(JSON.stringify({ method: 'item/completed', params: { threadId, turnId: turn.id, item } }), true);
        observed.restoredItems.add(item.id);
      }
    }
    for (const { line } of recovery.messages) this.handleLine(line, true);
    for (const { threadId, turn } of snapshots) {
      if (turn.status !== 'inProgress' && !liveTurns.has(JSON.stringify([threadId, turn.id]))) {
        this.handleLine(JSON.stringify({ method: 'turn/completed', params: { threadId, turn } }), true);
        if (this.restoredTerminals.size >= MAX_RECOVERY_THREADS) {
          const oldest = this.restoredTerminals.keys().next().value;
          if (oldest !== undefined) this.restoredTerminals.delete(oldest);
        }
        this.restoredTerminals.set(threadId, turn.id);
      }
    }
    signal.throwIfAborted();
    this.recovery = undefined;
    for (const { request, turn } of restoredStarts) request.resolve({ turn });
    recovery.ready.resolve(undefined);
    this.logger.info('Codex SSH transport recovered', { threadCount: snapshots.length });
  }

  private dispatchResponse(id: JsonRpcId, result: unknown, error: JsonRpcErrorObject | null): void {
    const pending = this.pending.get(id);
    if (!pending) {
      const failedWrite = this.writeFailureTombstones.get(id);
      if (failedWrite !== undefined) {
        this.writeFailureTombstones.delete(id);
        this.logger.warn('late response for request with failed write', {
          id,
          method: failedWrite.method,
          hasError: error !== null,
        });
        if (error) {
          this.notifyAuthInvalidated(
            error,
            failedWrite.method,
            failedWrite.credentialGeneration,
          );
        }
        return;
      }
      this.logger.warn('response for unknown id', { id });
      return;
    }
    this.pending.delete(id);
    if (pending.timeoutId) clearTimeout(pending.timeoutId);
    if (error) {
      this.notifyAuthInvalidated(error, pending.method, pending.credentialGeneration);
      pending.reject(new AppServerResponseError(pending.method, error));
      return;
    }
    if (pending.start && !pending.start.turnId && !this.activeTurns.has(pending.start.threadId)) {
      const turnId = (result as { turn?: { id?: unknown } } | undefined)?.turn?.id;
      if (typeof turnId === 'string' && turnId) this.recordActiveTurn(pending.start.threadId, turnId);
    }
    pending.resolve(result);
  }

  /** Keep write-failure correlation bounded; oldest ids are least useful. */
  private rememberWriteFailure(
    id: JsonRpcId,
    method: string,
    credentialGeneration?: string | null,
  ): void {
    this.writeFailureTombstones.set(id, { method, credentialGeneration });
    while (this.writeFailureTombstones.size > MAX_WRITE_FAILURE_TOMBSTONES) {
      const oldestId = this.writeFailureTombstones.keys().next().value as JsonRpcId | undefined;
      if (oldestId === undefined) break;
      this.writeFailureTombstones.delete(oldestId);
    }
  }

  /** Notify the host once, but only after the caller has correlated the response. */
  private notifyAuthInvalidated(
    error: JsonRpcErrorObject,
    method?: string,
    credentialGeneration?: string | null,
  ): void {
    const authInvalidationReason = detectAuthInvalidationReason(error, method);
    if (this.authInvalidatedFired || !this.onAuthInvalidated || !authInvalidationReason) return;
    this.authInvalidatedFired = true;
    try {
      if (credentialGeneration === undefined) {
        this.onAuthInvalidated(authInvalidationReason);
      } else {
        this.onAuthInvalidated(authInvalidationReason, { credentialGeneration });
      }
    } catch (e) {
      this.logger.warn('onAuthInvalidated handler threw', { message: (e as Error).message });
    }
  }

  private async dispatchNotification(method: string, params: unknown): Promise<void> {
    const handler = this.notificationHandlers.get(method);
    if (!handler) {
      // 没注册 handler 不算错 — 可能是我们没订阅的 delta。debug 级别即可。
      this.logger.debug('unhandled notification', { method });
      return;
    }
    try {
      await handler(params);
    } catch (e) {
      this.logger.error('notification handler threw', {
        method,
        message: (e as Error).message,
      });
    }
  }

  private async dispatchServerRequest(msg: { id: JsonRpcId; method: string; params?: unknown }): Promise<void> {
    const handler = this.requestHandlers.get(msg.method);
    if (!handler) {
      // server 期待 response — 必须回, 否则 server side 卡住。
      await this.sendErrorResponse(msg.id, {
        code: JSONRPC_ERROR_CODE.METHOD_NOT_FOUND,
        message: `no handler registered for ${msg.method}`,
      });
      return;
    }
    try {
      const result = await handler(msg.params, { id: msg.id, method: msg.method });
      await this.sendSuccessResponse(msg.id, result);
    } catch (e) {
      const err = e as Error & { code?: number; data?: unknown };
      await this.sendErrorResponse(msg.id, {
        code: typeof err.code === 'number' ? err.code : JSONRPC_ERROR_CODE.INTERNAL_ERROR,
        message: err.message,
        data: err.data,
      });
    }
  }

  private async sendSuccessResponse(id: JsonRpcId, result: unknown): Promise<void> {
    if (this.closed || !this.transport) return;
    const payload = JSON.stringify({ id, result: result ?? {} });
    await this.transport.writeLine(payload).catch((err: Error) => {
      this.logger.warn('write success response failed', { id, message: err.message });
    });
  }

  private async sendErrorResponse(id: JsonRpcId, error: JsonRpcErrorObject): Promise<void> {
    if (this.closed || !this.transport) return;
    const payload = JSON.stringify({ id, error });
    await this.transport.writeLine(payload).catch((err: Error) => {
      this.logger.warn('write error response failed', { id, message: err.message });
    });
  }

  private handleTransportFailure(err: Error): void {
    if (this.onTransportError) {
      try {
        this.onTransportError(err);
      } catch (e) {
        this.logger.error('onTransportError handler threw', { message: (e as Error).message });
      }
    }
    void this.close({ reason: `transport failure: ${err.message}` });
  }
}
