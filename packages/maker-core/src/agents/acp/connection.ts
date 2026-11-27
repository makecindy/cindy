/**
 * JSON-RPC 2.0 peer for one ACP endpoint.
 *
 * Both sides send requests: Cindy calls `initialize` / `session/*`, the agent
 * calls back (`session/request_permission`). One connection is owned by exactly
 * one Cindy session, so a crash only affects that task.
 */

import type { Logger } from '../../interfaces/logger.js';
import type { AcpLineTransport, AcpTransportClosed } from './line-transport.js';
import { asRecord, JSONRPC_INTERNAL_ERROR, JSONRPC_METHOD_NOT_FOUND, type AcpRecord } from './protocol.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const MAX_PEER_MESSAGE_CHARS = 300;

/** Peer error text is shown to users; keep it short and free of control characters. */
function sanitizePeerMessage(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > MAX_PEER_MESSAGE_CHARS ? `${text.slice(0, MAX_PEER_MESSAGE_CHARS)}…` : text;
}

export class AcpRpcError extends Error {
  readonly peerMessage: string | undefined;

  constructor(readonly method: string, readonly code: number, peerMessage?: unknown, readonly data?: unknown) {
    const sanitized = sanitizePeerMessage(peerMessage);
    super(sanitized ? `ACP ${method} failed (${code}): ${sanitized}` : `ACP ${method} failed (${code})`);
    this.name = 'AcpRpcError';
    this.peerMessage = sanitized;
  }
}

export class AcpConnectionClosedError extends Error {
  constructor(readonly info: AcpTransportClosed) {
    super(info.reason === 'closed-by-client'
      ? 'ACP connection closed'
      : `ACP agent ended (${info.reason}${info.detail ? `: ${info.detail}` : ''})`);
    this.name = 'AcpConnectionClosedError';
  }
}

export class AcpRequestTimeoutError extends Error {
  constructor(readonly method: string, readonly timeoutMs: number) {
    super(`ACP ${method} did not answer within ${timeoutMs} ms`);
    this.name = 'AcpRequestTimeoutError';
  }
}

/** Thrown by an incoming-request handler to answer with a specific JSON-RPC error. */
export class AcpHandlerError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
    this.name = 'AcpHandlerError';
  }
}

export interface AcpConnectionOptions {
  logger?: Logger;
  onNotification(method: string, params: AcpRecord): void;
  /** Answers agent → client requests. The signal aborts when the connection closes. */
  onRequest(method: string, params: AcpRecord, signal: AbortSignal): Promise<unknown>;
  /** Default timeout for Cindy → agent requests; `session/prompt` passes `null`. */
  requestTimeoutMs?: number;
}

interface PendingRequest {
  method: string;
  resolve(value: AcpRecord): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout> | null;
  cleanupAbort: (() => void) | null;
}

export class AcpConnection {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly incoming = new Set<AbortController>();
  private readonly closeListeners = new Set<(info: AcpTransportClosed) => void>();
  private closedInfo: AcpTransportClosed | null = null;
  private ignoredLines = 0;
  private readonly unsubscribe: Array<() => void>;

  constructor(private readonly transport: AcpLineTransport, private readonly options: AcpConnectionOptions) {
    this.unsubscribe = [
      transport.onLine((line) => this.receive(line)),
      transport.onClose((info) => this.markClosed(info)),
    ];
  }

  get closed(): AcpTransportClosed | null {
    return this.closedInfo;
  }

  get hasPendingRequests(): boolean {
    return this.pending.size > 0;
  }

  /** Fires once; immediately (microtask) when already closed. Returns a disposer. */
  onClose(listener: (info: AcpTransportClosed) => void): () => void {
    if (this.closedInfo) {
      const info = this.closedInfo;
      queueMicrotask(() => listener(info));
      return () => {};
    }
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  request(
    method: string,
    params: AcpRecord,
    opts: { timeoutMs?: number | null; signal?: AbortSignal; onResult?: (result: AcpRecord) => void } = {},
  ): Promise<AcpRecord> {
    if (this.closedInfo) return Promise.reject(new AcpConnectionClosedError(this.closedInfo));
    const id = this.nextId++;
    const timeoutMs = opts.timeoutMs === undefined ? this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS : opts.timeoutMs;
    return new Promise<AcpRecord>((resolve, reject) => {
      const entry: PendingRequest = { method, resolve, reject, timer: null, cleanupAbort: null };
      const settle = (): void => {
        if (entry.timer) clearTimeout(entry.timer);
        entry.cleanupAbort?.();
        this.pending.delete(id);
      };
      entry.resolve = (value) => {
        settle();
        if (opts.onResult) {
          try {
            opts.onResult(value);
          } catch (error) {
            this.options.logger?.error('acp: response handler failed', { method, error: String(error) });
          }
        }
        resolve(value);
      };
      entry.reject = (error) => { settle(); reject(error); };
      if (timeoutMs !== null) {
        entry.timer = setTimeout(() => entry.reject(new AcpRequestTimeoutError(method, timeoutMs)), timeoutMs);
      }
      if (opts.signal) {
        const signal = opts.signal;
        const onAbort = (): void => entry.reject(signal.reason instanceof Error ? signal.reason : new Error(`ACP ${method} aborted`));
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener('abort', onAbort, { once: true });
        entry.cleanupAbort = () => signal.removeEventListener('abort', onAbort);
      }
      this.pending.set(id, entry);
      try {
        this.send({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        entry.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Returns false when the connection is already closed (notifications are best effort). */
  notify(method: string, params: AcpRecord): boolean {
    if (this.closedInfo) return false;
    try {
      this.send({ jsonrpc: '2.0', method, params });
      return true;
    } catch {
      return false;
    }
  }

  /** Closes the endpoint and waits for the host's exit confirmation. Idempotent. */
  async close(): Promise<void> {
    this.markClosed({ reason: 'closed-by-client' });
    await this.transport.close();
  }

  private send(message: AcpRecord): void {
    if (this.closedInfo) throw new AcpConnectionClosedError(this.closedInfo);
    try {
      this.transport.write(JSON.stringify(message));
    } catch (error) {
      this.markClosed({ reason: 'protocol-error', detail: 'write failed' });
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  private receive(line: string): void {
    if (this.closedInfo) return;
    let message: AcpRecord;
    try {
      const parsed: unknown = JSON.parse(line);
      message = asRecord(parsed);
      if (message.jsonrpc !== '2.0') throw new Error('not JSON-RPC 2.0');
    } catch {
      // Some CLIs print banners or logs on stdout. Ignore them instead of killing
      // the task, but never log the line itself (it may contain user data).
      this.ignoredLines += 1;
      if (this.ignoredLines === 1 || this.ignoredLines % 100 === 0) {
        this.options.logger?.warn('acp: ignored non-protocol stdout line', { count: this.ignoredLines, chars: line.length });
      }
      return;
    }

    const id = message.id;
    if (typeof message.method === 'string') {
      const params = asRecord(message.params);
      if (id === undefined || id === null) {
        try {
          this.options.onNotification(message.method, params);
        } catch (error) {
          this.options.logger?.error('acp: notification handler failed', { method: message.method, error: String(error) });
        }
        return;
      }
      if (typeof id === 'string' || typeof id === 'number') void this.answer(id, message.method, params);
      return;
    }

    if (typeof id !== 'number') return;
    const pending = this.pending.get(id);
    if (!pending) return; // late answer after timeout/abort
    if (message.error !== undefined) {
      const error = asRecord(message.error);
      pending.reject(new AcpRpcError(
        pending.method,
        typeof error.code === 'number' ? error.code : JSONRPC_INTERNAL_ERROR,
        error.message,
        error.data,
      ));
      return;
    }
    pending.resolve(asRecord(message.result));
  }

  private async answer(id: string | number, method: string, params: AcpRecord): Promise<void> {
    const controller = new AbortController();
    this.incoming.add(controller);
    try {
      const result = await this.options.onRequest(method, params, controller.signal);
      if (!this.closedInfo) this.send({ jsonrpc: '2.0', id, result: result ?? null });
    } catch (error) {
      if (this.closedInfo) return;
      const code = error instanceof AcpHandlerError ? error.code : JSONRPC_INTERNAL_ERROR;
      const text = error instanceof AcpHandlerError ? error.message : 'Client request failed';
      if (!(error instanceof AcpHandlerError)) {
        this.options.logger?.error('acp: client request handler failed', { method, error: String(error) });
      }
      try {
        this.send({ jsonrpc: '2.0', id, error: { code, message: text } });
      } catch { /* connection already closing */ }
    } finally {
      this.incoming.delete(controller);
    }
  }

  private markClosed(info: AcpTransportClosed): void {
    if (this.closedInfo) return;
    this.closedInfo = info;
    for (const off of this.unsubscribe) off();
    for (const controller of this.incoming) controller.abort();
    this.incoming.clear();
    const error = new AcpConnectionClosedError(info);
    for (const entry of [...this.pending.values()]) entry.reject(error);
    const listeners = [...this.closeListeners];
    this.closeListeners.clear();
    for (const listener of listeners) {
      try {
        listener(info);
      } catch (listenerError) {
        this.options.logger?.error('acp: close listener failed', { error: String(listenerError) });
      }
    }
  }
}

export function methodNotFound(method: string): AcpHandlerError {
  return new AcpHandlerError(JSONRPC_METHOD_NOT_FOUND, `Method not found: ${method}`);
}
