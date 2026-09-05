import { describe, expect, it, vi } from 'vitest';

import { MAKER_INVOKE } from '../channels';
import { registerOrcaWorkerControlHandlers } from '../orcaWorkerControlHandlers';
import { IpcHarness } from './helpers/ipcHarness';

type WorkerControlResult =
  | { ok: true; workerId?: string }
  | {
      ok: false;
      errorCode: string;
      message: string;
      deferredAcknowledgementRegistered?: true;
    };

function createDeps() {
  return {
    idleWorker: vi.fn(async (): Promise<WorkerControlResult> => ({ ok: true, workerId: 'worker-1' })),
    archiveWorker: vi.fn(async (): Promise<WorkerControlResult> => ({ ok: true, workerId: 'worker-1' })),
    logInfo: vi.fn(),
  };
}

describe('Orca worker control IPC handlers', () => {
  it('rejects idle requests without leadSessionId before calling service', async () => {
    const harness = new IpcHarness();
    const deps = createDeps();
    registerOrcaWorkerControlHandlers(harness, deps);

    await expect(
      harness.invoke(MAKER_INVOKE.WORKER_IDLE, { workerId: 'worker-1' }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });

    expect(deps.idleWorker).not.toHaveBeenCalled();
  });

  it('rejects archive requests without leadSessionId before calling service', async () => {
    const harness = new IpcHarness();
    const deps = createDeps();
    registerOrcaWorkerControlHandlers(harness, deps);

    await expect(
      harness.invoke(MAKER_INVOKE.WORKER_ARCHIVE, { workerId: 'worker-1' }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });

    expect(deps.archiveWorker).not.toHaveBeenCalled();
  });

  it('passes caller lead and worker id to the idle service boundary', async () => {
    const harness = new IpcHarness();
    const deps = createDeps();
    registerOrcaWorkerControlHandlers(harness, deps);

    await expect(
      harness.invoke(MAKER_INVOKE.WORKER_IDLE, {
        leadSessionId: 'lead-1',
        workerId: 'worker-1',
      }),
    ).resolves.toEqual({ ok: true, workerId: 'worker-1' });

    expect(deps.idleWorker).toHaveBeenCalledWith({
      callerLeadSessionId: 'lead-1',
      workerId: 'worker-1',
    });
  });

  it('passes the done-state guard to the idle service boundary', async () => {
    const harness = new IpcHarness();
    const deps = createDeps();
    registerOrcaWorkerControlHandlers(harness, deps);

    await harness.invoke(MAKER_INVOKE.WORKER_IDLE, {
      leadSessionId: 'lead-1',
      workerId: 'worker-1',
      expectedStatus: 'done',
    });

    expect(deps.idleWorker).toHaveBeenCalledWith({
      callerLeadSessionId: 'lead-1',
      workerId: 'worker-1',
      expectedStatus: 'done',
    });
  });

  it('passes caller lead and worker id to the archive service boundary', async () => {
    const harness = new IpcHarness();
    const deps = createDeps();
    registerOrcaWorkerControlHandlers(harness, deps);

    await expect(
      harness.invoke(MAKER_INVOKE.WORKER_ARCHIVE, {
        leadSessionId: 'lead-1',
        workerId: 'worker-1',
      }),
    ).resolves.toEqual({ ok: true, workerId: 'worker-1' });

    expect(deps.archiveWorker).toHaveBeenCalledWith({
      callerLeadSessionId: 'lead-1',
      workerId: 'worker-1',
    });
  });

  it('maps idle service failures to stable IPC error codes', async () => {
    const harness = new IpcHarness();
    const deps = createDeps();
    deps.idleWorker.mockResolvedValueOnce({
      ok: false,
      errorCode: 'WORKER_NOT_FOUND',
      message: 'worker missing',
    });
    deps.idleWorker.mockResolvedValueOnce({
      ok: false,
      errorCode: 'ALREADY_IDLE',
      message: 'already idle',
    });
    deps.idleWorker.mockResolvedValueOnce({
      ok: false,
      errorCode: 'WORKER_STATE_CHANGED',
      message: 'worker state changed',
    });
    registerOrcaWorkerControlHandlers(harness, deps);

    await expect(
      harness.invoke(MAKER_INVOKE.WORKER_IDLE, {
        leadSessionId: 'lead-1',
        workerId: 'worker-missing',
      }),
    ).rejects.toMatchObject({ code: 'WORKER_NOT_FOUND' });

    await expect(
      harness.invoke(MAKER_INVOKE.WORKER_IDLE, {
        leadSessionId: 'lead-1',
        workerId: 'worker-1',
      }),
    ).rejects.toMatchObject({ code: 'ALREADY_IDLE' });

    await expect(
      harness.invoke(MAKER_INVOKE.WORKER_IDLE, {
        leadSessionId: 'lead-1',
        workerId: 'worker-1',
        expectedStatus: 'done',
      }),
    ).rejects.toMatchObject({ code: 'WORKER_STATE_CHANGED' });
  });

  it('uses the dedicated automatic done acknowledgement channel', async () => {
    const harness = new IpcHarness();
    const deps = createDeps();
    registerOrcaWorkerControlHandlers(harness, deps);

    await harness.invoke(MAKER_INVOKE.WORKER_ACKNOWLEDGE_DONE, {
      leadSessionId: 'lead-1',
      workerId: 'worker-1',
    });

    expect(deps.idleWorker).toHaveBeenCalledWith({
      callerLeadSessionId: 'lead-1',
      workerId: 'worker-1',
      expectedStatus: 'done',
    });
  });

  it('returns success only when the automatic channel registered a terminal-boundary retry', async () => {
    const harness = new IpcHarness();
    const deps = createDeps();
    deps.idleWorker.mockResolvedValue({
      ok: false,
      errorCode: 'WORKER_STATE_CHANGED',
      message: 'worker worker-1 has an active turn',
      deferredAcknowledgementRegistered: true,
    });
    registerOrcaWorkerControlHandlers(harness, deps);

    await expect(
      harness.invoke(MAKER_INVOKE.WORKER_ACKNOWLEDGE_DONE, {
        leadSessionId: 'lead-1',
        workerId: 'worker-1',
      }),
    ).resolves.toEqual({ ok: true, workerId: 'worker-1', deferred: true });

    await expect(
      harness.invoke(MAKER_INVOKE.WORKER_IDLE, {
        leadSessionId: 'lead-1',
        workerId: 'worker-1',
        expectedStatus: 'done',
      }),
    ).rejects.toMatchObject({ code: 'WORKER_STATE_CHANGED' });
  });

  it('maps archive service not-found failures to stable IPC error codes', async () => {
    const harness = new IpcHarness();
    const deps = createDeps();
    deps.archiveWorker.mockResolvedValueOnce({
      ok: false,
      errorCode: 'WORKER_NOT_FOUND',
      message: 'worker missing',
    });
    registerOrcaWorkerControlHandlers(harness, deps);

    await expect(
      harness.invoke(MAKER_INVOKE.WORKER_ARCHIVE, {
        leadSessionId: 'lead-1',
        workerId: 'worker-missing',
      }),
    ).rejects.toMatchObject({ code: 'WORKER_NOT_FOUND' });
  });

  it('maps thrown service errors to INTERNAL instead of leaking raw exceptions', async () => {
    const harness = new IpcHarness();
    const deps = createDeps();
    deps.archiveWorker.mockRejectedValueOnce(new Error('store failed'));
    registerOrcaWorkerControlHandlers(harness, deps);

    await expect(
      harness.invoke(MAKER_INVOKE.WORKER_ARCHIVE, {
        leadSessionId: 'lead-1',
        workerId: 'worker-1',
      }),
    ).rejects.toMatchObject({ code: 'INTERNAL' });
  });
});
