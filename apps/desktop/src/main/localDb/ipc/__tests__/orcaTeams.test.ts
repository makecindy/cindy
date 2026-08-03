import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listWorkersByLeads: vi.fn(),
  getAllWindows: vi.fn(),
  ipcHandle: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: mocks.getAllWindows },
  ipcMain: { handle: mocks.ipcHandle },
}));

vi.mock('../../orcaTeamStore.js', () => ({
  getTeamByLeadSession: vi.fn(),
  getTeamByWorkerSession: vi.fn(),
  listWorkersByLeads: mocks.listWorkersByLeads,
  updateWorkerStatus: vi.fn(),
}));

import {
  __resetOrcaWorkflowIpcForTest,
  listWorkersByLeadSingleFlight,
  listWorkersByLeadsSingleFlight,
  registerOrcaWorkflowIpc,
} from '../orcaTeams';
import { broadcastOrcaWorkerChanged } from '../../../maker-host/orcaWorkerBroadcast';

type BatchHandler = (event: unknown, leadSessionIds: unknown) => Promise<unknown>;

function batchHandler(): BatchHandler {
  registerOrcaWorkflowIpc();
  const call = mocks.ipcHandle.mock.calls.find(
    ([channel]) => channel === 'local-db:orca-workflows:list-workers-by-leads',
  );
  if (!call) throw new Error('list-workers-by-leads handler was not registered');
  return call[1] as BatchHandler;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('orca workflow IPC helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetOrcaWorkflowIpcForTest();
    mocks.getAllWindows.mockReturnValue([]);
  });

  it('merges concurrent list-workers requests for the same lead', async () => {
    const pending = deferred<Record<string, unknown[]>>();
    mocks.listWorkersByLeads.mockReturnValueOnce(pending.promise);

    const first = listWorkersByLeadSingleFlight('lead-1');
    const second = listWorkersByLeadSingleFlight('lead-1');

    expect(first).toBe(second);
    expect(mocks.listWorkersByLeads).toHaveBeenCalledOnce();
    expect(mocks.listWorkersByLeads).toHaveBeenCalledWith(['lead-1']);

    pending.resolve({ 'lead-1': [{ id: 'worker-1' }] });
    await expect(first).resolves.toEqual([{ id: 'worker-1' }]);
  });

  it('does not share in-flight requests across different leads', async () => {
    mocks.listWorkersByLeads.mockImplementation(async (ids: string[]) =>
      Object.fromEntries(ids.map((id) => [id, []])),
    );

    await Promise.all([
      listWorkersByLeadSingleFlight('lead-1'),
      listWorkersByLeadSingleFlight('lead-2'),
    ]);

    expect(mocks.listWorkersByLeads).toHaveBeenCalledTimes(2);
    expect(mocks.listWorkersByLeads).toHaveBeenCalledWith(['lead-1']);
    expect(mocks.listWorkersByLeads).toHaveBeenCalledWith(['lead-2']);
  });

  it('keeps a new multi-lead request to one store batch', async () => {
    mocks.listWorkersByLeads.mockResolvedValue({
      'lead-1': [{ id: 'worker-1' }],
      'lead-2': [{ id: 'worker-2' }],
    });

    await expect(listWorkersByLeadsSingleFlight(['lead-1', 'lead-2'])).resolves.toEqual({
      'lead-1': [{ id: 'worker-1' }],
      'lead-2': [{ id: 'worker-2' }],
    });
    expect(mocks.listWorkersByLeads).toHaveBeenCalledOnce();
    expect(mocks.listWorkersByLeads).toHaveBeenCalledWith(['lead-1', 'lead-2']);
  });

  it('reuses overlapping leads across batch and single requests', async () => {
    const firstBatch = deferred<Record<string, unknown[]>>();
    const secondBatch = deferred<Record<string, unknown[]>>();
    mocks.listWorkersByLeads
      .mockReturnValueOnce(firstBatch.promise)
      .mockReturnValueOnce(secondBatch.promise);

    const first = listWorkersByLeadsSingleFlight(['lead-1', 'lead-2']);
    const overlapping = listWorkersByLeadsSingleFlight(['lead-2', 'lead-3']);
    const single = listWorkersByLeadSingleFlight('lead-1');

    expect(mocks.listWorkersByLeads).toHaveBeenCalledTimes(2);
    expect(mocks.listWorkersByLeads).toHaveBeenNthCalledWith(1, ['lead-1', 'lead-2']);
    expect(mocks.listWorkersByLeads).toHaveBeenNthCalledWith(2, ['lead-3']);

    firstBatch.resolve({
      'lead-1': [{ id: 'worker-1' }],
      'lead-2': [{ id: 'worker-2' }],
    });
    secondBatch.resolve({ 'lead-3': [{ id: 'worker-3' }] });

    await expect(single).resolves.toEqual([{ id: 'worker-1' }]);
    await expect(first).resolves.toEqual({
      'lead-1': [{ id: 'worker-1' }],
      'lead-2': [{ id: 'worker-2' }],
    });
    await expect(overlapping).resolves.toEqual({
      'lead-2': [{ id: 'worker-2' }],
      'lead-3': [{ id: 'worker-3' }],
    });
  });

  it('does not join an old in-flight list after a worker change broadcast invalidates the lead', async () => {
    const stale = deferred<Record<string, unknown[]>>();
    mocks.listWorkersByLeads
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce({ 'lead-1': [{ id: 'worker-new' }] });

    const beforeWrite = listWorkersByLeadSingleFlight('lead-1');
    expect(mocks.listWorkersByLeads).toHaveBeenCalledOnce();
    expect(mocks.listWorkersByLeads).toHaveBeenCalledWith(['lead-1']);

    broadcastOrcaWorkerChanged('lead-1');
    const afterBroadcast = listWorkersByLeadSingleFlight('lead-1');

    expect(afterBroadcast).not.toBe(beforeWrite);
    expect(mocks.listWorkersByLeads).toHaveBeenCalledTimes(2);
    expect(mocks.listWorkersByLeads).toHaveBeenNthCalledWith(2, ['lead-1']);
    await expect(afterBroadcast).resolves.toEqual([{ id: 'worker-new' }]);

    stale.resolve({ 'lead-1': [{ id: 'worker-old' }] });
    await expect(beforeWrite).resolves.toEqual([{ id: 'worker-old' }]);
  });

  it('validates and deduplicates the local batch IPC input', async () => {
    mocks.listWorkersByLeads.mockResolvedValue({
      'lead-1': [{ id: 'worker-1' }],
      'lead-2': [],
    });

    await expect(batchHandler()(null, ['lead-1', 'lead-1', 'lead-2'])).resolves.toEqual({
      'lead-1': [{ id: 'worker-1' }],
      'lead-2': [],
    });
    expect(mocks.listWorkersByLeads).toHaveBeenCalledWith(['lead-1', 'lead-2']);
  });

  it('rejects non-array and oversized local batch IPC input', async () => {
    const invoke = batchHandler();

    await expect(invoke(null, { leadSessionIds: ['lead-1'] })).rejects.toThrow(/INVALID_PARAMS/);
    await expect(
      invoke(null, Array.from({ length: 201 }, (_, index) => `lead-${index}`)),
    ).rejects.toThrow(/INVALID_PARAMS/);
    expect(mocks.listWorkersByLeads).not.toHaveBeenCalled();
  });
});
