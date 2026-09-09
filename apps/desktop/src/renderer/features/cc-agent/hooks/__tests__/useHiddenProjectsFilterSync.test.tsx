// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PROJECTS_KEY, useSidebarFilter } from '../useSidebarFilter';
import { useHiddenProjects } from '../useHiddenProjects';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { sidebarOwnerStorageKey } from '@/lib/sidebarOwnerStorage';
import type { DataOwnerPushStamp } from '../../../../../shared/dataOwnerPush';

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
    expect([...view.result.current.hiddenProjectKeys]).toEqual([]);

    await act(async () => {
      await view.result.current.setProjectHidden(PROJECT_A, true);
    });
    expect(setProjectHidden).toHaveBeenCalledWith(PROJECT_A, true, OWNER_STAMP);
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
