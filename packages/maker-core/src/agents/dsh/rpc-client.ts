import { redactSensitiveText } from '@cindy/maker-shared/error-redaction';
import type { Logger } from '../../interfaces/logger.js';
import type { DshRpcError, DshRpcInbound, DshRpcNotification, DshRpcSuccess } from './protocol.js';
import type { DshTransport } from './transport.js';

export class DshRpcRequestTimeoutError extends Error {
  readonly code = 'DSH_RPC_TIMEOUT';
  constructor(readonly method: string, readonly timeoutMs: number) { super(`dsh RPC timeout after ${timeoutMs}ms: ${method}`); this.name = 'DshRpcRequestTimeoutError'; }
}
export interface DshRpcProcessOptions {
  transport: DshTransport; logger: Logger;
  onNotification: (notification: DshRpcNotification) => void;
  onExit: (info: { code: number | null; signal: NodeJS.Signals | null }) => void;
}
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export class DshRpcProcess {
  private nextRequestId = 1;
  private closed = false;
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: NodeJS.Timeout }>();
  constructor(private readonly options: DshRpcProcessOptions) {
    options.transport.onLine((line) => this.handleLine(line));
    options.transport.onClose((info) => { this.closed = true; this.failAllPending(new Error(info.reason)); options.onExit({ code: info.code, signal: info.signal }); });
  }
  get pid(): number | undefined { return this.options.transport.pid; }
  get isClosed(): boolean { return this.closed || this.options.transport.isClosed(); }
  request<T = unknown>(method: string, params?: unknown, options: { timeoutMs?: number } = {}): Promise<T> {
    if (this.isClosed) return Promise.reject(new Error('dsh process already exited'));
    const id = `c${this.nextRequestId++}`; const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new DshRpcRequestTimeoutError(method, timeoutMs)); }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      void this.options.transport.writeLine(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })).catch((error) => {
        const pending = this.pending.get(id); if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(id); reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }
  close(): Promise<void> { this.closed = true; this.failAllPending(new Error('dsh process closing')); return this.options.transport.close(); }
  private handleLine(line: string): void {
    if (!line.trim()) return;
    let frame: DshRpcInbound;
    try { frame = JSON.parse(line) as DshRpcInbound; } catch { this.options.logger.warn('dsh rpc: non-JSON stdout line dropped', { line: redactSensitiveText(line).slice(0, 500) }); return; }
    if (!frame || typeof frame !== 'object' || (frame as { jsonrpc?: unknown }).jsonrpc !== '2.0') return;
    if ('method' in frame && typeof frame.method === 'string' && !('id' in frame)) { this.options.onNotification(frame); return; }
    if (!('id' in frame) || typeof frame.id !== 'string') return;
    const pending = this.pending.get(frame.id); if (!pending) { this.options.logger.warn('dsh rpc: unmatched response', { id: frame.id }); return; }
    clearTimeout(pending.timer); this.pending.delete(frame.id);
    if ('error' in frame) { const error = frame as DshRpcError; pending.reject(new Error(`dsh RPC error ${error.error.code}: ${redactSensitiveText(error.error.message)}`)); }
    else pending.resolve((frame as DshRpcSuccess).result);
  }
  private failAllPending(error: Error): void { for (const [, entry] of this.pending) { clearTimeout(entry.timer); entry.reject(error); } this.pending.clear(); }
}
