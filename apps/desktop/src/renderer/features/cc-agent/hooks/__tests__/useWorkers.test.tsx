// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listWorkersByLead: vi.fn(),
  getCollaborationSettings: vi.fn(),
  subscribeOrcaWorkerChanged: vi.fn(),
}));

vi.mock('@/lib/makerTransport', () => ({
  orcaWorkflowsFor: (leadSessionId: string) => ({
    listWorkersByLead: (...args: unknown[]) => mocks.listWorkersByLead(leadSessionId, ...args),
    getCollaborationSettings: () => mocks.getCollaborationSettings(leadSessionId),
  }),
  subscribeOrcaWorkerChanged: mocks.subscribeOrcaWorkerChanged,
}));

import { clearWorkersCache, useWorkers } from '../useWorkers';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const flushAsyncUpdates = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function workerRecord(
  workerId: string,
  sessionId: string,
  focused = false,
  status: 'idle' | 'running' | 'done' | 'error' = 'idle',
) {
  return {
    id: workerId,
    sessionId,
    role: 'developer',
    label: null,
    status,
    focused,
    idleSince: null,
    session: {
      agentKind: 'codex',
      model: 'gpt-5.4',
      effort: 'high',
    },
  };
}

describe('useWorkers', () => {
  beforeEach(() => {
    clearWorkersCache();
    vi.clearAllMocks();
    mocks.listWorkersByLead.mockResolvedValue([workerRecord('worker-a', 'session-a', true)]);
    mocks.getCollaborationSettings.mockResolvedValue({
      workerSoftLimit: 3,
      workerHardLimit: 6,
    });
    mocks.subscribeOrcaWorkerChanged.mockReturnValue(() => undefined);
  });

  afterEach(() => {
    act(() => clearWorkersCache());
  });

  it('caches the worker snapshot so remount starts with the previous list instead of an empty frame', async () => {
    const first = renderHook(() => useWorkers('lead-1'));

    expect(first.result.current.workers).toEqual([]);
    await waitFor(() => {
      expect(first.result.current.workers.map((worker) => worker.sessionId)).toEqual(['session-a']);
    });
    await waitFor(() => {
      expect(first.result.current.softLimit).toBe(3);
      expect(first.result.current.hardLimit).toBe(6);
    });
    first.unmount();

    mocks.listWorkersByLead.mockClear();
    mocks.getCollaborationSettings.mockClear();
    const second = renderHook(() => useWorkers('lead-1'));

    expect(second.result.current.workers.map((worker) => worker.sessionId)).toEqual(['session-a']);
    expect(second.result.current.focusedWorker?.sessionId).toBe('session-a');
    expect(second.result.current.softLimit).toBe(3);
    expect(second.result.current.hardLimit).toBe(6);
    await waitFor(() => {
      expect(mocks.listWorkersByLead).toHaveBeenCalledOnce();
      expect(mocks.getCollaborationSettings).toHaveBeenCalledOnce();
    });
    second.unmount();
  });

  it('keeps terminal workers occupying hard-limit slots across remounts', async () => {
    mocks.listWorkersByLead.mockResolvedValue([
      workerRecord('worker-a', 'session-a', true, 'running'),
      workerRecord('worker-b', 'session-b', false, 'done'),
      workerRecord('worker-c', 'session-c', false, 'error'),
    ]);
    mocks.getCollaborationSettings.mockResolvedValue({
      workerSoftLimit: 2,
      workerHardLimit: 3,
    });
    const first = renderHook(() => useWorkers('lead-1'));

    await waitFor(() => {
      expect(first.result.current.activeWorkerCount).toBe(3);
      expect(first.result.current.hardLimit).toBe(3);
    });
    first.unmount();

    mocks.listWorkersByLead.mockClear();
    mocks.getCollaborationSettings.mockClear();
    const remount = renderHook(() => useWorkers('lead-1'));

    expect(remount.result.current.activeWorkerCount).toBe(3);
    expect(remount.result.current.hardLimit).toBe(3);
    await waitFor(() => {
      expect(mocks.listWorkersByLead).toHaveBeenCalledOnce();
      expect(mocks.getCollaborationSettings).toHaveBeenCalledOnce();
    });
    remount.unmount();
  });

  it('refreshes the cache when an ORCA_WORKER_CHANGED event arrives', async () => {
    let onWorkerChanged: (() => void) | null = null;
    mocks.subscribeOrcaWorkerChanged.mockImplementation(
      (_leadSessionId: string, cb: () => void) => {
        onWorkerChanged = cb;
        return () => undefined;
      },
    );
    const hook = renderHook(() => useWorkers('lead-1'));

    await waitFor(() => {
      expect(hook.result.current.workers.map((worker) => worker.sessionId)).toEqual(['session-a']);
    });

    mocks.listWorkersByLead.mockResolvedValueOnce([workerRecord('worker-b', 'session-b', true)]);
    await act(async () => {
      onWorkerChanged?.();
    });

    await waitFor(() => {
      expect(hook.result.current.workers.map((worker) => worker.sessionId)).toEqual(['session-b']);
    });
    hook.unmount();

    mocks.listWorkersByLead.mockResolvedValue([workerRecord('worker-b', 'session-b', true)]);
    const remount = renderHook(() => useWorkers('lead-1'));
    expect(remount.result.current.workers.map((worker) => worker.sessionId)).toEqual(['session-b']);
    await waitFor(() => {
      expect(remount.result.current.workers.map((worker) => worker.sessionId)).toEqual([
        'session-b',
      ]);
    });
    remount.unmount();
  });

  it('refreshes workers and the authoritative hard limit together for creation checks', async () => {
    const hook = renderHook(() => useWorkers('lead-1'));
    await waitFor(() => expect(hook.result.current.hardLimit).toBe(6));

    mocks.listWorkersByLead.mockResolvedValue([
      { ...workerRecord('worker-b', 'session-b', true), status: 'running' },
    ]);
    mocks.getCollaborationSettings.mockResolvedValue({
      workerSoftLimit: 1,
      workerHardLimit: 1,
    });

    let creationState!: Awaited<ReturnType<typeof hook.result.current.refreshCreationState>>;
    await act(async () => {
      creationState = await hook.result.current.refreshCreationState();
    });

    expect(creationState).toMatchObject({
      status: 'applied',
      hardLimit: 1,
      workers: [{ sessionId: 'session-b', status: 'running' }],
    });
  });

  it('only applies the latest out-of-order worker refresh for a lead', async () => {
    const first = deferred<unknown[]>();
    const second = deferred<unknown[]>();
    mocks.listWorkersByLead
      .mockReset()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    mocks.getCollaborationSettings.mockReturnValue(new Promise(() => undefined));
    const hook = renderHook(() => useWorkers('lead-1'));

    let latestRefresh!: ReturnType<typeof hook.result.current.refresh>;
    await act(async () => {
      latestRefresh = hook.result.current.refresh();
    });
    await act(async () => {
      second.resolve([workerRecord('worker-b', 'session-b', true)]);
      await latestRefresh;
    });
    expect(hook.result.current.workers.map((worker) => worker.sessionId)).toEqual(['session-b']);

    await act(async () => {
      first.resolve([workerRecord('worker-a', 'session-a', true)]);
      await flushAsyncUpdates();
    });
    expect(hook.result.current.workers.map((worker) => worker.sessionId)).toEqual(['session-b']);
  });

  it('does not let old lead worker or settings requests pollute the current hook snapshot', async () => {
    const lead1Workers = deferred<unknown[]>();
    const lead2Workers = deferred<unknown[]>();
    const lead1Settings = deferred<unknown>();
    const lead2Settings = deferred<unknown>();
    mocks.listWorkersByLead.mockImplementation((leadSessionId: string) =>
      leadSessionId === 'lead-1' ? lead1Workers.promise : lead2Workers.promise,
    );
    mocks.getCollaborationSettings.mockImplementation((leadSessionId: string) =>
      leadSessionId === 'lead-1' ? lead1Settings.promise : lead2Settings.promise,
    );

    const hook = renderHook(({ lead }) => useWorkers(lead), {
      initialProps: { lead: 'lead-1' },
    });
    hook.rerender({ lead: 'lead-2' });
    expect(hook.result.current.workers).toEqual([]);

    await act(async () => {
      lead1Workers.resolve([workerRecord('worker-a', 'session-a', true)]);
      lead1Settings.resolve({ workerSoftLimit: 1, workerHardLimit: 2 });
      await flushAsyncUpdates();
    });
    expect(hook.result.current.workers).toEqual([]);
    expect(hook.result.current.softLimit).toBe(5);
    expect(hook.result.current.hardLimit).toBe(8);

    await act(async () => {
      lead2Workers.resolve([workerRecord('worker-b', 'session-b', true)]);
      lead2Settings.resolve({ workerSoftLimit: 4, workerHardLimit: 7 });
      await flushAsyncUpdates();
    });
    await waitFor(() => {
      expect(hook.result.current.workers.map((worker) => worker.sessionId)).toEqual(['session-b']);
      expect(hook.result.current.softLimit).toBe(4);
      expect(hook.result.current.hardLimit).toBe(7);
    });
  });

  it('does not render the previous lead cache on the first render after a lead switch', async () => {
    const lead2Workers = deferred<unknown[]>();
    mocks.listWorkersByLead.mockImplementation((leadSessionId: string) =>
      leadSessionId === 'lead-1'
        ? Promise.resolve([workerRecord('worker-a', 'session-a', true)])
        : lead2Workers.promise,
    );
    mocks.getCollaborationSettings.mockReturnValue(new Promise(() => undefined));
    const hook = renderHook(({ lead }) => useWorkers(lead), {
      initialProps: { lead: 'lead-1' },
    });
    await waitFor(() => {
      expect(hook.result.current.workers.map((worker) => worker.sessionId)).toEqual(['session-a']);
    });

    hook.rerender({ lead: 'lead-2' });
    expect(hook.result.current.workers).toEqual([]);
  });

  it('only applies the latest collaboration settings request for a lead', async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    mocks.getCollaborationSettings
      .mockReset()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    mocks.listWorkersByLead.mockReturnValue(new Promise(() => undefined));
    const hook = renderHook(() => {
      const left = useWorkers('lead-1');
      useWorkers('lead-1');
      return left;
    });

    await act(async () => {
      second.resolve({ workerSoftLimit: 4, workerHardLimit: 7 });
      await flushAsyncUpdates();
    });
    expect(hook.result.current.softLimit).toBe(4);
    expect(hook.result.current.hardLimit).toBe(7);

    await act(async () => {
      first.resolve({ workerSoftLimit: 1, workerHardLimit: 2 });
      await flushAsyncUpdates();
    });
    expect(hook.result.current.softLimit).toBe(4);
    expect(hook.result.current.hardLimit).toBe(7);
  });
});
