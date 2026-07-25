import { describe, expect, it, vi } from 'vitest';

import { createOrcaRuntimeRelease, type OrcaRuntimeReleaseDeps } from '../orcaRuntimeRelease';

function createHarness(overrides: Partial<OrcaRuntimeReleaseDeps> = {}) {
  const calls: string[] = [];
  const session = {
    isTurnRunning: vi.fn(() => true),
    abort: vi.fn(async () => {
      calls.push('abort');
    }),
    close: vi.fn(async () => {
      calls.push('closeSession');
    }),
  };
  let now = 100;
  const deps: OrcaRuntimeReleaseDeps = {
    getSession: vi.fn(() => session),
    resumeSession: vi.fn(async () => {
      calls.push('resumeSession');
    }),
    markRelease: vi.fn(async () => {
      calls.push('markRelease');
      return true;
    }),
    restoreRelease: vi.fn(async () => {
      calls.push('restoreRelease');
      return true;
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
  teamId: 'team-1',
  leadSessionId: 'lead-1',
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
    expect(session.close).not.toHaveBeenCalled();
  });

  it('rolls back the exact marker when provider close fails', async () => {
    const closeError = new Error('archive failed');
    const { deps, release } = createHarness({
      getSession: vi.fn(() => ({
        isTurnRunning: () => false,
        abort: vi.fn(),
        close: vi.fn(async () => {
          throw closeError;
        }),
      })),
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
      getSession: vi.fn(() => ({
        isTurnRunning: () => false,
        abort: vi.fn(),
        close: vi.fn(async () => {
          throw closeError;
        }),
      })),
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
      getSession: vi.fn(() => ({
        isTurnRunning: () => false,
        abort: vi.fn(),
        close: vi.fn(async () => {
          throw closeError;
        }),
      })),
    });

    await expect(release({ ...worker, idleSince: '100' })).rejects.toBe(closeError);

    expect(deps.markRelease).not.toHaveBeenCalled();
    expect(deps.restoreRelease).not.toHaveBeenCalled();
  });

  it('recreates missing local ownership before releasing an unmarked runtime', async () => {
    const harness = createHarness();
    let currentSession: typeof harness.session | null = null;
    harness.deps.getSession = vi.fn(() => currentSession);
    harness.deps.resumeSession = vi.fn(async () => {
      harness.calls.push('resumeSession');
      currentSession = harness.session;
    });

    await harness.release(worker);

    expect(harness.calls).toEqual(['resumeSession', 'markRelease', 'abort', 'closeSession']);
    expect(harness.deps.markRelease).toHaveBeenCalledOnce();
    expect(harness.session.close).toHaveBeenCalledWith({ releaseRuntime: true });
  });

  it('recreates missing local ownership and refreshes an existing release marker', async () => {
    const harness = createHarness();
    let currentSession: typeof harness.session | null = null;
    harness.deps.getSession = vi.fn(() => currentSession);
    harness.deps.resumeSession = vi.fn(async () => {
      harness.calls.push('resumeSession');
      currentSession = harness.session;
    });

    await harness.release({ ...worker, idleSince: '90' });

    expect(harness.calls).toEqual(['resumeSession', 'markRelease', 'abort', 'closeSession']);
    expect(harness.deps.markRelease).toHaveBeenCalledWith('worker-1', 'session-1', 100);
    expect(harness.session.close).toHaveBeenCalledWith({ releaseRuntime: true });
  });

  it('fails without persisting a marker when a missing Session cannot be recreated', async () => {
    const { deps, release } = createHarness({
      getSession: vi.fn(() => null),
    });

    await expect(release(worker)).rejects.toThrow(
      'worker worker-1 session could not be resumed for runtime release',
    );

    expect(deps.resumeSession).toHaveBeenCalledOnce();
    expect(deps.markRelease).not.toHaveBeenCalled();
  });
});
