/**
 * Manager server skeleton — Phase 1 only does protocol handshake + UNKNOWN_METHOD
 * for everything else. Phase 2 wires SDK Query dispatch on top of this.
 *
 * Lifecycle:
 *   const server = new ManagerServer({ socketPath: '...' });
 *   await server.start();
 *   ...
 *   await server.stop();
 *
 * Single-process daemon; multiple clients can connect to the same socket
 * (e.g. one for query/start, another for session/list). Each connection
 * is independent — no shared session affinity at the connection level.
 *
 * Phase 1 limitation: dispatch table is mostly empty (only PROTOCOL_HELLO
 * is real). All other methods return UNKNOWN_METHOD error. Phase 2 fills in
 * QUERY_START / QUERY_SEND / etc.
 */

import * as net from 'node:net';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { NDJSONDecoder, encodeMessage } from './codec.js';
import {
  METHODS,
  PROTOCOL_VERSION,
  isRpcRequest,
  isRpcResponse,
  makeRpcError,
  type HelloParams,
  type HelloResult,
  type RpcErrorCode,
  type RpcId,
  type RpcMessage,
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
  info: (msg, ctx) => console.error('[cc-mgr][info]', msg, ctx ?? ''),
  warn: (msg, ctx) => console.error('[cc-mgr][warn]', msg, ctx ?? ''),
  error: (msg, ctx) => console.error('[cc-mgr][error]', msg, ctx ?? ''),
};

export interface ClientCtx {
  socket: net.Socket;
  decoder: NDJSONDecoder;
  /** Set true after a successful PROTOCOL_HELLO. */
  initialized: boolean;
  /** Optional client identifier from hello — for log correlation. */
  clientId?: string;
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

  /** Register or override a method handler. Used by Phase 2+ to plug in SDK dispatch. */
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
      if (!ctx.socket.destroyed) {
        ctx.socket.write(encodeMessage(request));
      } else {
        this.pendingServerRequests.delete(id);
        if (entry.timer) clearTimeout(entry.timer);
        reject(new Error('client socket already destroyed'));
      }
    });
  }

  async start(): Promise<void> {
    if (this.started) return;
    // Windows named pipes (\\.\pipe\xxx) are kernel objects — no parent dir to mkdir,
    // no file to rm. Only do filesystem prep for true unix sockets.
    if (!isWindowsNamedPipe(this.socketPath)) {
      await fs.mkdir(path.dirname(this.socketPath), { recursive: true });
      // Clean stale socket if any (typical Unix pattern — server's prior crash leaves the file).
      await fs.rm(this.socketPath, { force: true });
    }
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        this.server.off('listening', onListening);
        reject(err);
      };
      const onListening = (): void => {
        this.server.off('error', onError);
        resolve();
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(this.socketPath);
    });
    this.started = true;
    this.logger.info('manager started', { socketPath: this.socketPath });
  }

  /** Register a listener called when a client socket closes. */
  onClientClose(listener: (ctx: ClientCtx) => void): void {
    this.clientCloseListeners.push(listener);
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
    this.logger.info('manager stopped');
  }

  private registerBuiltinHandlers(): void {
    this.handlers.set(METHODS.PROTOCOL_HELLO, async (params, ctx) => {
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
    const ctx: ClientCtx = {
      socket,
      decoder: new NDJSONDecoder({
        onCorruptLine: (line, err) =>
          this.logger.warn('corrupt ndjson line', { error: err.message, line: line.slice(0, 200) }),
      }),
      initialized: false,
    };
    this.clients.add(ctx);
    this.logger.debug('client connected', { totalClients: this.clients.size });

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
      this.logger.warn('client socket error', { error: err.message });
    });
  }

  private async dispatch(ctx: ClientCtx, msg: RpcMessage): Promise<void> {
    if (isRpcResponse(msg)) {
      this.handleServerRequestResponse(msg);
      return;
    }
    if (!isRpcRequest(msg)) {
      // Notifications from client — ignored for now.
      return;
    }
    const request = msg as RpcRequest;
    if (!ctx.initialized && request.method !== METHODS.PROTOCOL_HELLO) {
      this.sendResponse(ctx, request.id, undefined, {
        code: 'NOT_INITIALIZED',
        message: 'send protocol/hello first',
      });
      return;
    }
    const handler = this.handlers.get(request.method);
    if (!handler) {
      this.sendResponse(ctx, request.id, undefined, {
        code: 'UNKNOWN_METHOD',
        message: `no handler for method ${request.method}`,
      });
      return;
    }
    try {
      const result = await handler(request.params, ctx);
      this.sendResponse(ctx, request.id, result, undefined);
    } catch (err) {
      const e = err as { code?: RpcErrorCode; message?: string; data?: unknown };
      const code: RpcErrorCode =
        e.code && isValidErrorCode(e.code) ? e.code : 'INTERNAL';
      this.sendResponse(ctx, request.id, undefined, {
        code,
        message: e.message ?? 'internal error',
        ...(e.data !== undefined ? { data: e.data } : {}),
      });
    }
  }

  rejectPendingForCtx(ctx: ClientCtx): void {
    for (const [id, entry] of this.pendingServerRequests) {
      if (entry.ctx === ctx) {
        this.pendingServerRequests.delete(id);
        if (entry.timer) clearTimeout(entry.timer);
        entry.reject(new Error('client disconnected before responding'));
      }
    }
  }

  private handleServerRequestResponse(msg: RpcResponse): void {
    const entry = this.pendingServerRequests.get(msg.id);
    if (!entry) return;
    this.pendingServerRequests.delete(msg.id);
    if (entry.timer) clearTimeout(entry.timer);
    if (msg.error) {
      entry.reject(new Error(`[${msg.error.code}] ${msg.error.message}`));
    } else {
      entry.resolve(msg.result);
    }
  }

  private sendResponse(
    ctx: ClientCtx,
    id: number,
    result: unknown,
    error: { code: RpcErrorCode; message: string; data?: unknown } | undefined,
  ): void {
    const response: RpcResponse = {
      type: 'response',
      id,
      ...(result !== undefined ? { result } : {}),
      ...(error ? { error: makeRpcError(error.code, error.message, error.data) } : {}),
    };
    if (!ctx.socket.destroyed) {
      ctx.socket.write(encodeMessage(response));
    }
  }
}

interface ServerError {
  code: RpcErrorCode;
  message: string;
  data?: unknown;
}

function makeServerError(code: RpcErrorCode, message: string, data?: unknown): ServerError {
  const err = new Error(message) as Error & ServerError;
  err.code = code;
  if (data !== undefined) err.data = data;
  return err as unknown as ServerError;
}

const ERROR_CODES = new Set<RpcErrorCode>([
  'INVALID_PROTOCOL_VERSION',
  'UNKNOWN_METHOD',
  'INVALID_PARAMS',
  'NOT_INITIALIZED',
  'SESSION_NOT_FOUND',
  'SESSION_ALREADY_EXISTS',
  'SESSION_KILL_PENDING',
  'SESSION_KILL_TIMEOUT',
  'SDK_ERROR',
  'INTERNAL',
]);

function isValidErrorCode(code: string): code is RpcErrorCode {
  return ERROR_CODES.has(code as RpcErrorCode);
}

/**
 * Windows named pipes use \\.\pipe\<name> or \\?\pipe\<name> — kernel objects,
 * not filesystem paths. Detect to skip mkdir/rm.
 */
function isWindowsNamedPipe(p: string): boolean {
  return /^\\\\[.?]\\pipe\\/.test(p);
}
