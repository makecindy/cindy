import {
  PLUGIN_OAUTH_TTL_MS,
  parsePluginAuthorizationRequest,
  parsePluginAuthorizationResult,
  type PluginAuthorizationRequest,
  type PluginAuthorizationResult,
} from '@cindy/device-link';
import type { NodeRequestScopes } from './nodeRequestScope.js';

/** Bootstrap-private replies; callback codes never travel through JSON-RPC stdout. */
export class NodeAuthorizationClient {
  private nextId = 1;
  private readonly pending = new Map<
    string,
    {
      rpcId: string;
      request: PluginAuthorizationRequest;
      assertCurrent(): void;
      resolve(result: PluginAuthorizationResult): void;
      reject(error: Error): void;
      timer: NodeJS.Timeout;
    }
  >();
  constructor(
    private readonly scopes: NodeRequestScopes,
    private readonly send: (message: unknown) => void,
  ) {}

  bind():
    ((request: PluginAuthorizationRequest) => Promise<PluginAuthorizationResult>) | undefined {
    const bound = this.scopes.capture();
    if (!bound) return undefined;
    let used = false;
    return async (raw) => {
      bound.assertCurrent();
      if (used) throw new Error('PLUGIN_AUTHORIZATION_UNAVAILABLE');
      const request = parsePluginAuthorizationRequest(raw);
      const ttl = Math.min(
        PLUGIN_OAUTH_TTL_MS,
        request.kind === 'loopback' ? Infinity : (request.expiresAt ?? Infinity) - Date.now(),
      );
      if (ttl <= 0) throw new Error('PLUGIN_AUTHORIZATION_EXPIRED');
      used = true;
      const reqId = 'auth' + this.nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => this.settle(reqId), ttl);
        timer.unref?.();
        this.pending.set(reqId, {
          rpcId: bound.rpcId,
          request,
          assertCurrent: bound.assertCurrent,
          resolve,
          reject,
          timer,
        });
        try {
          this.send({ type: 'plugin-authorize', reqId, rpcId: bound.rpcId, request });
        } catch {
          this.settle(reqId);
        }
      });
    };
  }
  private settle(reqId: string, raw?: unknown): void {
    const pending = this.pending.get(reqId);
    if (!pending) return;
    this.pending.delete(reqId);
    clearTimeout(pending.timer);
    try {
      pending.assertCurrent();
      const result = parsePluginAuthorizationResult(raw);
      if (
        result.kind === 'callback' &&
        (pending.request.kind !== 'loopback' || pending.request.state !== result.state)
      )
        throw new Error('stale');
      pending.resolve(result);
    } catch {
      pending.reject(new Error('PLUGIN_AUTHORIZATION_UNAVAILABLE'));
    }
  }
  reply(value: Record<string, unknown>): void {
    if (typeof value.reqId === 'string')
      this.settle(value.reqId, value.ok === true ? value.result : undefined);
  }
  finish(rpcId: string): void {
    for (const [id, pending] of this.pending) if (pending.rpcId === rpcId) this.settle(id);
  }
}
