import { describe, expect, it, vi } from 'vitest';

import { createOrcaRuntimeRelease, type OrcaRuntimeReleaseDeps } from '../orcaRuntimeRelease';

function createHarness(overrides: Partial<OrcaRuntimeReleaseDeps> = {}) {
  const calls: string[] = [];
  const session = {
    isTurnRunning: vi.fn(() => true),
    abort: vi.fn(async () => {
      calls.push('abort');
    }),
  };
  let now = 100;
  const deps: OrcaRuntimeReleaseDeps = {
    getSession: vi.fn(() => session),
    markRelease: vi.fn(async () => {
      calls.push('markRelease');
      return true;
    }),
    restoreRelease: vi.fn(async () => {
      calls.push('restoreRelease');
      return true;
    }),
    closeSession: vi.fn(async () => {
      calls.push('closeSession');
    }),
    now: vi.fn(() => now++),
    log: {
      warn: vi.fn(),
    },
    ...overrides,
  };
  return {
    calls,
    deps,
    release: createOrcaRuntimeRelease(deps),
    session,
  };
}

const worker = {
  id: 'worker-1',
  sessionId: 'session-1',
  status: 'running' as const,
  idleSince: null,
};

describe('createOrcaRuntimeRelease', () => {
  it('persists the recovery marker before aborting and closing the provider runtime', async () => {
    const { calls, deps, release } = createHarness();

    await release(worker);

    expect(calls).toEqual(['markRelease', 'abort', 'closeSession']);
    expect(deps.markRelease).toHaveBeenCalledWith('worker-1', 'session-1', 100);
  });

  it('does not touch the provider runtime when marker persistence loses its CAS', async () => {
    const { deps, release, session } = createHarness({
      markRelease: vi.fn(async () => false),
    });

    await expect(release(worker)).rejects.toThrow('worker worker-1 changed before runtime release');

    expect(session.abort).not.toHaveBeenCalled();
    expect(deps.closeSession).not.toHaveBeenCalled();
  });

  it('rolls back the exact marker when provider close fails', async () => {
    const closeError = new Error('archive failed');
    const { deps, release } = createHarness({
      closeSession: vi.fn(async () => {
        throw closeError;
      }),
    });

    await expect(release(worker)).rejects.toBe(closeError);

    expect(deps.restoreRelease).toHaveBeenCalledWith(
      'worker-1',
      'session-1',
      100,
      'running',
      101,
    );
  });

  it('keeps the original close error when marker rollback also fails', async () => {
    const closeError = new Error('archive failed');
    const { deps, release } = createHarness({
      closeSession: vi.fn(async () => {
        throw closeError;
      }),
      restoreRelease: vi.fn(async () => {
        throw new Error('store unavailable');
      }),
    });

    await expect(release(worker)).rejects.toBe(closeError);

    expect(deps.log.warn).toHaveBeenCalledWith(
      'releaseWorkerRuntime: failed to roll back release marker',
      {
        workerId: 'worker-1',
        sessionId: 'session-1',
        err: 'store unavailable',
      },
    );
  });

  it('reuses an existing marker without rolling it back on a retry failure', async () => {
    const closeError = new Error('archive failed');
    const { deps, release } = createHarness({
      closeSession: vi.fn(async () => {
        throw closeError;
      }),
    });

    await expect(release({ ...worker, idleSince: '100' })).rejects.toBe(closeError);

    expect(deps.markRelease).not.toHaveBeenCalled();
    expect(deps.restoreRelease).not.toHaveBeenCalled();
  });

  it('leaves a newly persisted marker recoverable when the local Session is already missing', async () => {
    const { deps, release } = createHarness({
      getSession: vi.fn(() => null),
    });

    await release(worker);

    expect(deps.markRelease).toHaveBeenCalledOnce();
    expect(deps.closeSession).not.toHaveBeenCalled();
  });
});
