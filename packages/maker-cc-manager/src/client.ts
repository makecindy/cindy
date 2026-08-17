/**
 * RpcClient — NDJSON RPC over any Duplex stream (unix socket / TCP / SSH exec).
 *
 * Lifecycle:
 *   const client = new RpcClient(stream, { onNotification, onClose, onError });
 *   await client.hello();                        // protocol handshake
 *   const result = await client.request(method, params);
 *   client.dispose();                            // tear down (does NOT close stream)
 *
 * Stream ownership: caller owns the underlying stream (creates + destroys).
 * RpcClient only attaches listeners — dispose() detaches them.
 *
 * Timeouts: per-request opt-in via opts.timeoutMs. Default = no timeout.
 * On timeout the pending promise rejects but the underlying request id is
 * marked as orphaned — if the response arrives later it's silently dropped.
 */

import type { Duplex } from 'node:stream';

import { NDJSONDecoder, encodeMessage } from './codec.js';
import {
  METHODS,
  PROTOCOL_VERSION,
  isRpcNotification,
  isRpcRequest,
  isRpcResponse,
  type HelloParams,
  type HelloResult,
  type NotificationName,
  type RpcError,
  type RpcId,
  type RpcMessage,
  type RpcNotification,
  type RpcRequest,
  type RpcResponse,
} from './protocol.js';

export interface RpcClientOptions {
  /** Called for any incoming notification (no id). */
  onNotification?: (n: RpcNotification) => void;
  /** Called when the underlying stream ends (peer closed or local dispose). */
  onClose?: () => void;
  /** Called when the underlying stream errors. */
  onError?: (err: Error) => void;
  /** Optional client identifier, sent on hello() for log correlation. */
  clientId?: string;
  /** Called when a corrupt NDJSON line is encountered (for diagnostics). */
  onCorruptLine?: (line: string, err: Error) => void;
}

export interface RpcRequestOptions {
  /** Reject the promise after this many ms. Default: no timeout. */
  timeoutMs?: number;
}

export interface RpcPendingRequest<R = unknown> {
  /** Resolves once the local Duplex accepts the encoded NDJSON request. */
  submitted: Promise<void>;
  /** Resolves or rejects with the later correlated RPC response. */
  response: Promise<R>;
}

export class RpcClientError extends Error {
  constructor(public readonly rpcError: RpcError) {
    super(`[${rpcError.code}] ${rpcError.message}`);
    this.name = 'RpcClientError';
  }
}

interface PendingEntry {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  resolveSubmitted: () => void;
  rejectSubmitted: (err: Error) => void;
  timer?: NodeJS.Timeout;
}

export type NotificationSubscriber = (n: RpcNotification) => void;
export type CloseSubscriber = () => void;
/**
 * Handler for server→client requests (reverse-request pattern).
 * Must return a result value (JSON-serializable) or throw to signal error.
 */
export type ServerRequestHandler = (params: unknown) => Promise<unknown> | unknown;

export class RpcClient {
  private nextId: RpcId = 1;
  private readonly pending = new Map<RpcId, PendingEntry>();
  private readonly decoder: NDJSONDecoder;
  private readonly onNotificationCtor?: (n: RpcNotification) => void;
  private readonly onClose?: () => void;
  private readonly onError?: (err: Error) => void;
  private readonly clientId?: string;
  private readonly listeners: Array<{ event: string; fn: (...args: unknown[]) => void }> = [];
  /** Additional subscribers added after construction via subscribe(). */
  private readonly subscribers = new Set<NotificationSubscriber>();
  /** Lifecycle subscribers — fire once when the underlying stream closes. */
  private readonly closeSubscribers = new Set<CloseSubscriber>();
  /** Handlers for server→client requests (reverse-request). */
  private readonly requestHandlers = new Map<string, ServerRequestHandler>();
  /** True once the underlying stream emitted 'close' (or dispose() ran). */
  private closedFired = false;
  private disposed = false;

  constructor(
    private readonly stream: Duplex,
    opts: RpcClientOptions = {},
  ) {
    this.onNotificationCtor = opts.onNotification;
    this.onClose = opts.onClose;
    this.onError = opts.onError;
    this.clientId = opts.clientId;
    this.decoder = new NDJSONDecoder({ onCorruptLine: opts.onCorruptLine });
    this.attach();
  }

  /**
   * Send protocol/hello and validate version match. Should be called once
   * immediately after construction, before any other request.
   *
   * `opts.timeoutMs` 强烈建议传 — daemon 活着但 unresponsive (被 uncaughtException
   * guard 救活但 hang 在 handler) 时 hello 永远不返回, 不传 timeout client 卡死。
   */
  async hello(opts: RpcRequestOptions = {}): Promise<HelloResult> {
    const params: HelloParams = {
      protocolVersion: PROTOCOL_VERSION,
      ...(this.clientId ? { clientId: this.clientId } : {}),
    };
    return await this.request<HelloResult>(METHODS.PROTOCOL_HELLO, params, opts);
  }

  /**
   * Send a request and wait for the matching response. Resolves with `result`,
   * rejects with `RpcClientError` if the server returned an `error` field, or
   * with a plain `Error` on timeout / stream close.
   */
  async request<R = unknown>(
    method: string,
    params: unknown,
    opts: RpcRequestOptions = {},
  ): Promise<R> {
    const pending = this.requestWithSubmission<R>(method, params, opts);
    // Existing callers wait on the response, which also rejects on write
    // failure. Observe the auxiliary submission promise to avoid an unhandled
    // rejection when only the compatibility API is used.
    void pending.submitted.catch(() => undefined);
    return pending.response;
  }

  requestWithSubmission<R = unknown>(
    method: string,
    params: unknown,
    opts: RpcRequestOptions = {},
  ): RpcPendingRequest<R> {
    if (this.disposed || this.closedFired || this.stream.destroyed) {
      const failed: Promise<never> = Promise.reject(
        new Error('RpcClient is disposed or stream closed'),
      );
      return { submitted: failed, response: failed };
    }
    const id = this.nextId++;
    let payload: string;
    try {
      payload = encodeMessage({ type: 'request', id, method, params });
    } catch (error) {
      const failed: Promise<never> = Promise.reject(error);
      return { submitted: failed, response: failed };
    }

    let resolveSubmitted!: () => void;
    let rejectSubmitted!: (err: Error) => void;
    const submitted = new Promise<void>((resolve, reject) => {
      resolveSubmitted = resolve;
      rejectSubmitted = reject;
    });
    const response = new Promise<R>((resolve, reject) => {
      const entry: PendingEntry = {
        resolve: resolve as (v: unknown) => void,
        reject,
        resolveSubmitted,
        rejectSubmitted,
      };
      if (opts.timeoutMs && opts.timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          if (this.pending.delete(id)) {
            const error = new Error(`RPC ${method} timed out after ${opts.timeoutMs}ms`);
            rejectSubmitted(error);
            reject(error);
          }
        }, opts.timeoutMs);
      }
      this.pending.set(id, entry);
      try {
        this.stream.write(payload, (error?: Error | null) => {
          if (!error) {
            resolveSubmitted();
            return;
          }
          rejectSubmitted(error);
          if (this.pending.get(id) === entry) {
            this.pending.delete(id);
            if (entry.timer) clearTimeout(entry.timer);
            reject(error);
          }
        });
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        rejectSubmitted(error);
        if (this.pending.get(id) === entry) {
          this.pending.delete(id);
          if (entry.timer) clearTimeout(entry.timer);
          reject(error);
        }
      }
    });
    return { submitted, response };
  }

  /**
   * Subscribe to incoming notifications. Multiple subscribers are supported
   * (the constructor-level `onNotification` callback is invoked first, then
   * all subscribers). Returns an unsubscribe function.
   */
  subscribe(handler: NotificationSubscriber): () => void {
    this.subscribers.add(handler);
    return () => {
      this.subscribers.delete(handler);
    };
  }

  /**
   * Subscribe to stream-close lifecycle. Fires exactly once when the underlying
   * Duplex emits 'close' (peer hung up / local dispose). Subscribers added
   * **after** the close already fired are invoked synchronously here, so a
   * late RemoteQuery still learns about a dead daemon without polling.
   *
   * Why this matters: RemoteQuery only watches NOTIFICATIONS.SESSION_CLOSED
   * for end-of-stream. When the daemon is killed abruptly (force-upgrade,
   * SIGKILL, network blip), SESSION_CLOSED may not flush in time, leaving
   * the async iterator wedged on an empty queue. close subscription lets
   * RemoteQuery treat stream close as an implicit session-closed signal.
   */
  subscribeClose(handler: CloseSubscriber): () => void {
    if (this.closedFired) {
      try {
        handler();
      } catch {
        /* */
      }
      return () => undefined;
    }
    this.closeSubscribers.add(handler);
    return () => {
      this.closeSubscribers.delete(handler);
    };
  }

  /** True once the underlying stream closed (or dispose() ran). */
  isClosed(): boolean {
    return this.closedFired;
  }

  /** Send a notification (fire-and-forget, no response). */
  notify(method: NotificationName | string, params: unknown): void {
    if (this.disposed || this.closedFired || this.stream.destroyed) {
      throw new Error('RpcClient is disposed or stream closed');
    }
    this.stream.write(encodeMessage({ type: 'notification', method, params }));
  }

  /**
   * Register a handler for server→client requests (reverse-request pattern).
   * When the server sends a request with this method, the handler is called
   * and its return value (or thrown error) is sent back as the response.
   */
  setRequestHandler(method: string, handler: ServerRequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  /**
   * Detach listeners and reject any pending requests. Does NOT close the
   * underlying stream — caller owns it.
   *
   * Also fires close subscribers (idempotent — `closedFired` guards), so
   * RemoteQuery instances created against this client get their messageQueue
   * ended even when teardown comes from our side rather than peer EOF.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const { event, fn } of this.listeners) {
      this.stream.off(event, fn);
    }
    this.listeners.length = 0;
    for (const [, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer);
      const error = new Error('RpcClient disposed');
      entry.rejectSubmitted(error);
      entry.reject(error);
    }
    this.pending.clear();
    this.fireClose();
  }

  private attach(): void {
    const onData = (chunk: Buffer | string): void => {
      for (const msg of this.decoder.push(chunk)) {
        this.handleIncoming(msg);
      }
    };
    const onClose = (): void => {
      // Reject pending — but keep dispose flag so request() refuses new sends.
      for (const [, entry] of this.pending) {
        if (entry.timer) clearTimeout(entry.timer);
        const error = new Error('RPC stream closed');
        entry.rejectSubmitted(error);
        entry.reject(error);
      }
      this.pending.clear();
      this.onClose?.();
      this.fireClose();
    };
    const onError = (err: Error): void => {
      this.onError?.(err);
    };
    this.stream.on('data', onData);
    this.stream.on('close', onClose);
    this.stream.on('error', onError);
    this.listeners.push({ event: 'data', fn: onData as (...args: unknown[]) => void });
    this.listeners.push({ event: 'close', fn: onClose as (...args: unknown[]) => void });
    this.listeners.push({ event: 'error', fn: onError as (...args: unknown[]) => void });
  }

  private handleIncoming(msg: RpcMessage): void {
    if (isRpcResponse(msg)) {
      this.handleResponse(msg);
      return;
    }
    if (isRpcNotification(msg)) {
      this.onNotificationCtor?.(msg);
      for (const sub of this.subscribers) {
        try {
          sub(msg);
        } catch {
          /* ignore subscriber errors */
        }
      }
      return;
    }
    if (isRpcRequest(msg)) {
      void this.handleServerRequest(msg);
      return;
    }
  }

  private async handleServerRequest(req: RpcRequest): Promise<void> {
    const handler = this.requestHandlers.get(req.method);
    if (!handler) {
      const response: RpcResponse = {
        type: 'response',
        id: req.id,
        error: { code: 'UNKNOWN_METHOD', message: `no client handler for ${req.method}` },
      };
      if (!this.disposed) this.stream.write(encodeMessage(response));
      return;
    }
    try {
      const result = await handler(req.params);
      const response: RpcResponse = { type: 'response', id: req.id, result };
      if (!this.disposed) this.stream.write(encodeMessage(response));
    } catch (err) {
      const response: RpcResponse = {
        type: 'response',
        id: req.id,
        error: { code: 'INTERNAL', message: (err as Error)?.message ?? 'handler error' },
      };
      if (!this.disposed) this.stream.write(encodeMessage(response));
    }
  }

  private fireClose(): void {
    if (this.closedFired) return;
    this.closedFired = true;
    for (const sub of this.closeSubscribers) {
      try {
        sub();
      } catch {
        /* */
      }
    }
    this.closeSubscribers.clear();
  }

  private handleResponse(msg: RpcResponse): void {
    const entry = this.pending.get(msg.id);
    if (!entry) {
      // Likely a late response after timeout — drop silently.
      return;
    }
    this.pending.delete(msg.id);
    if (entry.timer) clearTimeout(entry.timer);
    // A correlated response proves the request crossed the transport even if
    // a custom Duplex has not invoked its write callback yet.
    entry.resolveSubmitted();
    if (msg.error) {
      entry.reject(new RpcClientError(msg.error));
    } else {
      entry.resolve(msg.result);
    }
  }
}
