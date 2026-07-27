import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createOrcaIdleReleaseWatcher,
  ORCA_IDLE_RELEASE_STATUSES,
  type OrcaIdleReleaseCandidate,
  type OrcaIdleReleaseWatcherDeps,
} from '../orcaIdleReleaseWatcher';

function createCandidate(
  overrides: Partial<OrcaIdleReleaseCandidate> = {},
): OrcaIdleReleaseCandidate {
  return {
    id: 'worker-1',
    teamId: 'team-1',
    sessionId: 'worker-session-1',
    leadSessionId: 'lead-1',
    agentKind: 'codex',
    status: 'done',
    idleSince: null,
    updatedAt: 1,
    ...overrides,
  };
}

function createDeps(overrides: Partial<OrcaIdleReleaseWatcherDeps> = {}) {
  const session = {
    isTurnRunning: vi.fn(() => false),
  };
  const deps: OrcaIdleReleaseWatcherDeps = {
    readIdleReleaseMinutes: vi.fn(() => 1),
    listCandidates: vi.fn(async () => [createCandidate()]),
    getSession: vi.fn(() => session),
    withSessionLock: vi.fn(async (_sessionId, task) => task()),
    hasPendingInput: vi.fn(async () => false),
    markReleased: vi.fn(async () => true),
    restoreRelease: vi.fn(async () => true),
    acknowledgeRelease: vi.fn(async () => true),
    touchWorker: vi.fn(async () => undefined),
    closeSessionIfIdle: vi.fn(async () => 'closed' as const),
    broadcastWorkerChanged: vi.fn(),
    now: vi.fn(() => 120_000),
    timer: { setInterval, clearInterval },
    log: {
      info: vi.fn(),
      warn: vi.fn(),
    },
    ...overrides,
  };
  return { deps, session, watcher: createOrcaIdleReleaseWatcher(deps, 25) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createOrcaIdleReleaseWatcher', () => {
  it('does not scan when idle release is disabled', async () => {
    const { deps, watcher } = createDeps({
      readIdleReleaseMinutes: vi.fn(() => 0),
    });

    await watcher.scanNow();

    expect(deps.listCandidates).not.toHaveBeenCalled();
    expect(deps.markReleased).not.toHaveBeenCalled();
  });

  it.each(ORCA_IDLE_RELEASE_STATUSES)(
    'releases an inactive %s worker and broadcasts once',
    async (status) => {
      const candidate = createCandidate({ status });
      const { deps, watcher } = createDeps({
        listCandidates: vi.fn(async () => [candidate]),
      });

      await watcher.scanNow();

      expect(deps.listCandidates).toHaveBeenCalledWith(60_000, 90_000);
      expect(deps.closeSessionIfIdle).toHaveBeenCalledWith(candidate, 120_000);
      expect(deps.markReleased).toHaveBeenCalledWith(candidate, 120_000);
      expect(vi.mocked(deps.markReleased).mock.invocationCallOrder[0]!)
        .toBeLessThan(vi.mocked(deps.closeSessionIfIdle).mock.invocationCallOrder[0]!);
      expect(deps.restoreRelease).not.toHaveBeenCalled();
      expect(deps.acknowledgeRelease).toHaveBeenCalledWith(candidate, 120_000);
      expect(deps.broadcastWorkerChanged).toHaveBeenCalledOnce();
      expect(deps.broadcastWorkerChanged).toHaveBeenCalledWith(candidate.leadSessionId);
      expect(deps.log.info).toHaveBeenCalledWith(
        'idleWatcher: released worker',
        expect.objectContaining({ workerId: candidate.id }),
      );
    },
  );

  it('delays a worker with a live turn instead of releasing it', async () => {
    const { deps, session, watcher } = createDeps();
    session.isTurnRunning.mockReturnValue(true);

    await watcher.scanNow();

    expect(deps.touchWorker).toHaveBeenCalledWith('worker-1', 120_000);
    expect(deps.markReleased).not.toHaveBeenCalled();
    expect(deps.closeSessionIfIdle).not.toHaveBeenCalled();
    expect(deps.broadcastWorkerChanged).not.toHaveBeenCalled();
  });

  it('leaves a worker untouched when this process does not own its runtime', async () => {
    const { deps, watcher } = createDeps({
      getSession: vi.fn(() => null),
    });

    await watcher.scanNow();

    expect(deps.withSessionLock).toHaveBeenCalledWith('worker-session-1', expect.any(Function));
    expect(deps.closeSessionIfIdle).not.toHaveBeenCalled();
    expect(deps.markReleased).not.toHaveBeenCalled();
    expect(deps.broadcastWorkerChanged).not.toHaveBeenCalled();
  });

  it('reconciles an expired release intent after local Session ownership is lost', async () => {
    const candidate = createCandidate({ idleSince: 80_000, updatedAt: 80_000 });
    const { deps, watcher } = createDeps({
      listCandidates: vi.fn(async () => [candidate]),
      getSession: vi.fn(() => null),
      closeSessionIfIdle: vi.fn(async () => 'closed-and-acknowledged' as const),
    });

    await watcher.scanNow();

    expect(deps.closeSessionIfIdle).toHaveBeenCalledWith(candidate, 80_000);
    expect(deps.markReleased).not.toHaveBeenCalled();
    expect(deps.acknowledgeRelease).not.toHaveBeenCalled();
    expect(deps.broadcastWorkerChanged).toHaveBeenCalledWith('lead-1');
  });

  it('delays a terminal worker with queued follow-up input', async () => {
    const candidate = createCandidate({ status: 'done' });
    const { deps, watcher } = createDeps({
      listCandidates: vi.fn(async () => [candidate]),
      hasPendingInput: vi.fn(async () => true),
    });

    await watcher.scanNow();

    expect(deps.touchWorker).toHaveBeenCalledWith(candidate.id, 120_000);
    expect(deps.closeSessionIfIdle).not.toHaveBeenCalled();
    expect(deps.markReleased).not.toHaveBeenCalled();
    expect(deps.broadcastWorkerChanged).not.toHaveBeenCalled();
  });

  it('rechecks the live turn after waiting for the session lock', async () => {
    const { deps, session, watcher } = createDeps();
    deps.withSessionLock = vi.fn(async (_sessionId, task) => {
      session.isTurnRunning.mockReturnValue(true);
      return task();
    });

    await watcher.scanNow();

    expect(deps.touchWorker).toHaveBeenCalledWith('worker-1', 120_000);
    expect(deps.closeSessionIfIdle).not.toHaveBeenCalled();
    expect(deps.markReleased).not.toHaveBeenCalled();
  });

  it('retries interrupted release intents without writing another marker', async () => {
    const candidate = createCandidate({ idleSince: 90_000, updatedAt: 90_000 });
    const { deps, watcher } = createDeps({
      listCandidates: vi.fn(async () => [candidate]),
    });

    await watcher.scanNow();

    expect(deps.markReleased).not.toHaveBeenCalled();
    expect(deps.closeSessionIfIdle).toHaveBeenCalledWith(candidate, 90_000);
    expect(deps.broadcastWorkerChanged).toHaveBeenCalledOnce();
  });

  it('does not consume a fresh release intent owned by another instance', async () => {
    const candidate = createCandidate({ idleSince: 110_000, updatedAt: 110_000 });
    const { deps, watcher } = createDeps({
      listCandidates: vi.fn(async () => [candidate]),
    });

    await watcher.scanNow();

    expect(deps.closeSessionIfIdle).not.toHaveBeenCalled();
    expect(deps.acknowledgeRelease).not.toHaveBeenCalled();
  });

  it('does not acknowledge twice when missing-ownership reconciliation already persisted completion', async () => {
    const { deps, watcher } = createDeps({
      closeSessionIfIdle: vi.fn(async () => 'closed-and-acknowledged' as const),
    });

    await watcher.scanNow();

    expect(deps.acknowledgeRelease).not.toHaveBeenCalled();
    expect(deps.broadcastWorkerChanged).toHaveBeenCalledOnce();
  });

  it('does not release an already acknowledged runtime again', async () => {
    const candidate = createCandidate({ idleSince: 90_000, updatedAt: 90_001 });
    const { deps, watcher } = createDeps({
      listCandidates: vi.fn(async () => [candidate]),
    });

    await watcher.scanNow();

    expect(deps.closeSessionIfIdle).not.toHaveBeenCalled();
    expect(deps.acknowledgeRelease).not.toHaveBeenCalled();
  });

  it('does not broadcast when worker state changes before the release marker is written', async () => {
    const { deps, watcher } = createDeps({
      markReleased: vi.fn(async () => false),
    });

    await watcher.scanNow();

    expect(deps.closeSessionIfIdle).not.toHaveBeenCalled();
    expect(deps.broadcastWorkerChanged).not.toHaveBeenCalled();
  });

  it('does not close the runtime when release marker persistence fails', async () => {
    const { deps, watcher } = createDeps({
      markReleased: vi.fn(async () => {
        throw new Error('marker write failed');
      }),
    });

    await watcher.scanNow();

    expect(deps.closeSessionIfIdle).not.toHaveBeenCalled();
    expect(deps.restoreRelease).not.toHaveBeenCalled();
    expect(deps.broadcastWorkerChanged).not.toHaveBeenCalled();
  });

  it('retains the persisted release intent when closing the runtime fails ambiguously', async () => {
    const { deps, watcher } = createDeps({
      closeSessionIfIdle: vi.fn(async () => {
        throw new Error('close failed');
      }),
    });

    await watcher.scanNow();

    expect(deps.markReleased).toHaveBeenCalledWith(expect.objectContaining({ id: 'worker-1' }), 120_000);
    expect(deps.restoreRelease).not.toHaveBeenCalled();
    expect(deps.broadcastWorkerChanged).not.toHaveBeenCalled();
    expect(deps.log.warn).toHaveBeenCalledWith(
      'idleWatcher: release worker failed',
      expect.objectContaining({ workerId: 'worker-1', err: 'close failed' }),
    );
  });

  it('delays a worker when closeIfIdle loses a send race', async () => {
    const { deps, watcher } = createDeps({
      closeSessionIfIdle: vi.fn(async () => 'busy' as const),
    });

    await watcher.scanNow();

    expect(deps.markReleased).toHaveBeenCalledWith(expect.objectContaining({ id: 'worker-1' }), 120_000);
    expect(deps.restoreRelease).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'worker-1' }),
      120_000,
      120_000,
    );
    expect(deps.touchWorker).not.toHaveBeenCalled();
    expect(deps.broadcastWorkerChanged).not.toHaveBeenCalled();
  });

  it('logs a failed release-marker rollback when closeIfIdle loses a send race', async () => {
    const { deps, watcher } = createDeps({
      closeSessionIfIdle: vi.fn(async () => 'busy' as const),
      restoreRelease: vi.fn(async () => {
        throw new Error('database temporarily unavailable');
      }),
    });

    await watcher.scanNow();

    expect(deps.log.warn).toHaveBeenCalledWith('idleWatcher: release marker rollback failed', {
      workerId: 'worker-1',
      reason: 'busy',
      restoreError: 'database temporarily unavailable',
    });
    expect(deps.broadcastWorkerChanged).not.toHaveBeenCalled();
  });

  it('fails closed when close succeeds but release acknowledgement loses its CAS', async () => {
    const { deps, watcher } = createDeps({
      acknowledgeRelease: vi.fn(async () => false),
    });

    await watcher.scanNow();

    expect(deps.restoreRelease).not.toHaveBeenCalled();
    expect(deps.broadcastWorkerChanged).not.toHaveBeenCalled();
    expect(deps.log.warn).toHaveBeenCalledWith(
      'idleWatcher: release worker failed',
      expect.objectContaining({
        workerId: 'worker-1',
        err: 'worker worker-1 release acknowledgement changed',
      }),
    );
  });

  it('retains the marker when a locally owned runtime disappears before reconciliation', async () => {
    const { deps, watcher } = createDeps({
      closeSessionIfIdle: vi.fn(async () => 'already-missing' as const),
    });

    await watcher.scanNow();

    expect(deps.touchWorker).not.toHaveBeenCalled();
    expect(deps.markReleased).toHaveBeenCalledWith(expect.objectContaining({ id: 'worker-1' }), 120_000);
    expect(deps.restoreRelease).not.toHaveBeenCalled();
    expect(deps.broadcastWorkerChanged).not.toHaveBeenCalled();
  });

  it('uses the injected interval and stops future scans', async () => {
    vi.useFakeTimers();
    const listCandidates = vi.fn(async () => []);
    const { watcher } = createDeps({ listCandidates });

    watcher.start();
    await vi.advanceTimersByTimeAsync(25);
    expect(listCandidates).toHaveBeenCalledOnce();

    watcher.stop();
    await vi.advanceTimersByTimeAsync(50);
    expect(listCandidates).toHaveBeenCalledOnce();
  });
});
