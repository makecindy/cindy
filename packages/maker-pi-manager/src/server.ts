/**
 * pi-manager server — unix socket NDJSON RPC listener.
 *
 * Lifecycle:
 *   const server = new ManagerServer({ socketPath: '...' });
 *   await server.start();
 *   ...
 *   await server.stop();
 *
 * Single-process daemon; multiple clients can connect to the same socket
 * (e.g. one for pi/ensure, another for session/list). Each connection is
 * independent. The pi session bridge itself is NOT an RPC method — clients
 * run `pi-manager bridge --socket <sockPath>` as a separate process that
 * pipes stdio to the session socket.
 *
 * Structure mirrors packages/maker-cc-manager/src/server.ts deliberately —
 * the socket dispatch skeleton is copied (not shared) to keep cc-mgr
 * byte-identical and untouched. SDK-specific logic is absent here.
 */

import * as net from 'node:net';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { NDJSONDecoder, encodeMessage } from './codec.js';
import {
  METHODS,
  PROTOCOL_VERSION,
  isRpcNotification,
  isRpcRequest,
  isRpcResponse,
  makeRpcError,
  type HelloParams,
  type HelloResult,
  type RpcError,
  type RpcErrorCode,
  type RpcId,
  type RpcMessage,
  type RpcNotification,
  type RpcRequest,
  type RpcResponse,
} from './protocol.js';

export interface ManagerServerOptions {
  /** Absolute path to the unix socket. Parent dir is created if missing. */
  socketPath: string;
  /** Manager build / git SHA, returned in hello result. */
  managerVersion?: string;
  /** Optional logger. Defaults to console. */
  logger?: ManagerLogger;
}

export interface ManagerLogger {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
}

const defaultLogger: ManagerLogger = {
  debug: () => undefined,
  info: (msg, ctx) => console.error('[pi-mgr][info]', msg, ctx ?? ''),
  warn: (msg, ctx) => console.error('[pi-mgr][warn]', msg, ctx ?? ''),
  error: (msg, ctx) => console.error('[pi-mgr][error]', msg, ctx ?? ''),
};

export interface ClientCtx {
  socket: net.Socket;
  decoder: NDJSONDecoder;
  /** Set true after a successful PROTOCOL_HELLO. */
  initialized: boolean;
  /** Optional client identifier from hello — for log correlation. */
  clientId?: string;
  /** 该连接当前 in-flight 的 handler 数(轮 40-w4 MEDIUM-2:per-client 限流)。 */
  inflight: number;
}

/**
 * Handler signature. Must return either a result payload (any JSON-serializable
 * value) or throw with .code matching RpcErrorCode for typed error responses.
 */
export type MethodHandler = (params: unknown, ctx: ClientCtx) => Promise<unknown> | unknown;

interface PendingServerRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer?: NodeJS.Timeout;
  ctx: ClientCtx;
}

/**
 * 凭证强脱敏(corrupt line 日志样本用, 轮 40-w4-t4 CRITICAL):按常见凭证格式
 * 掩码。与 session-registry 的 scrubCredentialText 同策略, 这里内联避免
 * server↔session-registry 循环 import。漏掩代价 > 误掩(样本仅诊断用)。
 */
const CREDENTIAL_SCRUB_RE =
  /(?<![A-Za-z0-9])(sk-(?:ant|or|proj|admin|svcacct)-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[A-Za-z0-9_-]{20,}|hf_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|LTAI[A-Za-z0-9]{16,}|A(?:KIA|SIA)[A-Z0-9]{16}|Bearer\s+[A-Za-z0-9._~+/=-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|-----BEGIN OPENSSH PRIVATE KEY-----|[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})/g;

// 轮 40-w4-t5 CRITICAL:key-aware 敏感字段名 —— 值形状正则覆盖不了 64-hex
// sessionToken / 自定义 MCP header, 字段名命中即整体替换。
const SENSITIVE_KEY_RE =
  /(^|[\s,{[])("?)([A-Za-z0-9_-]*)(token|secret|api[_-]?key|authorization|password|credential|CINDY_PI_MCP_BRIDGE|CINDY_PI_REMOTE_MCP_SECRET)([A-Za-z0-9_-]*)(\s*["]?\s*[:=]\s*)([^,\s}\]]+)/gi;

function redactSensitiveText(text: string): string {
  let out = text.replace(CREDENTIAL_SCRUB_RE, '[REDACTED]');
  out = out.replace(SENSITIVE_KEY_RE, (_m, pre: string, quote: string, _k1: string, _k2: string, _k3: string, sep: string) =>
    `${pre}${quote}[REDACTED]${sep}[REDACTED]`);
  return out;
}

function isWindowsNamedPipe(socketPath: string): boolean {
  // 匹配 \\?\pipe\ 与 \\.\pipe\(轮 11 修复:原正则只匹配 \\?\pipe\ 而实际
  // named pipe 前缀是 \\.\pipe\ —— 误判导致对 pipe 执行 chmod/rm, 破坏连接)。
  return /^\\\\[.?]\\pipe\\/.test(socketPath);
}

/** 最大并发客户端连接数(DoS 防护 —— 退役审轮 3 M-2)。 */
const MAX_CLIENTS = 16;
/** 单客户端 in-flight 请求上限(轮 40-w4 MEDIUM-2)。正常使用单请求串行,
 *  上限 32 覆盖并发 ensure/kill/list 的合理场景;超限 = 请求洪泛, 拒绝。
 *  handler 最长 30s(ensure), 32 个并发 handler 的堆叠是接受的天花板。 */
const MAX_INFLIGHT_PER_CLIENT = 32;

const VALID_ERROR_CODES: ReadonlySet<string> = new Set<RpcErrorCode>([
  'INVALID_PROTOCOL_VERSION',
  'UNKNOWN_METHOD',
  'INVALID_PARAMS',
  'NOT_INITIALIZED',
  'SESSION_NOT_FOUND',
  'SESSION_ALREADY_EXISTS',
  'SESSION_KILL_SURVIVED',
  'SESSION_LIMIT_EXCEEDED',
  'SERVER_BUSY',
  'INTERNAL',
]);

function isValidErrorCode(code: string): code is RpcErrorCode {
  return VALID_ERROR_CODES.has(code);
}

export function makeServerError(code: RpcErrorCode, message: string, data?: unknown): Error & {
  code: RpcErrorCode;
  data?: unknown;
} {
  const err = new Error(message) as Error & { code: RpcErrorCode; data?: unknown };
  err.code = code;
  if (data !== undefined) err.data = data;
  return err;
}

export class ManagerServer {
  private readonly server: net.Server;
  private readonly logger: ManagerLogger;
  private readonly socketPath: string;
  private readonly managerVersion?: string;
  private readonly handlers = new Map<string, MethodHandler>();
  private readonly clients = new Set<ClientCtx>();
  private readonly pendingServerRequests = new Map<RpcId, PendingServerRequest>();
  private readonly clientCloseListeners: Array<(ctx: ClientCtx) => void> = [];
  private nextServerRequestId: RpcId = -1;
  private started = false;

  constructor(opts: ManagerServerOptions) {
    this.socketPath = opts.socketPath;
    this.managerVersion = opts.managerVersion;
    this.logger = opts.logger ?? defaultLogger;
    this.server = net.createServer((socket) => this.onConnection(socket));
    this.registerBuiltinHandlers();
  }

  /** Register or override a method handler. Used by runDaemon to plug in pi session control. */
  setHandler(method: string, handler: MethodHandler): void {
    this.handlers.set(method, handler);
  }

  /**
   * Send a request FROM server TO client and await the client's response.
   * Uses negative IDs to avoid collision with client→server request IDs.
   * Rejects on timeout or if the client disconnects before responding.
   */
  async sendRequest<R = unknown>(
    ctx: ClientCtx,
    method: string,
    params: unknown,
    opts: { timeoutMs?: number } = {},
  ): Promise<R> {
    const id = this.nextServerRequestId--;
    return await new Promise<R>((resolve, reject) => {
      const entry: PendingServerRequest = {
        resolve: resolve as (v: unknown) => void,
        reject,
        ctx,
      };
      const timeoutMs = opts.timeoutMs ?? 120_000;
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          if (this.pendingServerRequests.delete(id)) {
            reject(new Error(`server request ${method} timed out after ${timeoutMs}ms`));
          }
        }, timeoutMs);
      }
      this.pendingServerRequests.set(id, entry);
      const request: RpcRequest = { type: 'request', id, method, params };
      if (ctx.socket.destroyed) {
        this.pendingServerRequests.delete(id);
        if (entry.timer) clearTimeout(entry.timer);
        reject(new Error('client socket destroyed before request could be sent'));
        return;
      }
      // 编码失败(params 含循环引用等)时清理 pending entry, 不留到 timer(轮 2 L-4)。
      try {
        ctx.socket.write(encodeMessage(request));
      } catch (err) {
        this.pendingServerRequests.delete(id);
        if (entry.timer) clearTimeout(entry.timer);
        reject(new Error(`request ${method} serialization failed: ${(err as Error).message}`));
      }
    });
  }

  /** Register a listener invoked when any client disconnects. */
  onClientClose(listener: (ctx: ClientCtx) => void): void {
    this.clientCloseListeners.push(listener);
  }

  /**
   * Broadcast a notification to every connected client (used for
   * session/closed fan-out).
   */
  notifyAll(notification: RpcNotification): void {
    // 单个客户端编码失败(理论上 payload 可被 registry 传回循环引用)不拖累
    // 其余广播 —— 轮 2 L-4 防御。
    let frame: string;
    try {
      frame = encodeMessage(notification);
    } catch (err) {
      this.logger.error('notifyAll encode failed', { error: (err as Error).message });
      return;
    }
    for (const ctx of this.clients) {
      if (!ctx.socket.destroyed) {
        ctx.socket.write(frame);
      }
    }
  }

  async start(): Promise<void> {
    if (this.started) return;
    // 显式 0700(默认 umask 022 给 0755, 同机其他用户可列 socket 文件名 —
    // 深挖轮 5 L-4)。
    // 轮 18 MEDIUM:named pipe 无需父目录(内核 NT 命名空间直接管理), 且
    // path.dirname('\\\\.\\pipe\\x') = '\\.\pipe\' 在 Windows 被解释为
    // 真实文件系统路径, mkdir 会泄漏 <盘>:\pipe\ 目录 —— 与 chmod/rm 同款守卫。
    if (!isWindowsNamedPipe(this.socketPath)) {
      await fs.mkdir(path.dirname(this.socketPath), { recursive: true, mode: 0o700 });
    }
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        this.server.removeListener('listening', onListening);
        reject(err);
      };
      const onListening = (): void => {
        this.server.removeListener('error', onError);
        resolve();
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(this.socketPath);
    });
    // 轮 11 MEDIUM-4:socket 文件 mode 显式 0600 —— 独立于目录 0700 的第二层
    // 防线(目录守卫被削弱时 socket 不暴露)。非 Windows(named pipe 无文件)。
    if (!isWindowsNamedPipe(this.socketPath)) {
      try {
        await fs.chmod(this.socketPath, 0o600);
      } catch {
        /* best-effort —— 目录 0700 已兜底 */
      }
    }
    this.started = true;
    this.logger.info('pi-manager listening', { socketPath: this.socketPath });
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    for (const ctx of this.clients) {
      try {
        ctx.socket.destroy();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    if (!isWindowsNamedPipe(this.socketPath)) {
      await fs.rm(this.socketPath, { force: true });
    }
    this.started = false;
    this.logger.info('pi-manager stopped');
  }

  private registerBuiltinHandlers(): void {
    this.handlers.set(METHODS.PROTOCOL_HELLO, async (params, ctx) => {
      // 重复 hello 拒绝:协议要求每条连接握手一次, 重复会覆盖 clientId
      // 造成日志身份混淆(轮 2 M-1)。
      if (ctx.initialized) {
        throw makeServerError('INVALID_PARAMS', 'protocol/hello already completed on this connection');
      }
      const p = (params ?? {}) as Partial<HelloParams>;
      if (typeof p.protocolVersion !== 'number') {
        throw makeServerError('INVALID_PARAMS', 'protocolVersion is required (number)');
      }
      if (p.protocolVersion !== PROTOCOL_VERSION) {
        throw makeServerError(
          'INVALID_PROTOCOL_VERSION',
          `client version ${p.protocolVersion} != server version ${PROTOCOL_VERSION}`,
        );
      }
      ctx.initialized = true;
      ctx.clientId = p.clientId;
      const result: HelloResult = {
        protocolVersion: PROTOCOL_VERSION,
        ...(this.managerVersion ? { managerVersion: this.managerVersion } : {}),
      };
      return result;
    });
  }

  private onConnection(socket: net.Socket): void {
    // 连接数上限:每个连接分配 NDJSONDecoder(最大 64MB buffer), 无上限会被
    // 连接洪泛耗尽 daemon 内存 —— 单 daemon 服务所有会话, DoS 面更集中
    // (退役审轮 3 M-2)。超限直接 destroy。
    if (this.clients.size >= MAX_CLIENTS) {
      this.logger.warn('connection limit reached — rejecting', { maxClients: MAX_CLIENTS });
      socket.destroy();
      return;
    }
    const ctx: ClientCtx = {
      socket,
      decoder: new NDJSONDecoder({
        // 轮 40-w4-t4 CRITICAL:corrupt NDJSON 行**不得**记录原文 —— 请求
        // (如 pi/ensure)的 params 含真实凭证(env: CINDY_PI_API_KEY 等),
        // 畸形/截断行会把 secret 写进 daemon log 并经 tail 回传桌面。
        // 只记错误类型与行长度, 不记内容;样本经强脱敏后才保留(截断前)。
        onCorruptLine: (line, err) =>
          this.logger.warn('corrupt ndjson line', {
            error: err.message,
            lineLength: line.length,
            sample: redactSensitiveText(line).slice(0, 200),
          }),
      }),
      initialized: false,
      inflight: 0,
    };
    this.clients.add(ctx);
    this.logger.debug('client connected', { totalClients: this.clients.size });

    // 应用层 idle 超时:连接建立后完全不活动(不读不写)占住 MAX_CLIENTS 槽位
    // 的挂死连接 60s 后回收(轮 2 M-4)。60s 给慢请求(pi/ensure 最长 30s +
    // SSH 链路延迟)留足余量;活动(读写)自动重置计时。
    socket.setTimeout(60_000, () => {
      this.logger.warn('client idle timeout — destroying', { totalClients: this.clients.size });
      socket.destroy();
    });

    socket.on('data', (chunk: Buffer) => {
      for (const msg of ctx.decoder.push(chunk)) {
        void this.dispatch(ctx, msg);
      }
    });
    socket.on('close', () => {
      this.clients.delete(ctx);
      this.rejectPendingForCtx(ctx);
      for (const listener of this.clientCloseListeners) {
        try { listener(ctx); } catch { /* */ }
      }
      this.logger.debug('client disconnected', { totalClients: this.clients.size });
    });
    socket.on('error', (err) => {
      // error 后 close 事件必然跟随, 但中间窗口里该连接仍占 clients 槽位
      // 且参与 notifyAll —— 直接 destroy 立即走 close 清理路径(轮 2 M-2)。
      this.logger.warn('client socket error', { error: err.message });
      socket.destroy();
    });
  }

  private async dispatch(ctx: ClientCtx, msg: RpcMessage): Promise<void> {
    if (isRpcResponse(msg)) {
      this.handleServerRequestResponse(ctx, msg);
      return;
    }
    if (isRpcNotification(msg)) {
      // Notifications from client — ignored for now.
      return;
    }
    const request = msg as RpcRequest;
    // 负数 id 是 server→client 反向请求的保留命名空间(-1, -2, ...)。
    // 客户端发负数 id 请求会与 pendingServerRequests 碰撞(错误地 resolve
    // 反向请求 promise)—— 拒绝(自审轮 1 M-3)。
    if (request.id < 0) {
      this.sendResponse(ctx, request.id, undefined, makeRpcError('INVALID_PARAMS', 'client request ids must be non-negative'));
      return;
    }
    if (!ctx.initialized && request.method !== METHODS.PROTOCOL_HELLO) {
      this.sendResponse(ctx, request.id, undefined, makeRpcError('NOT_INITIALIZED', 'send protocol/hello first'));
      return;
    }
    const handler = this.handlers.get(request.method);
    if (!handler) {
      this.sendResponse(ctx, request.id, undefined, makeRpcError('UNKNOWN_METHOD', `no handler for method ${request.method}`));
      return;
    }
    // 轮 40-w4 MEDIUM-2:per-client in-flight 限流 —— 单连接 fire-and-forget
    // dispatch 无上限时, 洪泛请求会堆积 handler promise / 定时器 / 异步工作,
    // 并并发触发 ensure/kill。超限直接拒绝该请求(其它请求照常完成)。
    if (ctx.inflight >= MAX_INFLIGHT_PER_CLIENT) {
      this.sendResponse(
        ctx,
        request.id,
        undefined,
        makeRpcError('SERVER_BUSY', `too many in-flight requests (max ${MAX_INFLIGHT_PER_CLIENT})`),
      );
      return;
    }
    ctx.inflight += 1;
    try {
      const result = await handler(request.params, ctx);
      this.sendResponse(ctx, request.id, result, undefined);
    } catch (err) {
      // 防御 throw null / throw undefined / throw non-object: e.code 访问前确保是对象。
      // throw null → e={} → code=undefined → fallback='INTERNAL', message → 'internal error'.
      const e = (
        err != null && typeof err === 'object' ? err : {}
      ) as { code?: RpcErrorCode; message?: string; data?: unknown };
      const code: RpcErrorCode = e.code && isValidErrorCode(e.code) ? e.code : 'INTERNAL';
      // data 透传是协议契约(server.test.ts 显式断言 handler 抛 makeServerError
      // 带 data → 响应带 data);只有内部 handler 通过 makeServerError 构造的
      // 白名单 code 错误才带 data, 自定义 throw 的裸 data 不会进入协议路径
      // (轮 2 L-2 初判「无消费方」有误, 已回滚)。
      this.sendResponse(ctx, request.id, undefined, makeRpcError(code, e.message ?? 'internal error', e.data));
    } finally {
      ctx.inflight -= 1;
    }
  }

  private rejectPendingForCtx(ctx: ClientCtx): void {
    for (const [id, entry] of this.pendingServerRequests) {
      if (entry.ctx === ctx) {
        this.pendingServerRequests.delete(id);
        if (entry.timer) clearTimeout(entry.timer);
        entry.reject(new Error('client disconnected before responding'));
      }
    }
  }

  private handleServerRequestResponse(ctx: ClientCtx, msg: RpcResponse): void {
    const entry = this.pendingServerRequests.get(msg.id);
    if (!entry) return;
    // 来源校验(轮 2 H-1):response 必须来自当初发送 server→client 请求的
    // 同一条连接, 防止其它连接猜负 id 注入伪造响应。
    if (entry.ctx !== ctx) return;
    this.pendingServerRequests.delete(msg.id);
    if (entry.timer) clearTimeout(entry.timer);
    if (msg.error) {
      // 防御畸形 error shape(error 非对象/缺 code/message —— 轮 2 L-1)。
      const e = msg.error as Partial<RpcError>;
      const code = typeof e.code === 'string' ? e.code : 'INTERNAL';
      const message = typeof e.message === 'string' ? e.message : 'malformed error response';
      entry.reject(new Error(`${code}: ${message}`));
    } else {
      entry.resolve(msg.result);
    }
  }

  private sendResponse(ctx: ClientCtx, id: RpcId, result: unknown, error?: RpcError): void {
    if (ctx.socket.destroyed) return;
    const response: RpcResponse = error !== undefined
      ? { type: 'response', id, error }
      : { type: 'response', id, result };
    // 编码失败(handler 返回循环引用等 —— 轮 2 L-4)不 crash, 回干净错误。
    try {
      ctx.socket.write(encodeMessage(response));
    } catch (err) {
      this.logger.error('sendResponse encode failed', {
        id,
        error: (err as Error).message,
      });
      const fallback: RpcResponse = { type: 'response', id, error: { code: 'INTERNAL', message: 'response serialization failed' } };
      try {
        ctx.socket.write(encodeMessage(fallback));
      } catch {
        /* socket 已死, 放弃 */
      }
    }
  }
}
