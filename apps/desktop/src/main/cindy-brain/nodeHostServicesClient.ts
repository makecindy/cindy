import type { NodeRequestScopes } from './nodeRequestScope.js';

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
  private request(type: string, payload: Record<string, unknown>, bound?: { rpcId: string; assertCurrent(): void }): Promise<unknown> {
    bound?.assertCurrent();
    if (this.pending.size >= 8) return Promise.reject(new Error('NODE_HOST_BUSY'));
    const reqId = 'host' + this.nextId++;
    return new Promise((resolve, reject) => {
      // A Host tool may await the owner's native confirmation, like the UI path.
      // The existing RPC-bound authenticated-fetch timeout remains unchanged.
      const timer = bound ? setTimeout(() => this.reply({ reqId, ok: false }), 120000) : undefined;
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
