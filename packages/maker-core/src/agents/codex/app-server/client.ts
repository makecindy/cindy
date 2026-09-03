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
 *  - JSON.parse 单行有 maxMessageSize 守卫, 超限 close session
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
} from './protocol.js';
import type { Transport } from './transport.js';

/**
 * 单条 NDJSON line 的最大字节数 (UTF-16 字符近似)。
 * Codex 单 notification 正常 < 1MB; 设 16MB 给极端 reasoning text 留余量,
 * 超限直接 close session — 避免主线程在 JSON.parse 上卡几百 ms。
 */
const DEFAULT_MAX_LINE_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_LOG_CHARS = 2_000;

export class AppServerRequestTimeoutError extends Error {
  constructor(
    public readonly method: string,
    public readonly timeoutMs: number,
  ) {
    super(`codex app-server ${method} timed out after ${timeoutMs}ms`);
    this.name = 'AppServerRequestTimeoutError';
  }
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

function classifyStderrLine(line: string): 'debug' | 'warn' | 'error' {
  const plain = line.replace(ANSI_ESCAPE_RE, '').trim();
  if (!plain) return 'debug';
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
  /** 单行 NDJSON 上限, 缺省 16MB。超限触发 onProtocolError 并 close。 */
  maxLineBytes?: number;
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

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  method: string;
  credentialGeneration?: string | null;
  timeoutId: ReturnType<typeof setTimeout> | null;
}

/**
 * 单 session 单实例 (plan D5)。oneShot 也单独 spawn 一个。
 */
export class AppServerClient {
  private readonly logger: Logger;
  private readonly maxLineBytes: number;
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
  /** close() 调用后置 true, 阻止后续 request / 重复 close 的副作用。 */
  private closed = false;

  constructor(opts: AppServerClientOptions) {
    if (typeof opts.createTransport !== 'function') {
      throw new Error('AppServerClient: createTransport factory is required');
    }
    this.createTransport = opts.createTransport;
    this.logger = opts.logger.child('codex-app-server');
    this.maxLineBytes = opts.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
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
    this.transport = transport;
    transport.onLine((line) => this.handleLine(line));
    transport.onStderr?.((line) => this.handleStderrLine(line));
    transport.onClose((info) => this.handleTransportClose(info.reason));
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
    this.logger.info('initialized', {
      userAgent: response.userAgent,
      codexHome: response.codexHome,
      platformOs: response.platformOs,
    });
    return response;
  }

  /**
   * close() 是幂等的; reason 仅用于 reject pending requests 的错误消息。
   * - reject 所有挂起 promise
   * - 关闭 transport (杀子进程 / 关 ssh channel)
   */
  async close(opts?: { reason?: string; throwOnTransportError?: boolean }): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const reason = opts?.reason ?? 'AppServerClient.close()';

    // reject 所有挂起 request — 上层 await 不会无限等。
    const err = new Error(`codex app-server closed: ${reason}`);
    for (const [, pending] of this.pending) {
      if (pending.timeoutId) clearTimeout(pending.timeoutId);
      pending.reject(err);
    }
    this.pending.clear();
    this.writeFailureTombstones.clear();

    if (this.transport) {
      try {
        await this.transport.close(reason);
      } catch (e) {
        this.logger.warn('transport.close threw', { message: (e as Error).message });
        if (opts?.throwOnTransportError) throw e;
      }
    }
  }

  // ── 请求 / 通知 / handler 注册 ────────────────────────────────────────────

  /**
   * 发送一个 JSON-RPC request, 等待对应 id 的 response。
   * server 返回 error 时 reject 一个携带 code+message 的 Error。
   */
  request<R = unknown>(
    method: string,
    params?: unknown,
    opts?: { timeoutMs?: number },
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
    return new Promise<R>((resolve, reject) => {
      const pending: PendingRequest = {
        resolve: resolve as (v: unknown) => void,
        reject,
        method,
        credentialGeneration,
        timeoutId: null,
      };
      this.pending.set(id, pending);
      if (timeoutMs !== undefined) {
        pending.timeoutId = setTimeout(() => {
          if (this.pending.get(id) !== pending) return;
          this.pending.delete(id);
          reject(new AppServerRequestTimeoutError(method, timeoutMs));
        }, timeoutMs);
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

  private handleLine(line: string): void {
    if (!line) return;
    if (line.length > this.maxLineBytes) {
      const err = new Error(
        `codex app-server NDJSON line exceeds maxLineBytes (${line.length} > ${this.maxLineBytes})`,
      );
      this.logger.error(err.message);
      this.handleTransportFailure(err);
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
    if ('id' in msg && 'method' in msg) {
      void this.dispatchServerRequest(msg);
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
      void this.dispatchNotification(msg.method, (msg as { params?: unknown }).params);
      return;
    }
    this.logger.warn('unrecognized incoming message', { preview: line.slice(0, 200) });
  }

  private handleStderrLine(line: string): void {
    const logLine = normalizeStderrLine(line);
    const level = classifyStderrLine(line);
    this.logger[level]('stderr', { line: logLine });
  }

  /**
   * Transport close 回调: 区分 "我们主动 close" vs "transport 自己断了"。
   * - 主动: this.closed === true (close() 已先 set), 直接 no-op
   * - 自然: 必须走 handleTransportFailure 触发 onTransportError, 让 host 清空
   *   subscribers + 重置 client/startPromise, 否则下个 session 调 ensureStarted
   *   会拿到缓存的 startPromise → request 撞 "after close()" 全军覆没
   */
  private handleTransportClose(reason: string): void {
    const wasExternalClose = this.closed;
    this.logger.info('transport closed', { reason, wasExternalClose });
    if (wasExternalClose) return;
    this.handleTransportFailure(new Error(`codex app-server transport closed: ${reason}`));
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
      const err = new Error(`codex app-server ${pending.method} error ${error.code}: ${error.message}`);
      // 把 code/data 挂上, 上层想区分 OVERLOADED 等可以判 (err as any).code。
      Object.assign(err, { code: error.code, data: error.data });
      pending.reject(err);
      return;
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
      this.sendErrorResponse(msg.id, {
        code: JSONRPC_ERROR_CODE.METHOD_NOT_FOUND,
        message: `no handler registered for ${msg.method}`,
      });
      return;
    }
    try {
      const result = await handler(msg.params, { id: msg.id, method: msg.method });
      this.sendSuccessResponse(msg.id, result);
    } catch (e) {
      const err = e as Error & { code?: number; data?: unknown };
      this.sendErrorResponse(msg.id, {
        code: typeof err.code === 'number' ? err.code : JSONRPC_ERROR_CODE.INTERNAL_ERROR,
        message: err.message,
        data: err.data,
      });
    }
  }

  private sendSuccessResponse(id: JsonRpcId, result: unknown): void {
    if (this.closed || !this.transport) return;
    const payload = JSON.stringify({ id, result: result ?? {} });
    this.transport.writeLine(payload).catch((err: Error) => {
      this.logger.warn('write success response failed', { id, message: err.message });
    });
  }

  private sendErrorResponse(id: JsonRpcId, error: JsonRpcErrorObject): void {
    if (this.closed || !this.transport) return;
    const payload = JSON.stringify({ id, error });
    this.transport.writeLine(payload).catch((err: Error) => {
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
