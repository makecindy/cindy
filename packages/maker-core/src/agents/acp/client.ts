import { AcpRpcError, isRecord, isRpcId, type AcpRpcId } from './protocol.js';
import type { AcpTransport } from './transport.js';
export { AcpRpcError } from './protocol.js';

export interface AcpClientOptions {
  onNotification?: (method: string, params: unknown) => void | Promise<void>;
  onRequest?: (method: string, params: unknown) => unknown | Promise<unknown>;
  onClose?: (error: Error) => void;
  requestTimeoutMs?: number;
}
export interface AcpRequestOptions { signal?: AbortSignal; timeoutMs?: number }
interface Pending { resolve(value: unknown): void; reject(error: Error): void; cleanup(): void }

/** One client per process. No payloads, stderr, or remote error data are logged. */
export class AcpClient {
  private nextId = 0;
  private pending = new Map<AcpRpcId, Pending>();
  private disconnected?: Error;
  private closing?: Promise<void>;
  private unsubscribe: Array<() => void> = [];
  constructor(private readonly transport: AcpTransport, private readonly options: AcpClientOptions = {}) {
    this.unsubscribe.push(transport.onClose(({ reason }) => this.disconnect(new Error(reason))));
    this.unsubscribe.push(transport.onLine(line => this.receive(line)));
  }
  getPid(): number | null { return this.transport.getPid?.() ?? null; }
  request<T = unknown>(method: string, params?: unknown, options: AcpRequestOptions = {}): Promise<T> {
    if (this.disconnected) return Promise.reject(this.disconnected);
    if (options.signal?.aborted) return Promise.reject(this.abortError());
    const timeoutMs = options.timeoutMs ?? this.options.requestTimeoutMs ?? 60_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
      return Promise.reject(new Error('ACP request timeout must be a positive bounded duration'));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => this.settle(id, undefined, this.abortError());
      const timer = setTimeout(() => this.settle(id, undefined, new Error('ACP request timed out')), timeoutMs);
      const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort); };
      this.pending.set(id, { resolve: value => resolve(value as T), reject, cleanup });
      options.signal?.addEventListener('abort', onAbort, { once: true });
      // Serialization may throw synchronously (e.g. cyclic caller data).
      try {
        void this.transport.writeLine(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
          .catch(() => this.settle(id, undefined, new Error('ACP request write failed')));
      } catch { this.settle(id, undefined, new Error('ACP request serialization failed')); }
    });
  }
  async notify(method: string, params?: unknown): Promise<void> {
    if (this.disconnected) throw this.disconnected;
    await this.transport.writeLine(JSON.stringify({ jsonrpc: '2.0', method, params }));
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.disconnect(new Error('ACP client closed'));
    this.closing = this.transport.close().then(() => {
      for (const unsubscribe of this.unsubscribe) unsubscribe();
      this.unsubscribe = [];
    }).catch(error => { this.closing = undefined; throw error; });
    return this.closing;
  }
  private abortError(): Error { const error = new Error('ACP request aborted'); error.name = 'AbortError'; return error; }
  private settle(id: AcpRpcId, value?: unknown, error?: Error): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    pending.cleanup();
    if (error) pending.reject(error); else pending.resolve(value);
  }
  private disconnect(error: Error): void {
    if (this.disconnected) return;
    this.disconnected = error;
    for (const id of this.pending.keys()) this.settle(id, undefined, error);
    try { this.options.onClose?.(error); } catch { /* observer isolation */ }
  }
  private receive(line: string): void {
    if (this.disconnected) return;
    let value: unknown;
    try { value = JSON.parse(line); } catch { this.replyError(null, -32700, 'Parse error'); return; }
    if (!isRecord(value) || value.jsonrpc !== '2.0') { this.replyError(null, -32600, 'Invalid Request'); return; }
    const hasId = Object.hasOwn(value, 'id');
    if (Object.hasOwn(value, 'method')) {
      if (typeof value.method !== 'string' || (hasId && !isRpcId(value.id)) || 'result' in value || 'error' in value ||
          ('params' in value && !isRecord(value.params) && !Array.isArray(value.params))) {
        this.replyError(isRpcId(value.id) ? value.id : null, -32600, 'Invalid Request'); return;
      }
      if (hasId) {
        void this.handleRequest(value.id as AcpRpcId, value.method, value.params);
      } else {
        try { void Promise.resolve(this.options.onNotification?.(value.method, value.params)).catch(() => {}); }
        catch { /* observer isolation */ }
      }
      return;
    }
    if (!hasId) { this.replyError(null, -32600, 'Invalid Request'); return; }
    // Ignore unsolicited/late responses and error replies with null IDs. Never answer a response.
    if (!isRpcId(value.id) || !this.pending.has(value.id)) return;
    const hasResult = Object.hasOwn(value, 'result');
    const hasError = Object.hasOwn(value, 'error');
    if (hasResult === hasError || (hasError && (!isRecord(value.error) || !Number.isInteger(value.error.code) || typeof value.error.message !== 'string'))) {
      this.settle(value.id, undefined, new Error('Invalid ACP response')); return;
    }
    if (hasError && isRecord(value.error)) {
      this.settle(value.id, undefined, new AcpRpcError(value.error.code as number, value.error.message as string, value.error.data));
    } else this.settle(value.id, value.result);
  }
  private async handleRequest(id: AcpRpcId, method: string, params: unknown): Promise<void> {
    try {
      if (!this.options.onRequest) throw new AcpRpcError(-32601, 'Method not found');
      const result = await this.options.onRequest(method, params);
      if (!this.disconnected) await this.transport.writeLine(JSON.stringify({ jsonrpc: '2.0', id, result: result ?? null }));
    } catch (error) {
      this.replyError(id, error instanceof AcpRpcError ? error.code : -32603,
        error instanceof AcpRpcError ? error.message : 'Internal error');
    }
  }
  private replyError(id: AcpRpcId | null, code: number, message: string): void {
    if (this.disconnected) return;
    try { void this.transport.writeLine(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })).catch(() => {}); }
    catch { /* shutdown or failed transport */ }
  }
}
