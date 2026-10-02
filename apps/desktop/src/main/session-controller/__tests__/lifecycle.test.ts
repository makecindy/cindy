import { expect, it, vi } from 'vitest';
import { createSessionLifecycle } from '../lifecycle.js';
import { withSessionOperation } from '../operationContext.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
function fixture() {
  const runtime = { instanceId: 'instance', getTurnGeneration: () => 3, abort: vi.fn(async () => {}) };
  let current: typeof runtime | null = runtime;
  const deps = {
    current: () => current, stable: () => current,
    markManualInterrupt: vi.fn(), cancelRecovery: vi.fn(), pauseGoal: vi.fn(async () => {}),
    markStopped: vi.fn(), beginAbort: vi.fn(() => Symbol()), reconcileAbort: vi.fn(),
    cleanupInteractions: vi.fn(), reportSecondaryError: vi.fn(),
    withLock: async <T>(_id: string, run: () => Promise<T>) => run(),
    close: vi.fn(async () => { current = null; }),
    withPreservedWorkspace: vi.fn(async <T>(_id: string, run: () => Promise<T>) => run()) as <T>(id: string, run: () => Promise<T>) => Promise<T>,
  };
  return { deps, runtime, setCurrent: (value: typeof current) => { current = value; },
    request: { sessionId: 'task', expectedExecution: { instanceId: 'instance', generation: 3 } },
    service: createSessionLifecycle(deps) };
}

it('revokes recovery synchronously and aborts while Goal persistence is pending', async () => {
  const f = fixture(); const goal = deferred<void>();
  f.deps.pauseGoal.mockImplementation(() => goal.promise);
  const pending = f.service.abortSession(f.request);
  expect(f.deps.cancelRecovery).toHaveBeenCalledWith('task');
  expect(f.runtime.abort).toHaveBeenCalledOnce();
  goal.resolve(); await pending;
  expect(f.deps.reconcileAbort).toHaveBeenCalledOnce();
  expect(f.deps.cleanupInteractions).toHaveBeenCalledWith('task', 'session_aborted');
});

it('never cancels a replacement instance even when generation is equal', async () => {
  const f = fixture(); f.setCurrent({ ...f.runtime, instanceId: 'replacement' });
  await expect(f.service.abortSession(f.request)).rejects.toMatchObject({ code: 'CONFLICT' });
  expect(f.runtime.abort).not.toHaveBeenCalled();
  expect(f.deps.cancelRecovery).not.toHaveBeenCalled();
});

it('does not clean the replacement interactions after an old abort settles', async () => {
  const f = fixture(); const abort = deferred<void>(); f.runtime.abort.mockImplementation(() => abort.promise);
  const pending = f.service.abortSession(f.request);
  f.setCurrent({ ...f.runtime, instanceId: 'replacement' }); abort.resolve(); await pending;
  expect(f.deps.reconcileAbort).toHaveBeenCalledOnce();
  expect(f.deps.cleanupInteractions).not.toHaveBeenCalled();
});

it('preserves both errors when abort and Goal persistence fail', async () => {
  const f = fixture(); const abort = new Error('abort failed'); const goal = new Error('storage failed');
  f.runtime.abort.mockRejectedValue(abort); f.deps.pauseGoal.mockRejectedValue(goal);
  await expect(f.service.abortSession(f.request)).rejects.toBe(abort);
  expect(f.deps.reportSecondaryError).toHaveBeenCalledWith('task', goal);
  expect(f.deps.reconcileAbort).toHaveBeenCalledOnce();
});

it('preserves the workspace through the existing close suppression', async () => {
  const f = fixture(); await f.service.closeSession({ ...f.request, preserveWorkspace: true });
  expect(f.deps.withPreservedWorkspace).toHaveBeenCalledOnce();
  expect(f.deps.close).toHaveBeenCalledWith('task');
});

it('rechecks revocation after waiting for the close lock', async () => {
  const f = fixture(); const lock = deferred<void>(); let revoked = false;
  f.deps.withLock = async (_id, run) => { await lock.promise; return run(); };
  const service = createSessionLifecycle(f.deps);
  const pending = withSessionOperation({ assertCurrent: () => {}, allows: async () => true,
    authorize: async () => { if (revoked) throw new Error('revoked'); } }, () => service.closeSession(f.request));
  revoked = true; lock.resolve();
  await expect(pending).rejects.toThrow('revoked');
  expect(f.deps.close).not.toHaveBeenCalled();
});
