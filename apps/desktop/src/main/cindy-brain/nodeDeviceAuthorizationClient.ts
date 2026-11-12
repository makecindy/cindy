import { PLUGIN_OAUTH_TTL_MS, parseDeviceAuthorizationUrl } from '@cindy/device-link';
import type { NodeRequestScopes } from './nodeRequestScope.js';

/** Bootstrap-private transport. The captured scope survives stream callback context loss. */
export class NodeDeviceAuthorizationClient {
  private nextId = 1;
  private readonly pending = new Map<
    string,
    {
      rpcId: string;
      resolve(): void;
      reject(error: Error): void;
      timer: NodeJS.Timeout;
    }
  >();
  constructor(
    private readonly scopes: NodeRequestScopes,
    private readonly send: (message: unknown) => void,
  ) {}

  bind(): ((url: string) => Promise<void>) | undefined {
    const bound = this.scopes.capture();
    if (!bound) return undefined;
    let used = false;
    return async (rawUrl) => {
      bound.assertCurrent();
      if (used) throw new Error('DEVICE_AUTHORIZATION_UNAVAILABLE');
      used = true;
      const url = parseDeviceAuthorizationUrl(rawUrl);
      const reqId = `a${this.nextId++}`;
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(reqId);
          reject(new Error('DEVICE_AUTHORIZATION_UNAVAILABLE'));
        }, PLUGIN_OAUTH_TTL_MS);
        timer.unref?.();
        this.pending.set(reqId, { rpcId: bound.rpcId, resolve, reject, timer });
        try {
          this.send({ type: 'device-authorize', reqId, rpcId: bound.rpcId, url });
        } catch {
          this.settle(reqId, false);
        }
      });
    };
  }
  private settle(reqId: string, ok: boolean): void {
    const pending = this.pending.get(reqId);
    if (!pending) return;
    this.pending.delete(reqId);
    clearTimeout(pending.timer);
    if (ok) pending.resolve();
    else pending.reject(new Error('DEVICE_AUTHORIZATION_UNAVAILABLE'));
  }
  reply(value: Record<string, unknown>): void {
    if (typeof value.reqId === 'string') this.settle(value.reqId, value.ok === true);
  }
  finish(rpcId: string): void {
    for (const [id, pending] of this.pending) if (pending.rpcId === rpcId) this.settle(id, false);
  }
}
