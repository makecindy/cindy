import { AsyncLocalStorage, AsyncResource, createHook, executionAsyncId } from 'node:async_hooks';

type Scope = { active: boolean; queued: boolean; asyncId: number; values: WeakMap<object, Map<string, unknown>> };
const scopes = new AsyncLocalStorage<Scope>();
// Node 24's AsyncContextFrame-backed ALS does not itself assign Promise IDs.
// Track them only while calls are in flight; no hook runs for unused plugins.
const tracking = createHook({ before() {} });
let activeCalls = 0;

/** Request-local IO deduplication only. No state survives an await boundary. */
export async function withPluginApprovalReads<T>(operation: () => Promise<T>): Promise<T> {
  if (activeCalls++ === 0) tracking.enable();
  const resource = new AsyncResource('CindyPluginApprovalReads');
  const scope: Scope = { active: true, queued: false, asyncId: resource.asyncId(), values: new WeakMap() };
  try { return await resource.runInAsyncScope(() => scopes.run(scope, operation)); }
  finally {
    scope.active = false;
    scope.values = new WeakMap();
    resource.emitDestroy();
    if (--activeCalls === 0) { tracking.disable(); scopes.disable(); }
  }
}

export function readPluginApprovalOnce<T>(store: object, path: string, read: () => T): T {
  const scope = scopes.getStore();
  if (!scope?.active) return read();
  const asyncId = executionAsyncId();
  if (asyncId === 0) return read(); // Fail closed if a runtime cannot identify this segment.
  // An earlier queued callback can run before our cleanup microtask. It is a
  // new synchronous segment regardless of that microtask's position.
  if (scope.asyncId !== asyncId) { scope.asyncId = asyncId; scope.values = new WeakMap(); }
  let values = scope.values.get(store);
  if (!values) { values = new Map(); scope.values.set(store, values); }
  if (values.has(path)) return values.get(path) as T;
  const result = read();
  values.set(path, result);
  if (!scope.queued) {
    scope.queued = true;
    queueMicrotask(() => { scope.values = new WeakMap(); scope.queued = false; });
  }
  return result;
}
