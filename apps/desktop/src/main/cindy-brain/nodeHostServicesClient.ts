import type { NodeRequestScopes } from './nodeRequestScope.js';
import { GHOST_FETCH_MEDIA_TIMEOUT_MAX_MS, GHOST_FETCH_TIMEOUT_MAX_MS, GHOST_NODE_NETWORK_REQUEST_MAX_CHARS } from '../../shared/ghost.js';

/** Bootstrap-private upload channel. No secret travels through stdout. */
export class NodeHostServicesClient {
  private nextId = 1;
  private readonly pending = new Map<
    string,
    {
      rpcId?: string;
      assertCurrent(): void;
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer?: NodeJS.Timeout;
    }
  >();
  constructor(
    private readonly scopes: NodeRequestScopes,
    private readonly send: (value: unknown) => void,
  ) {}
  /** Autonomous Host tools are tied to the worker installation, not an Agent RPC. */
  hostCall(server: string, tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
    return this.request('host-tool-request', { server, tool, args });
  }
  network(request: Record<string, unknown>): Promise<unknown> {
    try {
      if (JSON.stringify(request).length > GHOST_NODE_NETWORK_REQUEST_MAX_CHARS) throw new Error();
    } catch { return Promise.reject(new Error('NETWORK_INVALID_REQUEST')); }
    // The Host applies each fetch's real deadline, including media/upload IO.
    // This transport fallback must allow that maximum plus the existing 60s
    // bridge budget for preparation/cleanup and delivery of its final receipt.
    return this.request('network-request', { request }, undefined,
      request.op === 'fetch' ? GHOST_FETCH_MEDIA_TIMEOUT_MAX_MS + GHOST_FETCH_TIMEOUT_MAX_MS : undefined);
  }
  private request(type: string, payload: Record<string, unknown>, bound?: { rpcId: string; assertCurrent(): void }, networkTimeoutMs = 60000): Promise<unknown> {
    bound?.assertCurrent();
    if (this.pending.size >= 8) return Promise.reject(new Error('NODE_HOST_BUSY'));
    const reqId = 'host' + this.nextId++;
    return new Promise((resolve, reject) => {
      // A Host tool may await the owner's native confirmation, like the UI path.
      // The existing RPC-bound authenticated-fetch timeout remains unchanged.
      const timer = bound || type === 'network-request' ? setTimeout(() => this.reply({ reqId, ok: false }), bound ? 120000 : networkTimeoutMs) : undefined;
      timer?.unref?.();
      this.pending.set(reqId, { ...bound, assertCurrent: () => bound?.assertCurrent(), resolve, reject, timer });
      try {
        this.send({ ...payload, type, reqId, ...(bound ? { rpcId: bound.rpcId } : {}) });
      } catch {
        this.reply({ reqId, ok: false });
      }
    });
  }
  bind() {
    const bound = this.scopes.capture();
    if (!bound) return undefined;
    return Object.freeze({
      signal: bound.signal,
      authenticatedFetch: (input: Record<string, unknown>, authorization: string) =>
        this.request('authenticated-fetch', { request: input, authorization }, bound),
    });
  }
  reply(value: Record<string, unknown>) {
    if (typeof value.reqId !== 'string') return;
    const p = this.pending.get(value.reqId);
    if (!p) return;
    this.pending.delete(value.reqId);
    clearTimeout(p.timer);
    try {
      p.assertCurrent();
      if (value.ok !== true) throw new Error();
      p.resolve(value.result);
    } catch {
      p.reject(new Error('NODE_HOST_OPERATION_FAILED'));
    }
  }
  finish(rpcId: string) {
    for (const [reqId, p] of this.pending) if (p.rpcId === rpcId) this.reply({ reqId, ok: false });
  }
}
