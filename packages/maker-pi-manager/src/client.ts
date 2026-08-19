/**
 * pi-manager RPC client — used by the desktop side to talk to a remote
 * pi-manager daemon over an SSH execStream bridge (same transport pattern as
 * cc-mgr's client, but this client speaks the `pi/*` method namespace).
 *
 * The client runs over a Duplex stream (Node stream.Duplex), so it can sit on
 * top of either a local socket or an SSH execStream adapter.
 */

import { Duplex } from 'node:stream';

import { NDJSONDecoder, encodeMessage } from './codec.js';
import {
  PROTOCOL_VERSION,
  isRpcNotification,
  isRpcResponse,
  type HelloParams,
  type HelloResult,
  type MethodName,
  type NotificationName,
  type RpcError,
  type RpcId,
  type RpcMessage,
  type RpcNotification,
} from './protocol.js';

export interface RpcClientOptions {
  /** Optional client id sent in hello, for daemon-side log correlation. */
  clientId?: string;
  /** Timeout for a single request/response round trip. Default 30s. */
  requestTimeoutMs?: number;
}

export class RpcClient {
  private nextId: RpcId = 1;
  private readonly pending = new Map<
    RpcId,
    { resolve: (value: unknown) => void; reject: (err: Error) => void; timer?: NodeJS.Timeout }
  >();
  private readonly notificationHandlers = new Map<
    NotificationName | string,
    (method: string, params: unknown) => void
  >();
  private readonly closeHandlers: Array<() => void> = [];
  private readonly decoder = new NDJSONDecoder({
    onCorruptLine: (line, err) =>
      this.options.logger?.warn?.('corrupt ndjson line from daemon', {
        error: err.message,
        line: line.slice(0, 200),
      }),
  });
  private readonly options: RpcClientOptions & { logger?: Pick<Console, 'warn' | 'debug'> };
  private helloDone = false;

  constructor(
    private readonly stream: Duplex,
    opts: RpcClientOptions & { logger?: Pick<Console, 'warn' | 'debug'> } = {},
  ) {
    this.options = opts;
    stream.on('data', (chunk: Buffer) => {
      for (const msg of this.decoder.push(chunk)) {
        this.handleMessage(msg);
      }
    });
    stream.on('close', () => {
      this.rejectAllPending(new Error('pi-manager stream closed'));
    });
    stream.on('end', () => {
      // 对端干净关闭读方向(FIN):Duplex 默认 allowHalfOpen=true, 只发 end
      // 不保证发 close —— 半关闭同样意味着 daemon 不再回话, 必须立刻 reject
      // pending 而不是挂到超时(轮 3 HIGH #1)。destroy 顺带触发 close 兜底。
      this.rejectAllPending(new Error('pi-manager stream ended (remote closed)'));
      this.stream.destroy();
    });
    stream.on('error', (err) => {
      // 留日志便于区分「干净关闭」vs「传输故障」(SSH pipe 断 / ECONNRESET)。
      this.options.logger?.warn?.('pi-manager stream error', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  /** Perform the protocol/hello handshake. Rejects on version mismatch. */
  async hello(opts: { timeoutMs?: number } = {}): Promise<HelloResult> {
    const params: HelloParams = {
      protocolVersion: PROTOCOL_VERSION,
      ...(this.options.clientId ? { clientId: this.options.clientId } : {}),
    };
    const result = await this.request<HelloResult>('protocol/hello' as MethodName, params, opts);
    this.helloDone = true;
    return result;
  }

  request<R = unknown>(
    method: MethodName,
    params: unknown,
    opts: { timeoutMs?: number } = {},
  ): Promise<R> {
    if (this.stream.destroyed) {
      const err = new Error('pi-manager client stream is destroyed') as Error & { code?: string };
      err.code = 'STREAM_DESTROYED';
      return Promise.reject(err);
    }
    if (!this.helloDone && method !== 'protocol/hello') {
      return Promise.reject(new Error('must call hello() before other requests'));
    }
    // 溢出回绕(轮 3 #10):理论上 2^53 次请求后 id 失去安全整数性, 响应会被
    // isRpcMessage 的 Number.isSafeInteger 拒掉。先取后增保持从 1 开始。
    const id = this.nextId;
    this.nextId = this.nextId >= Number.MAX_SAFE_INTEGER ? 1 : this.nextId + 1;
    return new Promise<R>((resolve, reject) => {
      // timeoutMs <= 0 视为不设超时(轮 3 #3):避免调用方传 0/-1 时立刻超时。
      const timeoutMs = opts.timeoutMs ?? this.options.requestTimeoutMs ?? 30_000;
      const timer = timeoutMs > 0
        ? setTimeout(() => {
            this.pending.delete(id);
            const err = new Error(`request ${method} timed out after ${timeoutMs}ms`) as Error & { code?: string };
            err.code = 'TIMEOUT';
            reject(err);
          }, timeoutMs)
        : undefined;
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      const request: RpcMessage = { type: 'request', id, method, params };
      // 编码失败(轮 3 #4):清理 pending entry, 不让 timer 空转到超时。
      try {
        this.stream.write(encodeMessage(request));
      } catch (err) {
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(new Error(`request ${method} serialization failed: ${(err as Error).message}`));
      }
    });
  }

  notify(method: NotificationName | MethodName, params: unknown): void {
    if (this.stream.destroyed) return;
    const notification: RpcNotification = { type: 'notification', method, params };
    this.stream.write(encodeMessage(notification));
  }

  /** Subscribe to daemon→client notifications. Returns unsubscribe. */
  subscribe(handler: (method: string, params: unknown) => void): () => void {
    const key = Symbol('handler');
    this.notificationHandlers.set(key as unknown as string, handler);
    return () => this.notificationHandlers.delete(key as unknown as string);
  }

  /** Subscribe to stream close. Returns unsubscribe. */
  subscribeClose(handler: () => void): () => void {
    this.closeHandlers.push(handler);
    return () => {
      const idx = this.closeHandlers.indexOf(handler);
      if (idx >= 0) this.closeHandlers.splice(idx, 1);
    };
  }

  /** Tear down: destroy the underlying stream (idempotent). */
  dispose(): void {
    this.stream.destroy();
  }

  /** Reject every in-flight request with a typed error (close/end 共用)。 */
  private rejectAllPending(error: Error): void {
    const err = error as Error & { code?: string };
    err.code = err.code ?? 'STREAM_CLOSED';
    for (const [, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
    // 迭代副本:handler 内 unsubscribe(splice) 不会跳过后续 handler(轮 3 #2)。
    for (const handler of [...this.closeHandlers]) {
      try { handler(); } catch { /* */ }
    }
  }

  private handleMessage(msg: RpcMessage): void {
    if (isRpcResponse(msg)) {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) {
        entry.reject(new RpcClientError(msg.error));
      } else {
        entry.resolve(msg.result);
      }
      return;
    }
    if (isRpcNotification(msg)) {
      for (const handler of this.notificationHandlers.values()) {
        try { handler(msg.method, msg.params); } catch (err) {
          this.options.logger?.warn?.('notification handler threw', {
            method: msg.method,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return;
    }
    // Request from server (reverse-request) — pi-manager has none today.
    this.options.logger?.warn?.('unexpected server request', { method: (msg as { method?: string }).method });
  }
}

export class RpcClientError extends Error {
  readonly code: string;
  readonly data?: unknown;

  constructor(error: RpcError) {
    super(`${error.code}: ${error.message}`);
    this.code = error.code;
    this.data = error.data;
  }
}
