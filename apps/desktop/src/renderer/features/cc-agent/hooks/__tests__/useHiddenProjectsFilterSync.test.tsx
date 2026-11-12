// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PROJECTS_KEY, useSidebarFilter } from '../useSidebarFilter';
import { useHiddenProjects } from '../useHiddenProjects';
import { getDataOwnerGeneration, setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { sidebarOwnerStorageKey } from '@/lib/sidebarOwnerStorage';
import { restoreSelectedHiddenProject } from '../../lib/sidebarProjectRestore';
import type { DataOwnerPushStamp } from '../../../../../shared/dataOwnerPush';

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ dataOwnerGeneration: getDataOwnerGeneration().generation }),
}));

type HiddenProjectsListener = (projectKeys: string[], ownerStamp: DataOwnerPushStamp) => void;

const PROJECT_A = 'local:/workspace/a';
const PROJECT_B = 'local:/workspace/b';
const OWNER_STAMP: DataOwnerPushStamp = { dataOwnerId: 'owner-a', ownerGeneration: 1 };
const OWNER_PROJECTS_KEY = sidebarOwnerStorageKey(PROJECTS_KEY, 'owner-a');

let hiddenProjectsListeners: HiddenProjectsListener[] = [];
let initialHiddenProjectKeys: string[] = [];
let hiddenProjectKeysBeforeListenerRegistration: string[] | null = null;
let setProjectHidden: ReturnType<typeof vi.fn>;

function useSyncedSidebarFilter() {
  const { hiddenProjectKeys, initialSnapshot } = useHiddenProjects();
  return useSidebarFilter(hiddenProjectKeys, initialSnapshot);
}

beforeEach(() => {
  hiddenProjectsListeners = [];
  initialHiddenProjectKeys = [];
  hiddenProjectKeysBeforeListenerRegistration = null;
  setProjectHidden = vi.fn().mockResolvedValue(true);
  window.localStorage.clear();
  setDataOwnerGeneration('owner-a', 1);
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    platform: 'linux',
    sidebarSettings: {
      claimLegacyRendererOwner: () => ({
        ...OWNER_STAMP,
        claimed: true,
        canInitialize: true,
        pinnedLegacyConsumed: false,
      }),
      loadSnapshot: () => ({
        ...OWNER_STAMP,
        pinnedOrderIsAuthoritative: false,
        pinnedOrder: [],
        hiddenProjectKeys: initialHiddenProjectKeys,
        hiddenMainViewGhostIds: [],
      }),
      onHiddenProjectKeysChanged: (listener: HiddenProjectsListener) => {
        if (hiddenProjectKeysBeforeListenerRegistration !== null) {
          initialHiddenProjectKeys = hiddenProjectKeysBeforeListenerRegistration;
        }
        hiddenProjectsListeners.push(listener);
        return () => {
          hiddenProjectsListeners = hiddenProjectsListeners.filter((entry) => entry !== listener);
        };
      },
      setProjectHidden,
      onPinnedOrderChanged: () => () => {},
      mutatePinnedOrder: vi.fn().mockResolvedValue([]),
    },
  };
});

describe('hidden-project filter synchronization', () => {
  it('prunes the hidden project in every mounted renderer without toggling it back', () => {
    window.localStorage.setItem(PROJECTS_KEY, JSON.stringify([PROJECT_A, PROJECT_B]));
    const firstWindow = renderHook(() => useSyncedSidebarFilter());
    const secondWindow = renderHook(() => useSyncedSidebarFilter());

    expect(hiddenProjectsListeners).toHaveLength(2);
    act(() => {
      for (const listener of hiddenProjectsListeners) listener([PROJECT_A], OWNER_STAMP);
    });

    expect(firstWindow.result.current.projects).toEqual([PROJECT_B]);
    expect(secondWindow.result.current.projects).toEqual([PROJECT_B]);
    expect(JSON.parse(window.localStorage.getItem(OWNER_PROJECTS_KEY) ?? 'null')).toEqual([
      PROJECT_B,
    ]);

    act(() => {
      for (const listener of hiddenProjectsListeners) listener([PROJECT_A], OWNER_STAMP);
    });
    expect(firstWindow.result.current.projects).toEqual([PROJECT_B]);
    expect(secondWindow.result.current.projects).toEqual([PROJECT_B]);
  });

  it('keeps project restore scoped to the renderer that requested it', () => {
    window.localStorage.setItem(PROJECTS_KEY, JSON.stringify([PROJECT_B]));
    const restoringWindow = renderHook(() => useSyncedSidebarFilter());
    const otherWindow = renderHook(() => useSyncedSidebarFilter());

    act(() => {
      restoringWindow.result.current.ensureProjectIncluded(PROJECT_A);
    });

    expect(restoringWindow.result.current.projects).toEqual([PROJECT_B, PROJECT_A]);
    expect(otherWindow.result.current.projects).toEqual([PROJECT_B]);
    expect(JSON.parse(window.localStorage.getItem(OWNER_PROJECTS_KEY) ?? 'null')).toEqual([
      PROJECT_B,
      PROJECT_A,
    ]);
  });

  it("falls back to 'all' when the only selected project becomes hidden", () => {
    window.localStorage.setItem(PROJECTS_KEY, JSON.stringify([PROJECT_A]));
    const view = renderHook(() => useSyncedSidebarFilter());

    act(() => {
      hiddenProjectsListeners[0]?.([PROJECT_A], OWNER_STAMP);
    });

    expect(view.result.current.projects).toBe('all');
    expect(JSON.parse(window.localStorage.getItem(OWNER_PROJECTS_KEY) ?? 'null')).toBe('all');
  });
  it('reconciles the synchronous hidden snapshot on a newly mounted window', () => {
    initialHiddenProjectKeys = [PROJECT_A];
    window.localStorage.setItem(PROJECTS_KEY, JSON.stringify([PROJECT_A]));

    const view = renderHook(() => useSyncedSidebarFilter());

    expect(view.result.current.projects).toBe('all');
    expect(JSON.parse(window.localStorage.getItem(OWNER_PROJECTS_KEY) ?? 'null')).toBe('all');
  });

  it('recovers a snapshot change that happened before listener registration', async () => {
    hiddenProjectKeysBeforeListenerRegistration = [PROJECT_A];

    const view = renderHook(() => useHiddenProjects());

    await waitFor(() => {
      expect([...view.result.current.hiddenProjectKeys]).toEqual([PROJECT_A]);
    });
    expect(hiddenProjectsListeners).toHaveLength(1);

    view.unmount();
    expect(hiddenProjectsListeners).toHaveLength(0);
  });

  it('drops a hidden-project broadcast from a stale owner generation', () => {
    const view = renderHook(() => useHiddenProjects());

    act(() => {
      hiddenProjectsListeners[0]?.([PROJECT_A], {
        dataOwnerId: 'owner-b',
        ownerGeneration: 2,
      });
    });

    expect([...view.result.current.hiddenProjectKeys]).toEqual([]);
  });

  it('keeps a mounted hidden-project hook bound to its initial owner', async () => {
    const view = renderHook(() => useHiddenProjects());

    act(() => {
      setDataOwnerGeneration('owner-b', 2);
      hiddenProjectsListeners[0]?.([PROJECT_A], {
        dataOwnerId: 'owner-b',
        ownerGeneration: 2,
      });
    });
    const originalLoad = window.electronAPI.sidebarSettings.loadSnapshot;
    window.electronAPI.sidebarSettings.loadSnapshot = () => ({
      ...originalLoad(), dataOwnerId: 'owner-b', ownerGeneration: 2,
      hiddenProjectKeys: [PROJECT_A],
    });
    view.rerender();
    expect([...view.result.current.hiddenProjectKeys]).toEqual([]);

    await act(async () => {
      await view.result.current.setProjectHidden(PROJECT_A, true);
    });
    expect(setProjectHidden).toHaveBeenCalledWith(PROJECT_A, true, OWNER_STAMP);
  });

  it('restores a selected folder after a same-account refresh without remounting', async () => {
    initialHiddenProjectKeys = [PROJECT_A];
    window.localStorage.setItem(OWNER_PROJECTS_KEY, JSON.stringify([PROJECT_B]));
    const view = renderHook(() => {
      const hidden = useHiddenProjects();
      const filter = useSidebarFilter(hidden.hiddenProjectKeys, hidden.initialSnapshot);
      return { ...hidden, filter };
    });
    const staleWrite = view.result.current.setProjectHidden;
    const refreshed = { ...OWNER_STAMP, ownerGeneration: 2 };
    const originalLoad = window.electronAPI.sidebarSettings.loadSnapshot;
    window.electronAPI.sidebarSettings.loadSnapshot = () => ({ ...originalLoad(), ...refreshed });
    setProjectHidden.mockImplementation(async (_key, _hidden, stamp) => {
      if (stamp.ownerGeneration !== refreshed.ownerGeneration) {
        throw new Error('[PRECONDITION_FAILED] active account changed during sidebar mutation');
      }
      for (const listener of hiddenProjectsListeners) listener([], refreshed);
      return true;
    });
    act(() => setDataOwnerGeneration('owner-a', 2));
    view.rerender();
    await expect(staleWrite(PROJECT_A, false)).rejects.toThrow('PRECONDITION_FAILED');

    await act(async () => {
      await restoreSelectedHiddenProject({
        projectKey: PROJECT_A,
        hiddenProjectKeys: view.result.current.hiddenProjectKeys,
        setProjectHidden: view.result.current.setProjectHidden,
        getCurrentProjectKeys: () => new Set([PROJECT_A, PROJECT_B]),
        ensureProjectIncluded: view.result.current.filter.ensureProjectIncluded,
        localPlatform: 'linux',
      });
    });
    expect(setProjectHidden).toHaveBeenCalledWith(PROJECT_A, false, refreshed);
    expect([...view.result.current.hiddenProjectKeys]).toEqual([]);
    expect(view.result.current.filter.projects).toEqual([PROJECT_B, PROJECT_A]);
    await act(async () => {
      await view.result.current.filter.promotePin(PROJECT_A);
    });
    expect(window.electronAPI.sidebarSettings.mutatePinnedOrder).toHaveBeenLastCalledWith(
      { kind: 'promote', entryId: PROJECT_A },
      refreshed,
    );
  });

  it.each(['rejected', 'resolved'] as const)(
    'reconciles refreshed pins when an old write is %s after the refresh',
    async (outcome) => {
      let resolveWrite!: (order: string[]) => void;
      let rejectWrite!: (error: Error) => void;
      const pending = new Promise<string[]>((resolve, reject) => {
        resolveWrite = resolve;
        rejectWrite = reject;
      });
      vi.mocked(window.electronAPI.sidebarSettings.mutatePinnedOrder).mockReturnValueOnce(pending);
      const view = renderHook(useSyncedSidebarFilter);
      let write!: Promise<void>;
      act(() => { write = view.result.current.promotePin('old-pin'); });
      await waitFor(() => expect(window.electronAPI.sidebarSettings.mutatePinnedOrder).toHaveBeenCalled());
      expect(view.result.current.manualPinnedOrder).toEqual(['old-pin']);

      const originalLoad = window.electronAPI.sidebarSettings.loadSnapshot;
      window.electronAPI.sidebarSettings.loadSnapshot = () => ({
        ...originalLoad(), ownerGeneration: 2,
        pinnedOrderIsAuthoritative: true, pinnedOrder: ['saved-pin'],
      });
      act(() => setDataOwnerGeneration('owner-a', 2));
      view.rerender();
      await act(async () => {
        if (outcome === 'rejected') {
          rejectWrite(new Error('PRECONDITION_FAILED'));
          await expect(write).rejects.toThrow('PRECONDITION_FAILED');
        } else {
          resolveWrite(['old-pin']);
          await write;
        }
      });
      expect(view.result.current.manualPinnedOrder).toEqual(['saved-pin']);
    },
  );

  it('does not overwrite a newer optimistic pin while the refreshed write is pending', async () => {
    let rejectOld!: (error: Error) => void;
    let resolveNew!: (order: string[]) => void;
    const oldPending = new Promise<string[]>((_resolve, reject) => { rejectOld = reject; });
    const newPending = new Promise<string[]>((resolve) => { resolveNew = resolve; });
    const mutate = vi.mocked(window.electronAPI.sidebarSettings.mutatePinnedOrder);
    mutate.mockReturnValueOnce(oldPending).mockReturnValueOnce(newPending);
    const view = renderHook(useSyncedSidebarFilter);
    let oldWrite!: Promise<void>;
    act(() => { oldWrite = view.result.current.promotePin('old-pin'); });
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    const originalLoad = window.electronAPI.sidebarSettings.loadSnapshot;
    window.electronAPI.sidebarSettings.loadSnapshot = () => ({
      ...originalLoad(), ownerGeneration: 2,
      pinnedOrderIsAuthoritative: true, pinnedOrder: ['saved-pin'],
    });
    act(() => setDataOwnerGeneration('owner-a', 2));
    view.rerender();
    let newWrite!: Promise<void>;
    act(() => { newWrite = view.result.current.promotePin('new-pin'); });
    await act(async () => {
      rejectOld(new Error('PRECONDITION_FAILED'));
      await expect(oldWrite).rejects.toThrow('PRECONDITION_FAILED');
    });
    expect(mutate).toHaveBeenCalledTimes(2);
    expect(view.result.current.manualPinnedOrder[0]).toBe('new-pin');
    await act(async () => {
      resolveNew(['new-pin', 'saved-pin']);
      await newWrite;
    });
    expect(view.result.current.manualPinnedOrder).toEqual(['new-pin', 'saved-pin']);
  });

  it('rehydrates current hidden projects after refresh and ignores late old-generation pushes', () => {
    const view = renderHook(() => useHiddenProjects());
    const refreshed = { ...OWNER_STAMP, ownerGeneration: 2 };
    const originalLoad = window.electronAPI.sidebarSettings.loadSnapshot;
    window.electronAPI.sidebarSettings.loadSnapshot = () => ({
      ...originalLoad(), ...refreshed, hiddenProjectKeys: [PROJECT_B],
    });
    act(() => setDataOwnerGeneration('owner-a', 2));
    view.rerender();
    expect([...view.result.current.hiddenProjectKeys]).toEqual([PROJECT_B]);
    act(() => {
      for (const listener of hiddenProjectsListeners) listener([PROJECT_A], OWNER_STAMP);
    });
    expect([...view.result.current.hiddenProjectKeys]).toEqual([PROJECT_B]);
    act(() => {
      for (const listener of hiddenProjectsListeners) listener([PROJECT_A], refreshed);
    });
    expect([...view.result.current.hiddenProjectKeys]).toEqual([PROJECT_A]);
    expect(hiddenProjectsListeners).toHaveLength(1);
    view.unmount();
    expect(hiddenProjectsListeners).toHaveLength(0);
  });

  it('fails closed when the synchronous snapshot belongs to another owner', () => {
    window.electronAPI.sidebarSettings.loadSnapshot = () => ({
      dataOwnerId: 'owner-b',
      ownerGeneration: 2,
      pinnedOrderIsAuthoritative: true,
      pinnedOrder: ['owner-b-session'],
      hiddenProjectKeys: [PROJECT_A],
      hiddenMainViewGhostIds: [],
    });

    const view = renderHook(() => useHiddenProjects());

    expect([...view.result.current.hiddenProjectKeys]).toEqual([]);
    expect(view.result.current.initialSnapshot).toEqual({
      ...OWNER_STAMP,
      pinnedOrderIsAuthoritative: false,
      pinnedOrder: [],
      hiddenProjectKeys: [],
      hiddenMainViewGhostIds: [],
    });
  });
});

describe('sidebar content filter reset', () => {
  it('preserves archived status and display preferences while clearing project, Pi and activity filters', () => {
    const view = renderHook(() => useSyncedSidebarFilter());
    act(() => {
      view.result.current.setStatus('archived');
      view.result.current.toggleProject(PROJECT_A);
      view.result.current.setVendor('pi');
      view.result.current.setLastActivity('7d');
      view.result.current.setSortBy('priority');
      view.result.current.setGroupBy('flat');
    });
    act(() => view.result.current.resetContentFilters());
    expect(view.result.current).toMatchObject({
      status: 'archived',
      projects: 'all',
      vendor: 'all',
      lastActivity: 'all',
      sortBy: 'priority',
      groupBy: 'flat',
      isSessionContentFiltered: true,
    });
    view.unmount();
    const restored = renderHook(() => useSyncedSidebarFilter());
    expect(restored.result.current).toMatchObject({
      status: 'archived',
      projects: 'all',
      vendor: 'all',
      lastActivity: 'all',
      sortBy: 'priority',
      groupBy: 'flat',
    });
    restored.unmount();
  });
});
