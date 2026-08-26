import { EventEmitter } from 'node:events';

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  utilityProcess: { fork: vi.fn() },
}));

vi.mock('../sqliteVecLoader', () => ({
  resolveSqliteVecExtPath: () => 'C:\\native\\vec0.dll',
}));

const {
  DbSlimmingCancelledError,
  DbSlimmingWorkerPreReplacementError,
  DbSlimmingWorkerStartupError,
  runDbSlimmingMaintenanceInWorker,
} = await import('../dbSlimmingWorkerClient');

class FakeUtilityProcess extends EventEmitter {
  readonly posted: unknown[] = [];
  kill = vi.fn(() => true);

  postMessage(message: unknown): void {
    this.posted.push(message);
  }
}

function createRequest() {
  return {
    version: 1 as const,
    id: 'request-1',
    ownerId: 'owner-1',
    createdAt: 1,
    scannedAt: 2,
    archivedBeforeMs: 3,
    archiveAgeMonths: '7-days' as const,
    deletedTaskCount: 4,
    archivedTaskCount: 5,
    messageCount: 6,
    estimatedMessageBytes: 4_096,
    beforeBytes: 8_192,
    backupEnabled: false,
    phase: 'scheduled' as const,
  };
}

describe('runDbSlimmingMaintenanceInWorker', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('starts the utility process, forwards progress and waits for the final commit handshake', async () => {
    const child = new FakeUtilityProcess();
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const onProgress = vi.fn();
    const request = createRequest();
    const outcome = {
      result: {
        id: request.id,
        ownerId: request.ownerId,
        status: 'failed' as const,
        finishedAt: 8,
        archiveAgeMonths: request.archiveAgeMonths,
        reason: 'cleanup-failed' as const,
        originalDatabaseRestored: true,
      },
      originalDatabaseReady: true,
    };

    const resultPromise = runDbSlimmingMaintenanceInWorker(
      {
        userDataDir: 'C:\\user-data',
        dbFilePath: 'C:\\user-data\\owner.db',
        request,
        loadVectorExtension: vi.fn(() => true),
        log,
        onProgress,
      },
      () => child,
    );

    child.emit('message', { type: 'ready' });
    expect(child.posted[0]).toEqual({
      type: 'start',
      input: {
        userDataDir: 'C:\\user-data',
        dbFilePath: 'C:\\user-data\\owner.db',
        request,
        sqliteVecExtensionPath: 'C:\\native\\vec0.dll',
      },
    });

    child.emit('message', {
      type: 'progress',
      progress: { phase: 'compacting', progress: 70, cancellable: true },
    });
    child.emit('message', { type: 'log', level: 'info', message: 'phase', meta: { step: 1 } });
    child.emit('message', {
      type: 'progress',
      progress: { phase: 'finalizing', progress: 96, cancellable: false },
    });
    child.emit('message', { type: 'commit-ready' });

    expect(onProgress).toHaveBeenLastCalledWith({
      phase: 'finalizing',
      progress: 96,
      cancellable: false,
    });
    expect(child.posted.at(-1)).toEqual({ type: 'commit' });

    child.emit('message', { type: 'result', outcome });
    await expect(resultPromise).resolves.toEqual(outcome);
    expect(log.info).toHaveBeenCalledExactlyOnceWith('phase', { step: 1 });
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('kills cancellable native work and resolves cancellation after the process exits', async () => {
    const child = new FakeUtilityProcess();
    const controller = new AbortController();
    const resultPromise = runDbSlimmingMaintenanceInWorker(
      {
        userDataDir: 'C:\\user-data',
        dbFilePath: 'C:\\user-data\\owner.db',
        request: createRequest(),
        signal: controller.signal,
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      },
      () => child,
    );

    child.emit('message', { type: 'ready' });
    child.emit('message', {
      type: 'progress',
      progress: { phase: 'cleaning', progress: 52, cancellable: true },
    });
    controller.abort();
    expect(child.kill).toHaveBeenCalledTimes(1);
    child.emit('exit', 0);

    await expect(resultPromise).rejects.toBeInstanceOf(DbSlimmingCancelledError);
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('ignores cancellation after the replacement safety boundary', async () => {
    const child = new FakeUtilityProcess();
    const controller = new AbortController();
    const resultPromise = runDbSlimmingMaintenanceInWorker(
      {
        userDataDir: 'C:\\user-data',
        dbFilePath: 'C:\\user-data\\owner.db',
        request: createRequest(),
        signal: controller.signal,
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      },
      () => child,
    );

    child.emit('message', { type: 'ready' });
    child.emit('message', {
      type: 'progress',
      progress: { phase: 'finalizing', progress: 96, cancellable: false },
    });
    child.emit('message', { type: 'commit-ready' });
    controller.abort();
    expect(child.kill).not.toHaveBeenCalled();

    const request = createRequest();
    const outcome = {
      result: {
        id: request.id,
        ownerId: request.ownerId,
        status: 'completed' as const,
        finishedAt: 8,
        archiveAgeMonths: request.archiveAgeMonths,
        deletedTaskCount: 4,
        archivedTaskCount: 5,
        messageCount: 6,
        beforeBytes: 8_192,
        afterBytes: 4_096,
        reclaimedBytes: 4_096,
        backupCreated: false,
      },
      originalDatabaseReady: true,
    };
    child.emit('message', { type: 'result', outcome });

    await expect(resultPromise).resolves.toEqual(outcome);
  });

  it('distinguishes a process startup failure before maintenance begins', async () => {
    const child = new FakeUtilityProcess();
    const resultPromise = runDbSlimmingMaintenanceInWorker(
      {
        userDataDir: 'C:\\user-data',
        dbFilePath: 'C:\\user-data\\owner.db',
        request: createRequest(),
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      },
      () => child,
    );

    child.emit('error', new Error('bundle missing'));

    await expect(resultPromise).rejects.toBeInstanceOf(DbSlimmingWorkerStartupError);
  });

  it('marks an unexpected exit as safely recoverable while only copies were touched', async () => {
    const child = new FakeUtilityProcess();
    const resultPromise = runDbSlimmingMaintenanceInWorker(
      {
        userDataDir: 'C:\\user-data',
        dbFilePath: 'C:\\user-data\\owner.db',
        request: createRequest(),
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      },
      () => child,
    );

    child.emit('message', { type: 'ready' });
    child.emit('message', {
      type: 'progress',
      progress: { phase: 'copying', progress: 30, cancellable: true },
    });
    child.emit('exit', 1);

    await expect(resultPromise).rejects.toBeInstanceOf(DbSlimmingWorkerPreReplacementError);
  });

  it('does not claim the original is untouched after replacement begins', async () => {
    const child = new FakeUtilityProcess();
    const resultPromise = runDbSlimmingMaintenanceInWorker(
      {
        userDataDir: 'C:\\user-data',
        dbFilePath: 'C:\\user-data\\owner.db',
        request: createRequest(),
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      },
      () => child,
    );

    child.emit('message', { type: 'ready' });
    child.emit('message', {
      type: 'progress',
      progress: { phase: 'finalizing', progress: 96, cancellable: false },
    });
    child.emit('message', { type: 'commit-ready' });
    child.emit('exit', 1);

    await expect(resultPromise).rejects.not.toBeInstanceOf(DbSlimmingWorkerPreReplacementError);
  });
});
