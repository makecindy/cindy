// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import type {
  TurnChangeSetSummary,
  TurnChangeSetUpdatedPayload,
} from '../../../../shared/turnChangeSet';
import { useTurnChangeSets } from '../useTurnChangeSets';

const transport = vi.hoisted(() => ({
  remote: new Set<string>(),
  originListeners: new Set<() => void>(),
  updates: new Map<string, (payload: TurnChangeSetUpdatedPayload) => void>(),
  list: vi.fn(),
  remoteList: vi.fn(),
  connected: true,
}));
vi.mock('@/features/device-link/stickySessionOrigin', () => ({
  getStickySessionDeviceId: (id: string) => transport.remote.has(id) ? 'device' : undefined,
}));
vi.mock('@/lib/gitReviewTransport', () => ({
  turnChangeReadApiFor: (deviceId?: string) => ({
    listTurnChangeSets: deviceId ? transport.remoteList : transport.list,
  }),
}));
vi.mock('@/features/device-link/remoteProjectsStore', () => ({
  remoteProjectsStore: {
    getDeviceList: () => [{ deviceId: 'device', connected: transport.connected }],
    subscribe: (listener: () => void) => {
      transport.originListeners.add(listener);
      return () => transport.originListeners.delete(listener);
    },
  },
}));
vi.mock('@/lib/makerTransport', () => ({
  isRemoteSessionSticky: (id: string) => transport.remote.has(id),
  subscribeTurnChangeSetUpdated: (
    id: string,
    cb: (payload: TurnChangeSetUpdatedPayload) => void,
  ) => {
    transport.updates.set(id, cb);
    return () => transport.updates.delete(id);
  },
}));

function summary(id = 'change', additions = 3): TurnChangeSetSummary {
  return {
    id,
    sessionId: 'a',
    anchorClientId: 'user-a',
    provider: 'codex',
    providerTurnId: null,
    cwd: '/workspace',
    state: 'complete',
    workspaceState: 'applied',
    isReversible: true,
    incompleteReasons: [],
    createdAt: 1,
    completedAt: 2,
    files: [],
    fileCount: 1,
    additions,
    deletions: 0,
  };
}
function deferred() {
  let resolve!: (rows: TurnChangeSetSummary[]) => void;
  const promise = new Promise<TurnChangeSetSummary[]>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
let ownerNumber = 0;
beforeEach(() => {
  setDataOwnerGeneration(`owner-${++ownerNumber}`);
  transport.remote.clear();
  transport.connected = true;
  transport.list.mockReset().mockResolvedValue([]);
  transport.remoteList.mockReset().mockResolvedValue([]);
  vi.stubGlobal('electronAPI', undefined);
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { maker: { listTurnChangeSets: transport.list } },
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('turn change card cache', () => {
  it('evicts old inactive tasks without disconnecting a mounted task', async () => {
    transport.list.mockImplementation((sessionId: string) =>
      Promise.resolve([{ ...summary(), sessionId }]),
    );
    const active = renderHook(() => useTurnChangeSets('active', null));
    await act(async () => {});
    for (let i = 0; i < 30; i++) {
      const view = renderHook(() => useTurnChangeSets(`task-${i}`, null));
      await act(async () => {});
      view.unmount();
    }
    expect(transport.updates.has('active')).toBe(true);
    act(() =>
      transport.updates.get('active')?.({ sessionId: 'active', summary: summary('change', 12) }),
    );
    expect(active.result.current[0]?.additions).toBe(12);
    transport.list.mockReturnValue(new Promise(() => {}));
    const recent = renderHook(() => useTurnChangeSets('task-29', null));
    expect(recent.result.current).toHaveLength(1);
    const evicted = renderHook(() => useTurnChangeSets('task-0', null));
    expect(evicted.result.current).toEqual([]);
  });

  it('does not show a warm cache on the first render for another owner', async () => {
    transport.list.mockResolvedValueOnce([summary()]);
    const first = renderHook(() => useTurnChangeSets('a', null));
    await act(async () => {});
    first.unmount();
    setDataOwnerGeneration('new-warm-cache-owner');
    transport.list.mockReturnValueOnce(new Promise(() => {}));
    const second = renderHook(() => useTurnChangeSets('a', null));
    expect(second.result.current).toEqual([]);
  });

  it('renders cached cards immediately on A → B → A, before the refresh resolves', async () => {
    transport.list.mockResolvedValueOnce([summary()]);
    const first = renderHook(() => useTurnChangeSets('a', null));
    await act(async () => {});
    first.unmount();
    const other = renderHook(() => useTurnChangeSets('b', null));
    await act(async () => {});
    expect(other.result.current).toEqual([]);
    other.unmount();
    const refresh = deferred();
    transport.list.mockReturnValueOnce(refresh.promise);
    const restored = renderHook(() => useTurnChangeSets('a', null));
    expect(restored.result.current).toEqual([summary()]);
    await act(async () => refresh.resolve([summary('change', 9)]));
    expect(restored.result.current[0]?.additions).toBe(9);
  });

  it('keeps cached cards across a same-owner generation repair', async () => {
    transport.list.mockResolvedValueOnce([summary()]);
    const view = renderHook(() => useTurnChangeSets('a', null));
    await act(async () => {});
    setDataOwnerGeneration(`owner-${ownerNumber}`, 2);
    view.rerender();
    expect(view.result.current).toEqual([summary()]);
  });

  it('uses authoritative refreshes to remove old cards and update undo state', async () => {
    transport.list.mockResolvedValueOnce([summary(), summary('deleted')]);
    const first = renderHook(() => useTurnChangeSets('a', null));
    await act(async () => {});
    first.unmount();
    transport.list.mockResolvedValueOnce([{ ...summary(), workspaceState: 'undone' }]);
    const restored = renderHook(() => useTurnChangeSets('a', null));
    await act(async () => {});
    expect(restored.result.current).toEqual([{ ...summary(), workspaceState: 'undone' }]);
  });

  it('keeps a newer push when an older list response arrives', async () => {
    const request = deferred();
    transport.list.mockReturnValueOnce(request.promise);
    const view = renderHook(() => useTurnChangeSets('a', null));
    act(() => transport.updates.get('a')?.({ sessionId: 'a', summary: summary('change', 10) }));
    await act(async () => request.resolve([summary()]));
    expect(view.result.current[0]?.additions).toBe(10);
  });

  it('rejects replies from a previous mount after a quick switch', async () => {
    const old = deferred(),
      next = deferred();
    transport.list.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const first = renderHook(() => useTurnChangeSets('a', null));
    const oldPush = transport.updates.get('a');
    first.unmount();
    const second = renderHook(() => useTurnChangeSets('a', null));
    await act(async () => next.resolve([summary('change', 10)]));
    await act(async () => old.resolve([summary()]));
    act(() => oldPush?.({ sessionId: 'a', summary: summary('change', 1) }));
    expect(second.result.current[0]?.additions).toBe(10);
  });

  it('does not reuse cards or late replies across data owners', async () => {
    const old = deferred();
    transport.list.mockReturnValueOnce(old.promise);
    const first = renderHook(() => useTurnChangeSets('a', null));
    first.unmount();
    setDataOwnerGeneration('another-owner');
    const second = renderHook(() => useTurnChangeSets('a', null));
    await act(async () => old.resolve([summary()]));
    expect(second.result.current).toEqual([]);
  });

  it('hides local cards when ownership becomes remote and rejects the pending response', async () => {
    const request = deferred();
    transport.list.mockReturnValueOnce(request.promise);
    const view = renderHook(() => useTurnChangeSets('a', null));
    act(() => transport.updates.get('a')?.({ sessionId: 'a', summary: summary() }));
    expect(view.result.current).toHaveLength(1);
    act(() => {
      transport.remote.add('a');
      for (const notify of transport.originListeners) notify();
    });
    await act(async () => request.resolve([summary()]));
    expect(view.result.current).toEqual([]);
    expect(transport.updates.has('a')).toBe(true);
    expect(transport.remoteList).toHaveBeenCalledWith('a');
    const ssh = renderHook(() => useTurnChangeSets('ssh', 'host'));
    expect(ssh.result.current).toEqual([]);
    expect(transport.list).toHaveBeenCalledTimes(1);
  });

  it('loads remote history, preserves a newer remote push, and never reads local records', async () => {
    transport.remote.add('a');
    const request = deferred();
    transport.remoteList.mockReturnValueOnce(request.promise);
    const view = renderHook(() => useTurnChangeSets('a', null));
    act(() => transport.updates.get('a')?.({ sessionId: 'a', summary: summary('change', 9) }));
    await act(async () => request.resolve([summary()]));
    expect(view.result.current[0]?.additions).toBe(9);
    expect(transport.list).not.toHaveBeenCalled();
  });

  it('refreshes on reconnect without falling back to local reads while disconnected', async () => {
    transport.remote.add('a');
    transport.remoteList.mockResolvedValueOnce([summary()]);
    const view = renderHook(() => useTurnChangeSets('a', null));
    await act(async () => {});
    act(() => {
      transport.connected = false;
      for (const notify of transport.originListeners) notify();
    });
    expect(view.result.current).toEqual([summary()]);
    transport.remoteList.mockResolvedValueOnce([summary('change', 12)]);
    act(() => {
      transport.connected = true;
      for (const notify of transport.originListeners) notify();
    });
    await act(async () => {});
    expect(view.result.current[0]?.additions).toBe(12);
    expect(transport.remoteList).toHaveBeenCalledTimes(2);
    expect(transport.list).not.toHaveBeenCalled();
  });

  it.each([1, 2])('replaces pending reads across reconnect with %i mounted panes', async (panes) => {
    transport.remote.add('a');
    const old = deferred(), fresh = deferred();
    transport.remoteList.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const views = Array.from({ length: panes }, () => renderHook(() => useTurnChangeSets('a', null)));
    // Each root can observe the connection transition separately while another
    // pane still holds a subscription to the same cached entry.
    transport.connected = false;
    for (const notify of [...transport.originListeners]) act(() => notify());
    transport.connected = true;
    for (const notify of [...transport.originListeners]) act(() => notify());
    expect(transport.remoteList).toHaveBeenCalledTimes(2);
    await act(async () => old.resolve([summary()]));
    expect(views[0].result.current).toEqual([]);
    const updated = { ...summary(), workspaceState: 'undone' as const };
    act(() => transport.updates.get('a')?.({ sessionId: 'a', summary: updated }));
    await act(async () => fresh.resolve([summary()]));
    for (const view of views) expect(view.result.current).toEqual([updated]);
    expect(transport.list).not.toHaveBeenCalled();
  });

  it('keeps cached cards on refresh failure and shares live state across split panes', async () => {
    transport.list.mockResolvedValueOnce([summary()]);
    const first = renderHook(() => useTurnChangeSets('a', null));
    await act(async () => {});
    transport.list.mockRejectedValueOnce(new Error('offline'));
    const second = renderHook(() => useTurnChangeSets('a', null));
    await act(async () => {});
    expect(second.result.current).toEqual([summary()]);
    first.unmount();
    act(() => transport.updates.get('a')?.({ sessionId: 'a', summary: summary('change', 8) }));
    expect(second.result.current[0]?.additions).toBe(8);
  });
});
