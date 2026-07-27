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
      return 100;
    }),
    retireSession: vi.fn(async () => {
      calls.push('retireSession');
    }),
    markRelease: vi.fn(async () => {
      calls.push('markRelease');
      return true;
    }),
    acknowledgeRelease: vi.fn(async () => {
      calls.push('acknowledgeRelease');
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
  updatedAt: '1970-01-01T00:00:00.000Z',
  session: {
    agentKind: 'codex' as const,
  },
};

describe('createOrcaRuntimeRelease', () => {
  it('persists the recovery marker before aborting and closing the provider runtime', async () => {
    const { calls, deps, release } = createHarness();

    await release(worker);

    expect(calls).toEqual(['markRelease', 'abort', 'closeSession', 'acknowledgeRelease']);
    expect(deps.markRelease).toHaveBeenCalledWith('worker-1', 'session-1', 100, 0);
    expect(deps.acknowledgeRelease).toHaveBeenCalledWith('worker-1', 'session-1', 101);
  });

  it('does not touch the provider runtime when marker persistence loses its CAS', async () => {
    const { deps, release, session } = createHarness({
      markRelease: vi.fn(async () => false),
    });

    await expect(release(worker)).rejects.toThrow('worker worker-1 changed before runtime release');

    expect(session.abort).not.toHaveBeenCalled();
    expect(session.close).not.toHaveBeenCalled();
  });

  it('retains the release intent when provider close reports an ambiguous failure', async () => {
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

    expect(deps.markRelease).toHaveBeenCalledOnce();
    expect(deps.acknowledgeRelease).not.toHaveBeenCalled();
  });

  it('keeps a fresh marker when a failed close also removes Session ownership', async () => {
    const closeError = new Error('archive acknowledgement timed out');
    const harness = createHarness();
    let currentSession: typeof harness.session | null = harness.session;
    harness.deps.getSession = vi.fn(() => currentSession);
    harness.session.isTurnRunning.mockReturnValue(false);
    harness.session.close.mockImplementationOnce(async () => {
      currentSession = null;
      throw closeError;
    });

    await expect(harness.release(worker)).rejects.toBe(closeError);

    expect(harness.deps.markRelease).toHaveBeenCalledOnce();
    expect(harness.deps.acknowledgeRelease).not.toHaveBeenCalled();
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
    expect(deps.acknowledgeRelease).not.toHaveBeenCalled();
  });

  it('recreates missing local ownership before releasing an unmarked runtime', async () => {
    const harness = createHarness();
    let currentSession: typeof harness.session | null = null;
    harness.deps.getSession = vi.fn(() => currentSession);
    harness.deps.resumeSession = vi.fn(async () => {
      harness.calls.push('resumeSession');
      currentSession = harness.session;
      return 100;
    });

    await harness.release(worker);

    expect(harness.calls).toEqual([
      'resumeSession',
      'markRelease',
      'abort',
      'closeSession',
      'acknowledgeRelease',
    ]);
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
      return 100;
    });

    await harness.release({
      ...worker,
      idleSince: 'legacy-marker',
      updatedAt: 'legacy-marker',
    });

    expect(harness.calls).toEqual([
      'resumeSession',
      'markRelease',
      'abort',
      'closeSession',
      'acknowledgeRelease',
    ]);
    expect(harness.deps.markRelease).toHaveBeenCalledWith('worker-1', 'session-1', 101, 100);
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

  it('does not archive when another instance claims the restored runtime first', async () => {
    const harness = createHarness({
      markRelease: vi.fn(async () => false),
    });
    let currentSession: typeof harness.session | null = null;
    harness.deps.getSession = vi.fn(() => currentSession);
    harness.deps.resumeSession = vi.fn(async () => {
      currentSession = harness.session;
      return 100;
    });

    await expect(harness.release(worker)).rejects.toThrow(
      'worker worker-1 changed before runtime release',
    );

    expect(harness.session.close).not.toHaveBeenCalled();
    expect(harness.deps.retireSession).toHaveBeenCalledWith('session-1');
  });

  it('treats a missing Claude Session as an already released process runtime', async () => {
    const { deps, release } = createHarness({
      getSession: vi.fn(() => null),
    });

    await expect(release({
      ...worker,
      session: { agentKind: 'claude-code' },
    })).resolves.toBeUndefined();

    expect(deps.resumeSession).not.toHaveBeenCalled();
    expect(deps.markRelease).not.toHaveBeenCalled();
  });

  it('fails closed when provider teardown succeeds but release acknowledgement loses its CAS', async () => {
    const { deps, release } = createHarness({
      acknowledgeRelease: vi.fn(async () => false),
    });

    await expect(release(worker)).rejects.toThrow(
      'worker worker-1 release acknowledgement changed before persistence',
    );

    expect(deps.markRelease).toHaveBeenCalledOnce();
  });

  it('acknowledges an interrupted release when a Claude Session is already missing', async () => {
    const { deps, release } = createHarness({
      getSession: vi.fn(() => null),
    });

    await expect(release({
      ...worker,
      idleSince: '1969-12-31T23:59:00.000Z',
      updatedAt: '1969-12-31T23:59:00.000Z',
      session: { agentKind: 'claude-code' },
    })).resolves.toBeUndefined();

    expect(deps.resumeSession).not.toHaveBeenCalled();
    expect(deps.acknowledgeRelease).toHaveBeenCalledWith('worker-1', 'session-1', 101);
  });

  it('does not rewrite an already acknowledged release marker', async () => {
    const { deps, release } = createHarness();

    await release({
      ...worker,
      idleSince: '1970-01-01T00:00:00.090Z',
      updatedAt: '1970-01-01T00:00:00.091Z',
    });

    expect(deps.markRelease).not.toHaveBeenCalled();
    expect(deps.acknowledgeRelease).not.toHaveBeenCalled();
  });

  it('does not consume a fresh release intent owned by another instance', async () => {
    const { deps, release, session } = createHarness();

    await expect(release({
      ...worker,
      idleSince: '1970-01-01T00:00:00.100Z',
      updatedAt: '1970-01-01T00:00:00.100Z',
    })).rejects.toThrow('worker worker-1 runtime release is already in progress');

    expect(session.close).not.toHaveBeenCalled();
    expect(deps.acknowledgeRelease).not.toHaveBeenCalled();
  });
});
