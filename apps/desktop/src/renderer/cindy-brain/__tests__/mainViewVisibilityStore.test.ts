// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __testing as ownerGenerationTesting,
  getDataOwnerGeneration,
  setDataOwnerGeneration,
} from '@/contexts/dataOwnerGeneration';
import type { DataOwnerPushStamp } from '../../../shared/dataOwnerPush';
import type { SidebarSettingsSnapshot } from '../../../shared/sidebarSettings';
import {
  __testing,
  readMainViewSidebarVisible,
  useMainViewVisibilityRevision,
  writeMainViewSidebarVisible,
} from '../mainViewVisibilityStore';

type VisibilityListener = (ghostIds: string[], ownerStamp: DataOwnerPushStamp) => void;

let currentSnapshot: SidebarSettingsSnapshot;
let visibilityListeners: VisibilityListener[];
let setMainViewHidden: ReturnType<typeof vi.fn>;

function snapshot(
  dataOwnerId: string | null,
  ownerGeneration: number,
  hiddenMainViewGhostIds: string[] = [],
): SidebarSettingsSnapshot {
  return {
    dataOwnerId,
    ownerGeneration,
    pinnedOrderIsAuthoritative: false,
    pinnedOrder: [],
    hiddenProjectKeys: [],
    hiddenMainViewGhostIds,
  };
}

beforeEach(() => {
  setDataOwnerGeneration('owner-a', 4);
  currentSnapshot = snapshot('owner-a', 4);
  visibilityListeners = [];
  setMainViewHidden = vi
    .fn()
    .mockImplementation(
      async (ghostId: string, hidden: boolean, ownerStamp: DataOwnerPushStamp) => {
        currentSnapshot = snapshot(
          ownerStamp.dataOwnerId,
          ownerStamp.ownerGeneration,
          hidden
            ? [...currentSnapshot.hiddenMainViewGhostIds, ghostId]
            : currentSnapshot.hiddenMainViewGhostIds.filter((id) => id !== ghostId),
        );
        for (const listener of visibilityListeners) {
          listener(Array.from(currentSnapshot.hiddenMainViewGhostIds), ownerStamp);
        }
        return Array.from(currentSnapshot.hiddenMainViewGhostIds);
      },
    );
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    sidebarSettings: {
      loadSnapshot: () => ({
        ...currentSnapshot,
        hiddenMainViewGhostIds: Array.from(currentSnapshot.hiddenMainViewGhostIds),
      }),
      setMainViewHidden,
      onHiddenMainViewGhostIdsChanged: (listener: VisibilityListener) => {
        visibilityListeners.push(listener);
        return () => {
          visibilityListeners = visibilityListeners.filter((entry) => entry !== listener);
        };
      },
    },
  };
});

afterEach(() => {
  __testing.reset();
  ownerGenerationTesting.reset();
  vi.unstubAllGlobals();
});

describe('main-view sidebar visibility', () => {
  it('defaults to visible and persists only the hidden override in Main', async () => {
    expect(readMainViewSidebarVisible('owner-a', 'workspace')).toBe(true);

    await expect(
      writeMainViewSidebarVisible(getDataOwnerGeneration(), 'workspace', false),
    ).resolves.toBe(true);
    expect(setMainViewHidden).toHaveBeenLastCalledWith('workspace', true, {
      dataOwnerId: 'owner-a',
      ownerGeneration: 4,
    });
    expect(readMainViewSidebarVisible('owner-a', 'workspace')).toBe(false);

    await expect(
      writeMainViewSidebarVisible(getDataOwnerGeneration(), 'workspace', true),
    ).resolves.toBe(true);
    expect(setMainViewHidden).toHaveBeenLastCalledWith('workspace', false, {
      dataOwnerId: 'owner-a',
      ownerGeneration: 4,
    });
    expect(readMainViewSidebarVisible('owner-a', 'workspace')).toBe(true);
  });

  it('rejects a write captured before an owner-generation boundary', async () => {
    const staleOwner = getDataOwnerGeneration();
    setDataOwnerGeneration('owner-a', 5);
    currentSnapshot = snapshot('owner-a', 5);

    await expect(writeMainViewSidebarVisible(staleOwner, 'workspace', false)).resolves.toBe(false);
    expect(setMainViewHidden).not.toHaveBeenCalled();
  });

  it('ignores a completed write after the same owner advances generation', async () => {
    let resolveWrite!: (ids: string[]) => void;
    setMainViewHidden.mockReturnValueOnce(
      new Promise<string[]>((resolve) => {
        resolveWrite = resolve;
      }),
    );
    const oldOwner = getDataOwnerGeneration();
    const writing = writeMainViewSidebarVisible(oldOwner, 'workspace', false);

    setDataOwnerGeneration('owner-a', 5);
    currentSnapshot = snapshot('owner-a', 5);
    resolveWrite(['workspace']);

    await expect(writing).resolves.toBe(false);
    expect(readMainViewSidebarVisible('owner-a', 'workspace')).toBe(true);
  });

  it('reacts to current-owner broadcasts and ignores stale-owner broadcasts', () => {
    const view = renderHook(() => useMainViewVisibilityRevision());
    expect(readMainViewSidebarVisible('owner-a', 'workspace')).toBe(true);

    act(() => {
      visibilityListeners[0]?.(['workspace'], {
        dataOwnerId: 'owner-a',
        ownerGeneration: 4,
      });
    });
    expect(readMainViewSidebarVisible('owner-a', 'workspace')).toBe(false);

    act(() => {
      visibilityListeners[0]?.([], {
        dataOwnerId: 'owner-a',
        ownerGeneration: 3,
      });
    });
    expect(readMainViewSidebarVisible('owner-a', 'workspace')).toBe(false);
    view.unmount();
  });

  it('loads the new owner snapshot instead of retaining the previous owner state', () => {
    currentSnapshot = snapshot('owner-a', 4, ['workspace']);
    expect(readMainViewSidebarVisible('owner-a', 'workspace')).toBe(false);

    setDataOwnerGeneration('owner-b', 7);
    currentSnapshot = snapshot('owner-b', 7);
    expect(readMainViewSidebarVisible('owner-b', 'workspace')).toBe(true);
  });
});
