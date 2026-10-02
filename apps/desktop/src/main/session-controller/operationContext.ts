import { AsyncLocalStorage } from 'node:async_hooks';
import type { SessionOperationScope } from './controller.js';
import { SessionAdmissionError } from './controller.js';

// Carries admission across existing domain locks without changing their ordering.
// Never serialize this scope or keep it with a queued input for a later turn.
const operations = new AsyncLocalStorage<{ scope: SessionOperationScope; active: boolean }>();

function currentScope(): SessionOperationScope | undefined {
  const operation = operations.getStore();
  return operation?.active ? operation.scope : undefined;
}

/** A composed business port inherits the original request's authority, including
 * its lifetime. An internal adapter must never replace a plugin/turn policy. */
export function captureSessionOperation(): SessionOperationScope | undefined {
  const entry = operations.getStore();
  if (!entry?.active) return undefined;
  const assertActive = () => {
    if (!entry.active) throw new SessionAdmissionError('NOT_AUTHORIZED', 'Session request has ended');
    entry.scope.assertCurrent();
  };
  return {
    assertCurrent: assertActive,
    authorize: async () => { assertActive(); await entry.scope.authorize(); assertActive(); },
    allows: async (...args) => { assertActive(); const allowed = await entry.scope.allows(...args); assertActive(); return allowed; },
  };
}

export function requireSessionOperation(): SessionOperationScope {
  const scope = currentScope();
  if (!scope) throw new SessionAdmissionError('NOT_AUTHORIZED', 'Session operation admission is required');
  return scope;
}

export async function withSessionOperation<T>(scope: SessionOperationScope, run: () => T | Promise<T>): Promise<T> {
  const operation = { scope, active: true };
  return operations.run(operation, async () => {
    try { return await run(); }
    finally {
      // Runtime listeners/timers created during a request can outlive it. Their
      // own lifecycle policies apply; they must not retain this caller's lease.
      operation.active = false;
    }
  });
}

/** Existing business ports use this immediately before their irreversible boundary. */
export async function revalidateSessionOperation(): Promise<void> {
  await currentScope()?.authorize();
}

/** For synchronous commits following asynchronous authorization. */
export function assertSessionOperationCurrent(): void {
  currentScope()?.assertCurrent();
}
