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
    sessionId: 'worker-session-1',
    leadSessionId: 'lead-1',
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
    touchWorker: vi.fn(async () => undefined),
    closeSessionIfIdle: vi.fn(async () => true),
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

      expect(deps.listCandidates).toHaveBeenCalledWith(60_000);
      expect(deps.closeSessionIfIdle).toHaveBeenCalledWith(candidate.sessionId);
      expect(deps.markReleased).toHaveBeenCalledWith(candidate, 120_000);
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

  it('skips workers that already have a release marker', async () => {
    const { deps, watcher } = createDeps({
      listCandidates: vi.fn(async () => [createCandidate({ idleSince: 90_000 })]),
    });

    await watcher.scanNow();

    expect(deps.markReleased).not.toHaveBeenCalled();
    expect(deps.closeSessionIfIdle).not.toHaveBeenCalled();
    expect(deps.broadcastWorkerChanged).not.toHaveBeenCalled();
  });

  it('does not broadcast when worker state changes before the release marker is written', async () => {
    const { deps, watcher } = createDeps({
      markReleased: vi.fn(async () => false),
    });

    await watcher.scanNow();

    expect(deps.closeSessionIfIdle).toHaveBeenCalledOnce();
    expect(deps.broadcastWorkerChanged).not.toHaveBeenCalled();
  });

  it('leaves the worker unmarked and retryable when closing the runtime fails', async () => {
    const { deps, watcher } = createDeps({
      closeSessionIfIdle: vi.fn(async () => {
        throw new Error('close failed');
      }),
    });

    await watcher.scanNow();

    expect(deps.markReleased).not.toHaveBeenCalled();
    expect(deps.broadcastWorkerChanged).not.toHaveBeenCalled();
    expect(deps.log.warn).toHaveBeenCalledWith(
      'idleWatcher: release worker failed',
      expect.objectContaining({ workerId: 'worker-1', err: 'close failed' }),
    );
  });

  it('delays a worker when closeIfIdle loses a send race', async () => {
    const { deps, watcher } = createDeps({
      closeSessionIfIdle: vi.fn(async () => false),
    });

    await watcher.scanNow();

    expect(deps.touchWorker).toHaveBeenCalledWith('worker-1', 120_000);
    expect(deps.markReleased).not.toHaveBeenCalled();
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
