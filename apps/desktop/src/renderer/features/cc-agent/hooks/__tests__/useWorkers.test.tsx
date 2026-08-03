// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listWorkersByLead: vi.fn(),
  listWorkersByLeads: vi.fn(),
  getCollaborationSettings: vi.fn(),
  subscribeOrcaWorkerChanged: vi.fn(),
  isRemoteSessionSticky: vi.fn(),
}));

vi.mock('@/lib/makerTransport', () => ({
  isRemoteSessionSticky: (leadSessionId: string) => mocks.isRemoteSessionSticky(leadSessionId),
  orcaWorkflowsFor: (leadSessionId: string) => ({
    listWorkersByLead: (...args: unknown[]) => mocks.listWorkersByLead(leadSessionId, ...args),
    getCollaborationSettings: () => mocks.getCollaborationSettings(leadSessionId),
  }),
  orcaWorkflowsForDevice: (deviceId: string) => ({
    listWorkersByLead: (...args: unknown[]) => mocks.listWorkersByLead(deviceId, ...args),
    getCollaborationSettings: () => mocks.getCollaborationSettings(deviceId),
  }),
  subscribeOrcaWorkerChanged: mocks.subscribeOrcaWorkerChanged,
}));

import type { Session } from '@/lib/ccAgent.types';
import { useOrcaLeadWorkerMap } from '../useOrcaLeadWorkerMap';
import {
  useOrcaWorkerAttentionByLeadIds,
  useOrcaWorkerAttentionWatcher,
} from '../useOrcaWorkerAttentionWatcher';
import { clearWorkersCache, useWorkers } from '../useWorkers';
import {
  __getWorkerProjectionOwnerCountForTest,
  __setWorkerProjectionCoalesceMsForTest,
  retainWorkerProjection,
  revalidateActiveWorkerSettings,
  revalidateActiveWorkersProjection,
} from '../workerProjectionStore';
import {
  __getWorkerAttentionSnapshotForTest,
  __resetWorkerAttentionStoreForTest,
} from '../../lib/workerAttentionStore';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

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

function leadSession(id: string): Session {
  return { id, orcaRole: 'lead' } as Session;
}

describe('useWorkers / worker projection store', () => {
  let callbacks: Map<string, () => void>;

  beforeEach(() => {
    clearWorkersCache();
    vi.clearAllMocks();
    vi.useRealTimers();
    __setWorkerProjectionCoalesceMsForTest(100);
    __resetWorkerAttentionStoreForTest();
    callbacks = new Map();
    mocks.isRemoteSessionSticky.mockReturnValue(false);
    mocks.listWorkersByLead.mockResolvedValue([workerRecord('worker-a', 'session-a', true)]);
    mocks.listWorkersByLeads.mockImplementation(async (leadSessionIds: string[]) =>
      Object.fromEntries(
        leadSessionIds.map((leadSessionId) => [
          leadSessionId,
          [workerRecord(`worker-${leadSessionId}`, `session-${leadSessionId}`, true)],
        ]),
      ),
    );
    mocks.getCollaborationSettings.mockResolvedValue({
      workerSoftLimit: 3,
      workerHardLimit: 6,
    });
    mocks.subscribeOrcaWorkerChanged.mockImplementation((leadSessionId: string, cb: () => void) => {
      callbacks.set(leadSessionId, cb);
      return () => callbacks.delete(leadSessionId);
    });
    (window as unknown as {
      electronAPI: {
        localDb: {
          orcaWorkflows: {
            listWorkersByLead: typeof mocks.listWorkersByLead;
            listWorkersByLeads: typeof mocks.listWorkersByLeads;
          };
        };
      };
    }).electronAPI = {
      localDb: {
        orcaWorkflows: {
          listWorkersByLead: mocks.listWorkersByLead,
          listWorkersByLeads: mocks.listWorkersByLeads,
        },
      },
    };
  });

  afterEach(() => {
    cleanup();
    act(() => clearWorkersCache());
    __resetWorkerAttentionStoreForTest();
    vi.useRealTimers();
  });

  it('hydrates local N lead projections through one batch IPC', async () => {
    const sessions = [leadSession('lead-1'), leadSession('lead-2')];
    const hook = renderHook(() => useOrcaLeadWorkerMap(sessions));

    await waitFor(() => {
      expect(Array.from(hook.result.current.get('lead-1') ?? [])).toEqual(['session-lead-1']);
      expect(Array.from(hook.result.current.get('lead-2') ?? [])).toEqual(['session-lead-2']);
    });

    expect(mocks.listWorkersByLeads).toHaveBeenCalledTimes(1);
    expect(mocks.listWorkersByLeads).toHaveBeenCalledWith(['lead-1', 'lead-2']);
    expect(mocks.listWorkersByLead).not.toHaveBeenCalled();
  });

  it('keeps projection owners when the lead collection is only reordered', async () => {
    vi.useFakeTimers();
    const hook = renderHook(({ sessions }) => useOrcaLeadWorkerMap(sessions), {
      initialProps: { sessions: [leadSession('lead-1'), leadSession('lead-2')] },
    });
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    expect(hook.result.current.get('lead-1')?.has('session-lead-1')).toBe(true);
    expect(hook.result.current.get('lead-2')?.has('session-lead-2')).toBe(true);
    expect(__getWorkerProjectionOwnerCountForTest('lead-1')).toBe(1);
    expect(__getWorkerProjectionOwnerCountForTest('lead-2')).toBe(1);

    mocks.listWorkersByLeads.mockClear();
    mocks.subscribeOrcaWorkerChanged.mockClear();
    hook.rerender({ sessions: [leadSession('lead-2'), leadSession('lead-1')] });
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    expect(mocks.listWorkersByLeads).not.toHaveBeenCalled();
    expect(mocks.subscribeOrcaWorkerChanged).not.toHaveBeenCalled();
    expect(__getWorkerProjectionOwnerCountForTest('lead-1')).toBe(1);
    expect(__getWorkerProjectionOwnerCountForTest('lead-2')).toBe(1);
  });

  it('retains and releases only lead owner diffs when the lead collection changes', async () => {
    vi.useFakeTimers();
    const hook = renderHook(({ sessions }) => useOrcaLeadWorkerMap(sessions), {
      initialProps: { sessions: [leadSession('lead-1'), leadSession('lead-2')] },
    });
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    expect(callbacks.has('lead-1')).toBe(true);
    expect(callbacks.has('lead-2')).toBe(true);

    mocks.listWorkersByLeads.mockClear();
    mocks.subscribeOrcaWorkerChanged.mockClear();
    hook.rerender({ sessions: [leadSession('lead-2'), leadSession('lead-3')] });
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    expect(mocks.listWorkersByLeads).toHaveBeenCalledOnce();
    expect(mocks.listWorkersByLeads).toHaveBeenCalledWith(['lead-3']);
    expect(mocks.subscribeOrcaWorkerChanged).toHaveBeenCalledOnce();
    expect(mocks.subscribeOrcaWorkerChanged).toHaveBeenCalledWith('lead-3', expect.any(Function));
    expect(callbacks.has('lead-1')).toBe(false);
    expect(callbacks.has('lead-2')).toBe(true);
    expect(callbacks.has('lead-3')).toBe(true);
    expect(__getWorkerProjectionOwnerCountForTest('lead-1')).toBe(0);
    expect(__getWorkerProjectionOwnerCountForTest('lead-2')).toBe(1);
    expect(__getWorkerProjectionOwnerCountForTest('lead-3')).toBe(1);
  });

  it('chunks local projection hydration at the main IPC batch limit', async () => {
    const releases = Array.from({ length: 201 }, (_, index) =>
      retainWorkerProjection(`large-lead-${index}`),
    );

    await waitFor(() => expect(mocks.listWorkersByLeads).toHaveBeenCalledTimes(2));
    expect(mocks.listWorkersByLeads.mock.calls.map(([ids]) => ids.length)).toEqual([200, 1]);
    expect(mocks.listWorkersByLead).not.toHaveBeenCalled();

    for (const release of releases) release();
  });

  it('keeps one query and one subscription for multiple consumers of the same lead', async () => {
    renderHook(() => {
      useWorkers('lead-1');
      useWorkers('lead-1');
      return null;
    });

    await waitFor(() => expect(mocks.listWorkersByLeads).toHaveBeenCalledTimes(1));
    expect(mocks.subscribeOrcaWorkerChanged).toHaveBeenCalledTimes(1);
    expect(__getWorkerProjectionOwnerCountForTest('lead-1')).toBe(2);
  });

  it('does not fetch collaboration settings on mount and reads them for creation refresh', async () => {
    const hook = renderHook(() => useWorkers('lead-1'));

    await waitFor(() => {
      expect(hook.result.current.workers.map((worker) => worker.sessionId)).toEqual([
        'session-lead-1',
      ]);
    });
    expect(mocks.getCollaborationSettings).not.toHaveBeenCalled();

    await act(async () => {
      await revalidateActiveWorkerSettings('lead-1');
    });
    expect(mocks.getCollaborationSettings).toHaveBeenCalledOnce();
    expect(hook.result.current.softLimit).toBe(3);
    expect(hook.result.current.hardLimit).toBe(6);

    let result!: Awaited<ReturnType<typeof hook.result.current.refreshCreationState>>;
    await act(async () => {
      result = await hook.result.current.refreshCreationState();
    });

    expect(mocks.getCollaborationSettings).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ status: 'applied', hardLimit: 6 });
    expect(hook.result.current.hardLimit).toBe(6);
  });

  it('joins the initial in-flight request when the tab becomes active', async () => {
    vi.useFakeTimers();
    const first = deferred<Record<string, unknown[]>>();
    mocks.listWorkersByLeads.mockReturnValueOnce(first.promise);
    renderHook(() => useWorkers('lead-1'));
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    expect(mocks.listWorkersByLeads).toHaveBeenCalledOnce();

    const activeRefresh = revalidateActiveWorkersProjection('lead-1');
    first.resolve({ 'lead-1': [workerRecord('worker-a', 'session-a', true)] });
    await act(async () => {
      await activeRefresh;
      await vi.advanceTimersByTimeAsync(101);
    });

    expect(mocks.listWorkersByLeads).toHaveBeenCalledOnce();
  });

  it('refreshes only the changed lead and coalesces a burst of worker events', async () => {
    vi.useFakeTimers();
    __setWorkerProjectionCoalesceMsForTest(100);
    const hook = renderHook(() => useOrcaLeadWorkerMap([
      leadSession('lead-1'),
      leadSession('lead-2'),
    ]));
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    expect(hook.result.current.get('lead-1')?.has('session-lead-1')).toBe(true);
    mocks.listWorkersByLeads.mockClear();
    mocks.listWorkersByLeads.mockResolvedValueOnce({
      'lead-1': [workerRecord('worker-new', 'session-new', true)],
    });

    act(() => {
      callbacks.get('lead-1')?.();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60);
    });
    act(() => {
      callbacks.get('lead-1')?.();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(99);
    });
    expect(mocks.listWorkersByLeads).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
      await vi.runOnlyPendingTimersAsync();
    });
    expect(hook.result.current.get('lead-1')?.has('session-new')).toBe(true);

    expect(mocks.listWorkersByLeads).toHaveBeenCalledTimes(1);
    expect(mocks.listWorkersByLeads).toHaveBeenCalledWith(['lead-1']);
  });

  it('single-flights active settings refreshes for one lead', async () => {
    const settings = deferred<unknown>();
    mocks.getCollaborationSettings.mockReturnValueOnce(settings.promise);

    const first = revalidateActiveWorkerSettings('lead-1');
    const second = revalidateActiveWorkerSettings('lead-1');
    expect(first).toBe(second);
    expect(mocks.getCollaborationSettings).toHaveBeenCalledOnce();

    settings.resolve({ workerSoftLimit: 4, workerHardLimit: 7 });
    await expect(first).resolves.toEqual({ status: 'applied', hardLimit: 7 });
  });

  it('makes an authoritative refresh wait for the final trailing request', async () => {
    const first = deferred<Record<string, unknown[]>>();
    const second = deferred<Record<string, unknown[]>>();
    mocks.listWorkersByLeads.mockReturnValueOnce(first.promise);
    const hook = renderHook(() => useWorkers('lead-1'));
    await waitFor(() => expect(mocks.listWorkersByLeads).toHaveBeenCalledTimes(1));

    let refreshPromise!: ReturnType<typeof hook.result.current.refresh>;
    act(() => {
      refreshPromise = hook.result.current.refresh();
      callbacks.get('lead-1')?.();
    });
    expect(mocks.listWorkersByLeads).toHaveBeenCalledTimes(1);

    mocks.listWorkersByLeads.mockReturnValueOnce(second.promise);
    let refreshSettled = false;
    void refreshPromise.then(() => {
      refreshSettled = true;
    });
    await act(async () => {
      first.resolve({ 'lead-1': [workerRecord('worker-a', 'session-a', true)] });
    });
    await waitFor(() => expect(mocks.listWorkersByLeads).toHaveBeenCalledTimes(2));
    expect(refreshSettled).toBe(false);

    let result!: Awaited<typeof refreshPromise>;
    await act(async () => {
      second.resolve({ 'lead-1': [workerRecord('worker-b', 'session-b', true)] });
      result = await refreshPromise;
    });
    expect(result?.workers.map((worker) => worker.sessionId)).toEqual(['session-b']);
    expect(hook.result.current.workers.map((worker) => worker.sessionId)).toEqual(['session-b']);
  });

  it('routes remote leads through per-lead listWorkersByLead without the local batch channel', async () => {
    mocks.isRemoteSessionSticky.mockImplementation((leadSessionId: string) => leadSessionId === 'remote-lead');
    const hook = renderHook(() => useWorkers('remote-lead'));

    await waitFor(() => {
      expect(hook.result.current.workers.map((worker) => worker.sessionId)).toEqual(['session-a']);
    });

    expect(mocks.listWorkersByLead).toHaveBeenCalledWith('remote-lead', 'remote-lead');
    expect(mocks.listWorkersByLeads).not.toHaveBeenCalled();
  });

  it('keeps remote projection reads on the sticky device during a relay mapping gap', async () => {
    const { remoteProjectsStore } = await import('@/features/device-link/remoteProjectsStore');
    remoteProjectsStore.setDeviceSessions('dev-sticky', 'Mac', [leadSession('remote-sticky')]);
    mocks.isRemoteSessionSticky.mockReturnValue(true);

    const hook = renderHook(() => useWorkers('remote-sticky'));
    await waitFor(() => expect(hook.result.current.workers).toHaveLength(1));

    remoteProjectsStore.setDeviceSessions('dev-sticky', 'Mac', []);
    mocks.listWorkersByLead.mockClear();
    await act(async () => {
      await hook.result.current.refresh();
    });
    expect(mocks.listWorkersByLead).toHaveBeenCalledWith('dev-sticky', 'remote-sticky');
    expect(mocks.listWorkersByLeads).not.toHaveBeenCalled();
  });

  it('keeps old attention when a changed lead refresh fails', async () => {
    vi.useFakeTimers();
    mocks.listWorkersByLeads.mockResolvedValueOnce({
      'lead-1': [workerRecord('worker-done', 'session-done', false, 'done')],
    });
    renderHook(() => useOrcaWorkerAttentionWatcher([leadSession('lead-1')], undefined));
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    expect(__getWorkerAttentionSnapshotForTest().has('worker-done')).toBe(true);

    mocks.listWorkersByLeads.mockRejectedValueOnce(new Error('db busy'));
    act(() => callbacks.get('lead-1')?.());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
      await vi.runOnlyPendingTimersAsync();
    });

    expect(mocks.listWorkersByLeads).toHaveBeenCalledTimes(2);
    expect(__getWorkerAttentionSnapshotForTest().has('worker-done')).toBe(true);
  });

  it('applies a legal empty batch entry but keeps old workers and attention when a lead entry is missing', async () => {
    vi.useFakeTimers();
    mocks.listWorkersByLeads.mockResolvedValueOnce({
      'lead-1': [workerRecord('worker-done', 'session-done', false, 'done')],
    });
    const hook = renderHook(() => {
      useOrcaWorkerAttentionWatcher([leadSession('lead-1')], undefined);
      return useWorkers('lead-1');
    });
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    expect(hook.result.current.workers.map((worker) => worker.sessionId)).toEqual([
      'session-done',
    ]);
    expect(__getWorkerAttentionSnapshotForTest().has('worker-done')).toBe(true);

    mocks.listWorkersByLeads.mockResolvedValueOnce({ 'lead-1': [] });
    let emptyResult!: Awaited<ReturnType<typeof hook.result.current.refresh>>;
    await act(async () => {
      const refresh = hook.result.current.refresh();
      await vi.runOnlyPendingTimersAsync();
      emptyResult = await refresh;
    });
    expect(emptyResult).toMatchObject({ status: 'applied', workers: [] });
    expect(hook.result.current.workers).toEqual([]);
    expect(__getWorkerAttentionSnapshotForTest().has('worker-done')).toBe(false);

    mocks.listWorkersByLeads.mockResolvedValueOnce({
      'lead-1': [workerRecord('worker-done', 'session-done', false, 'done')],
    });
    await act(async () => {
      const refresh = hook.result.current.refresh();
      await vi.runOnlyPendingTimersAsync();
      await refresh;
    });
    expect(hook.result.current.workers.map((worker) => worker.sessionId)).toEqual([
      'session-done',
    ]);
    expect(__getWorkerAttentionSnapshotForTest().has('worker-done')).toBe(true);

    mocks.listWorkersByLeads.mockResolvedValueOnce({});
    let missingResult!: Awaited<ReturnType<typeof hook.result.current.refresh>>;
    await act(async () => {
      const refresh = hook.result.current.refresh();
      await vi.runOnlyPendingTimersAsync();
      missingResult = await refresh;
    });
    expect(missingResult).toMatchObject({ status: 'failed' });
    expect(missingResult?.workers.map((worker) => worker.sessionId)).toEqual(['session-done']);
    expect(hook.result.current.workers.map((worker) => worker.sessionId)).toEqual([
      'session-done',
    ]);
    expect(__getWorkerAttentionSnapshotForTest().has('worker-done')).toBe(true);

    mocks.listWorkersByLeads.mockResolvedValueOnce({ 'lead-1': null });
    let malformedResult!: Awaited<ReturnType<typeof hook.result.current.refresh>>;
    await act(async () => {
      const refresh = hook.result.current.refresh();
      await vi.runOnlyPendingTimersAsync();
      malformedResult = await refresh;
    });
    expect(malformedResult).toMatchObject({ status: 'failed' });
    expect(malformedResult?.workers.map((worker) => worker.sessionId)).toEqual(['session-done']);
    expect(__getWorkerAttentionSnapshotForTest().has('worker-done')).toBe(true);
  });

  it('lets a detached renderer derive attention from its owned lead projection', async () => {
    mocks.listWorkersByLeads.mockResolvedValueOnce({
      'lead-1': [workerRecord('worker-done', 'session-done', false, 'done')],
    });
    renderHook(() => useOrcaWorkerAttentionByLeadIds(['lead-1'], undefined));

    await waitFor(() => {
      expect(__getWorkerAttentionSnapshotForTest().has('worker-done')).toBe(true);
    });
  });

  it('keeps mounted consumers live after clearing an in-flight projection', async () => {
    vi.useFakeTimers();
    const stale = deferred<Record<string, unknown[]>>();
    mocks.listWorkersByLeads
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce({
        'lead-1': [workerRecord('worker-new', 'session-new', true)],
      });
    const hook = renderHook(() => useWorkers('lead-1'));
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    const refresh = hook.result.current.refresh();
    act(() => clearWorkersCache('lead-1'));
    await expect(refresh).resolves.toMatchObject({ status: 'failed' });
    await act(async () => {
      await vi.runAllTimersAsync();
      await Promise.resolve();
    });
    expect(hook.result.current.workers.map((worker) => worker.sessionId)).toEqual(['session-new']);

    await act(async () => {
      stale.resolve({ 'lead-1': [workerRecord('worker-stale', 'session-stale', true)] });
      await Promise.resolve();
    });
    expect(hook.result.current.workers.map((worker) => worker.sessionId)).toEqual(['session-new']);
  });

  it('does not render the previous lead projection on the first frame after a lead switch', async () => {
    const lead2 = deferred<Record<string, unknown[]>>();
    mocks.listWorkersByLeads.mockImplementation((leadSessionIds: string[]) => {
      if (leadSessionIds.includes('lead-2')) return lead2.promise;
      return Promise.resolve({
        'lead-1': [workerRecord('worker-a', 'session-a', true)],
      });
    });
    const hook = renderHook(({ lead }) => useWorkers(lead), {
      initialProps: { lead: 'lead-1' },
    });
    await waitFor(() => {
      expect(hook.result.current.workers.map((worker) => worker.sessionId)).toEqual(['session-a']);
    });

    hook.rerender({ lead: 'lead-2' });
    expect(hook.result.current.workers).toEqual([]);
    lead2.resolve({ 'lead-2': [workerRecord('worker-b', 'session-b', true)] });
  });
});
