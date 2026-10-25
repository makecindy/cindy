import { AsyncLocalStorage } from 'node:async_hooks';

interface RequestScope {
  rpcId: string;
  active: boolean;
}

/** Keeps async child spawns attached to the exact call-bound stdin request. */
export class NodeRequestScopes {
  private readonly current = new AsyncLocalStorage<RequestScope>();
  private readonly scopes = new Map<string, RequestScope>();

  feed(chunk: string, deliver: (chunk: string) => void): void {
    let value: { id?: unknown; cindy?: { cancelWithCall?: unknown } } | undefined;
    try {
      value = JSON.parse(chunk);
    } catch {
      /* Existing stdio validation owns malformed input. */
    }
    if (
      value?.cindy?.cancelWithCall !== true ||
      typeof value.id !== 'string' ||
      !/^\d{1,16}$/.test(value.id)
    ) {
      this.current.exit(() => deliver(chunk));
      return;
    }
    const scope = { rpcId: value.id, active: true };
    this.scopes.set(scope.rpcId, scope);
    this.current.run(scope, () => deliver(chunk));
  }

  finish(rpcId: string): void {
    const scope = this.scopes.get(rpcId);
    if (scope) scope.active = false;
    this.scopes.delete(rpcId);
  }

  capture(): { rpcId: string; assertCurrent(): void } | undefined {
    const scope = this.current.getStore();
    if (!scope) return undefined;
    const assertCurrent = () => {
      if (!scope.active || this.scopes.get(scope.rpcId) !== scope)
        throw new Error('The originating Node request has ended');
    };
    assertCurrent();
    return { rpcId: scope.rpcId, assertCurrent };
  }

  currentRpcId(): string | undefined {
    const scope = this.current.getStore();
    if (scope && !scope.active) throw new Error('The originating Node request has ended');
    return scope?.rpcId;
  }
}
