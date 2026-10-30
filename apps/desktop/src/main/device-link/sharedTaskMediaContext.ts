import { AsyncLocalStorage } from 'node:async_hooks';

const scope = new AsyncLocalStorage<string>();
/** Scope uploads for one trusted outbound call; never a global mutable flag. */
export function withSharedTaskMedia<T>(sharedTaskId: string | undefined, work: () => T): T {
  return sharedTaskId ? scope.run(sharedTaskId, work) : work();
}
export function sharedTaskMediaId(): string | undefined { return scope.getStore(); }
