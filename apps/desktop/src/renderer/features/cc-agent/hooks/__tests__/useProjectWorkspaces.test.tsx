// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getDataOwnerGeneration, setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { recentWorkdirsStore } from '@/lib/recentWorkdirsStore';
import type { DataOwnerPushStamp } from '../../../../../shared/dataOwnerPush';
import type { ProjectWorkspaceSnapshot } from '../../../../../shared/projectWorkspaceSettings';
import { useProjectWorkspaces } from '../useProjectWorkspaces';

type WorkspaceApi = Window['electronAPI']['sidebarSettings'];
type WorkspaceListener = Parameters<WorkspaceApi['onProjectWorkspacesChanged']>[0];

const OWNER_A: DataOwnerPushStamp = { dataOwnerId: 'owner-a', ownerGeneration: 1 };
const OWNER_B: DataOwnerPushStamp = { dataOwnerId: 'owner-b', ownerGeneration: 2 };
const getProjectWorkspaces = vi.fn<WorkspaceApi['getProjectWorkspaces']>();
const mutateProjectWorkspaces = vi.fn<WorkspaceApi['mutateProjectWorkspaces']>();
const listeners = new Set<WorkspaceListener>();

function snapshot(name: string, ownerStamp = OWNER_A): ProjectWorkspaceSnapshot {
  return { ownerStamp, workspaces: [{ id: 'workspace', name, projectKeys: [], collapsed: false }] };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function changeOwner(stamp: DataOwnerPushStamp): void {
  setDataOwnerGeneration(stamp.dataOwnerId, stamp.ownerGeneration);
  recentWorkdirsStore.setDataOwner(getDataOwnerGeneration());
}

function push(next: ProjectWorkspaceSnapshot, stamp = next.ownerStamp ?? OWNER_A): void {
  for (const listener of listeners) listener(next, stamp);
}

beforeEach(() => {
  getProjectWorkspaces.mockReset().mockResolvedValue(snapshot('Saved'));
  mutateProjectWorkspaces.mockReset().mockResolvedValue(snapshot('Updated'));
  listeners.clear();
  changeOwner(OWNER_A);
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      sidebarSettings: {
        getProjectWorkspaces,
        mutateProjectWorkspaces,
        onProjectWorkspacesChanged: (listener: WorkspaceListener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    },
  });
});

afterEach(cleanup);

describe('useProjectWorkspaces', () => {
  it.each([
    undefined,
    {},
    { sidebarSettings: {} },
    { sidebarSettings: { getProjectWorkspaces, mutateProjectWorkspaces } },
    { sidebarSettings: { getProjectWorkspaces, onProjectWorkspacesChanged: () => () => {} } },
  ])('reports an unavailable bridge without crashing (%j)', async (api) => {
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: api });
    const { result } = renderHook(useProjectWorkspaces);
    expect(result.current).toMatchObject({
      workspaces: [],
      loading: false,
      ready: false,
      pending: false,
      error: 'PROJECT_WORKSPACES_UNAVAILABLE',
    });
    act(() => result.current.reload());
    expect(result.current.loading).toBe(false);
    await expect(result.current.mutate({ type: 'delete', id: 'workspace' })).rejects.toThrow(
      'PRECONDITION_FAILED',
    );
    expect(getProjectWorkspaces).not.toHaveBeenCalled();
    expect(mutateProjectWorkspaces).not.toHaveBeenCalled();
  });

  it('can retry after the bridge becomes available', async () => {
    const api = window.electronAPI;
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: {} });
    const { result } = renderHook(useProjectWorkspaces);
    expect(result.current.error).toBe('PROJECT_WORKSPACES_UNAVAILABLE');
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: api });
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.error).toBeNull();
    expect(listeners.size).toBe(1);
  });

  it('loads persisted workspaces without marking the initial read as a pending write', async () => {
    const read = deferred<ProjectWorkspaceSnapshot>();
    getProjectWorkspaces.mockReturnValueOnce(read.promise);
    const { result } = renderHook(useProjectWorkspaces);
    expect(result.current).toMatchObject({
      workspaces: [],
      loading: true,
      pending: false,
      ready: false,
      error: null,
    });
    await act(async () => read.resolve(snapshot('Saved')));
    expect(result.current).toMatchObject({
      workspaces: snapshot('Saved').workspaces,
      loading: false,
      ready: true,
    });
  });

  it('exposes read failures and supports a manual retry', async () => {
    getProjectWorkspaces.mockRejectedValueOnce(new Error('READ_FAILED'));
    const { result } = renderHook(useProjectWorkspaces);
    await waitFor(() => expect(result.current.error).toBe('READ_FAILED'));
    expect(result.current.ready).toBe(false);
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.error).toBeNull();
    expect(getProjectWorkspaces).toHaveBeenCalledTimes(2);
  });

  it('keeps the saved view and rejects when saving fails', async () => {
    const write = deferred<ProjectWorkspaceSnapshot>();
    mutateProjectWorkspaces.mockReturnValueOnce(write.promise);
    const { result } = renderHook(useProjectWorkspaces);
    await waitFor(() => expect(result.current.ready).toBe(true));
    let saving!: Promise<void>;
    act(() => {
      saving = result.current.mutate({ type: 'rename', id: 'workspace', name: 'Unsaved' });
    });
    expect(result.current.pending).toBe(true);
    expect(result.current.workspaces).toEqual(snapshot('Saved').workspaces);
    await act(async () => {
      write.reject(new Error('SAVE_FAILED'));
      await expect(saving).rejects.toThrow('SAVE_FAILED');
    });
    expect(result.current.workspaces).toEqual(snapshot('Saved').workspaces);
    expect(result.current.pending).toBe(false);
    await act(async () => {
      await result.current.mutate({ type: 'rename', id: 'workspace', name: 'Updated' });
    });
    expect(result.current.workspaces).toEqual(snapshot('Updated').workspaces);
  });

  it.each(['resolve', 'reject'] as const)(
    'does not let an older GET %s overwrite a live push',
    async (completion) => {
      const read = deferred<ProjectWorkspaceSnapshot>();
      getProjectWorkspaces.mockReturnValueOnce(read.promise);
      const { result } = renderHook(useProjectWorkspaces);
      act(() => push(snapshot('Pushed')));
      await act(async () => {
        if (completion === 'resolve') read.resolve(snapshot('Old'));
        else read.reject(new Error('OLD_READ_FAILED'));
      });
      expect(result.current).toMatchObject({
        workspaces: snapshot('Pushed').workspaces,
        ready: true,
        loading: false,
        error: null,
      });
    },
  );

  it('ignores an earlier reload when a later read has completed', async () => {
    const first = deferred<ProjectWorkspaceSnapshot>();
    getProjectWorkspaces
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(snapshot('Newest'));
    const { result } = renderHook(useProjectWorkspaces);
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(async () => first.resolve(snapshot('Old')));
    expect(result.current.workspaces).toEqual(snapshot('Newest').workspaces);
  });

  it('serializes burst mutations and retains pending until every write settles', async () => {
    const first = deferred<ProjectWorkspaceSnapshot>();
    const second = deferred<ProjectWorkspaceSnapshot>();
    mutateProjectWorkspaces.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result } = renderHook(useProjectWorkspaces);
    await waitFor(() => expect(result.current.ready).toBe(true));
    let firstWrite!: Promise<void>;
    let secondWrite!: Promise<void>;
    act(() => {
      firstWrite = result.current.mutate({
        type: 'create',
        id: 'new',
        name: 'New',
        projectKey: 'local:/project',
      });
      secondWrite = result.current.mutate({ type: 'rename', id: 'new', name: 'Renamed' });
    });
    await waitFor(() => expect(mutateProjectWorkspaces).toHaveBeenCalledTimes(1));
    expect(mutateProjectWorkspaces).toHaveBeenNthCalledWith(1, {
      ownerStamp: OWNER_A,
      mutation: { type: 'create', id: 'new', name: 'New', projectKey: 'local:/project' },
    });
    await act(async () => {
      first.resolve(snapshot('New'));
      await firstWrite;
    });
    expect(mutateProjectWorkspaces).toHaveBeenCalledTimes(2);
    expect(result.current.pending).toBe(true);
    expect(result.current.workspaces).toEqual(snapshot('New').workspaces);
    await act(async () => {
      second.resolve(snapshot('Renamed'));
      await secondWrite;
    });
    expect(result.current.pending).toBe(false);
    expect(result.current.workspaces).toEqual(snapshot('Renamed').workspaces);
  });

  it('invalidates an older GET when a mutation succeeds without a push', async () => {
    const read = deferred<ProjectWorkspaceSnapshot>();
    const { result } = renderHook(useProjectWorkspaces);
    await waitFor(() => expect(result.current.ready).toBe(true));
    getProjectWorkspaces.mockReturnValueOnce(read.promise);
    act(() => result.current.reload());
    await act(async () => {
      await result.current.mutate({ type: 'delete', id: 'workspace' });
    });
    await act(async () => read.resolve(snapshot('Old')));
    expect(result.current.workspaces).toEqual(snapshot('Updated').workspaces);
  });

  it.each([OWNER_B, { ...OWNER_A, ownerGeneration: 2 }])(
    'resets on owner boundary without remounting (%j)',
    async (nextOwner) => {
      const oldRead = deferred<ProjectWorkspaceSnapshot>();
      const newRead = deferred<ProjectWorkspaceSnapshot>();
      const { result } = renderHook(useProjectWorkspaces);
      await waitFor(() => expect(result.current.ready).toBe(true));
      const oldMutate = result.current.mutate;
      const oldListener = [...listeners][0];
      getProjectWorkspaces
        .mockReturnValueOnce(oldRead.promise)
        .mockReturnValueOnce(newRead.promise);
      act(() => result.current.reload());
      act(() => changeOwner(nextOwner));
      expect(result.current).toMatchObject({ workspaces: [], ready: false, pending: false });
      await expect(oldMutate({ type: 'delete', id: 'workspace' })).rejects.toThrow(
        'PRECONDITION_FAILED',
      );
      await act(async () => {
        oldRead.resolve(snapshot('Old'));
        oldListener(snapshot('Old push'), OWNER_A);
        push(snapshot('Wrong payload'), nextOwner);
      });
      expect(result.current.workspaces).toEqual([]);
      await act(async () => newRead.resolve(snapshot('New owner', nextOwner)));
      expect(result.current.workspaces).toEqual(snapshot('New owner', nextOwner).workspaces);
      expect(result.current.ready).toBe(true);
      expect(listeners.size).toBe(1);
    },
  );

  it('rejects old writes and queued mutations while the new owner can save independently', async () => {
    const oldWrite = deferred<ProjectWorkspaceSnapshot>();
    mutateProjectWorkspaces
      .mockReturnValueOnce(oldWrite.promise)
      .mockResolvedValue(snapshot('New saved', OWNER_B));
    const { result } = renderHook(useProjectWorkspaces);
    await waitFor(() => expect(result.current.ready).toBe(true));
    let first!: Promise<void>;
    let queued!: Promise<void>;
    act(() => {
      first = result.current.mutate({ type: 'rename', id: 'workspace', name: 'Old pending' });
      queued = result.current.mutate({ type: 'delete', id: 'workspace' });
    });
    await waitFor(() => expect(mutateProjectWorkspaces).toHaveBeenCalledTimes(1));
    getProjectWorkspaces.mockResolvedValue(snapshot('New owner', OWNER_B));
    act(() => changeOwner(OWNER_B));
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(async () => {
      await result.current.mutate({ type: 'rename', id: 'workspace', name: 'New saved' });
    });
    await act(async () => {
      oldWrite.resolve(snapshot('Old pending'));
      await expect(first).rejects.toThrow('PRECONDITION_FAILED');
      await expect(queued).rejects.toThrow('PRECONDITION_FAILED');
    });
    expect(mutateProjectWorkspaces).toHaveBeenCalledTimes(2);
    expect(result.current).toMatchObject({
      workspaces: snapshot('New saved', OWNER_B).workspaces,
      pending: false,
    });
  });

  it('requires a stamped snapshot before allowing a write', async () => {
    getProjectWorkspaces.mockResolvedValue({ workspaces: [] });
    const { result } = renderHook(useProjectWorkspaces);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.ready).toBe(false);
    await expect(result.current.mutate({ type: 'delete', id: 'workspace' })).rejects.toThrow(
      'PRECONDITION_FAILED',
    );
    expect(mutateProjectWorkspaces).not.toHaveBeenCalled();
  });

  it('clears an earlier ready snapshot when a reload has no owner stamp', async () => {
    const { result } = renderHook(useProjectWorkspaces);
    await waitFor(() => expect(result.current.ready).toBe(true));
    getProjectWorkspaces.mockResolvedValueOnce({ workspaces: [] });
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current).toMatchObject({ workspaces: [], ready: false, error: null });
    await expect(result.current.mutate({ type: 'delete', id: 'workspace' })).rejects.toThrow(
      'PRECONDITION_FAILED',
    );
    expect(mutateProjectWorkspaces).not.toHaveBeenCalled();
  });

  it('releases push subscriptions and rejects callbacks retained after unmount', async () => {
    const { result, unmount } = renderHook(useProjectWorkspaces);
    await waitFor(() => expect(result.current.ready).toBe(true));
    const mutate = result.current.mutate;
    unmount();
    expect(listeners.size).toBe(0);
    await expect(mutate({ type: 'delete', id: 'workspace' })).rejects.toThrow(
      'PRECONDITION_FAILED',
    );
    expect(mutateProjectWorkspaces).not.toHaveBeenCalled();
  });
});
