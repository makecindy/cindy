// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  setDataOwnerGeneration,
  __testing as dataOwnerTesting,
} from '@/contexts/dataOwnerGeneration';
import { __testing as sidebarOwnerTesting } from '@/lib/sidebarOwnerStorage';
import { MANUAL_PINNED_ORDER_KEY, useSidebarFilter } from '../useSidebarFilter';
import type { DataOwnerPushStamp } from '../../../../../shared/dataOwnerPush';
import {
  SIDEBAR_PINNED_ORDER_ENTRY_MAX_LENGTH,
  type SidebarPinnedOrderMutation,
} from '../../../../../shared/sidebarSettings';

const OWNER_STAMP: DataOwnerPushStamp = { dataOwnerId: 'owner-a', ownerGeneration: 1 };
const SNAPSHOT = {
  ...OWNER_STAMP,
  pinnedOrderIsAuthoritative: false,
  pinnedOrder: [] as string[],
  hiddenProjectKeys: [] as string[],
  hiddenMainViewGhostIds: [] as string[],
};

type PinnedListener = (order: string[], ownerStamp: DataOwnerPushStamp) => void;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let pinnedListeners: PinnedListener[];
let mutatePinnedOrder: ReturnType<typeof vi.fn>;
let durablePinnedOrder: string[];
let pinnedOrderIsAuthoritative: boolean;
let legacyRendererOwnerId: string | null;
let pinnedLegacyConsumed: boolean;

beforeEach(() => {
  dataOwnerTesting.reset();
  setDataOwnerGeneration('owner-a', 1);
  window.localStorage.clear();
  pinnedListeners = [];
  durablePinnedOrder = [];
  pinnedOrderIsAuthoritative = false;
  legacyRendererOwnerId = null;
  pinnedLegacyConsumed = false;
  mutatePinnedOrder = vi.fn().mockImplementation(async (mutation: SidebarPinnedOrderMutation) => {
    if (
      mutation.kind === 'migrate-legacy' &&
      mutation.order.some((entry) => entry.length > SIDEBAR_PINNED_ORDER_ENTRY_MAX_LENGTH)
    ) {
      throw new Error('invalid sidebar pinned order');
    }
    switch (mutation.kind) {
      case 'promote':
        durablePinnedOrder = [
          mutation.entryId,
          ...durablePinnedOrder.filter((entry) => entry !== mutation.entryId),
        ];
        break;
      case 'remove':
        durablePinnedOrder = durablePinnedOrder.filter((entry) => entry !== mutation.entryId);
        break;
      case 'reorder':
        durablePinnedOrder = Array.from(mutation.order);
        break;
      case 'migrate-legacy':
        if (durablePinnedOrder.length === 0) durablePinnedOrder = Array.from(mutation.order);
        break;
    }
    pinnedOrderIsAuthoritative = true;
    return Array.from(durablePinnedOrder);
  });
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    platform: 'linux',
    sidebarSettings: {
      claimLegacyRendererOwner: () => {
        const snapshot = window.electronAPI.sidebarSettings.loadSnapshot();
        if (snapshot.dataOwnerId && legacyRendererOwnerId === null) {
          legacyRendererOwnerId = snapshot.dataOwnerId;
        }
        const claimed =
          snapshot.dataOwnerId !== null && snapshot.dataOwnerId === legacyRendererOwnerId;
        if (claimed && snapshot.pinnedOrderIsAuthoritative) pinnedLegacyConsumed = true;
        return {
          dataOwnerId: snapshot.dataOwnerId,
          ownerGeneration: snapshot.ownerGeneration,
          claimed,
          canInitialize: claimed,
          pinnedLegacyConsumed: claimed && pinnedLegacyConsumed,
        };
      },
      loadSnapshot: () => ({
        ...SNAPSHOT,
        pinnedOrderIsAuthoritative,
        pinnedOrder: Array.from(durablePinnedOrder),
      }),
      mutatePinnedOrder: (...args: unknown[]) => mutatePinnedOrder(...args),
      onPinnedOrderChanged: (listener: PinnedListener) => {
        pinnedListeners.push(listener);
        return () => {
          pinnedListeners = pinnedListeners.filter((entry) => entry !== listener);
        };
      },
      onHiddenProjectKeysChanged: () => () => {},
      setProjectHidden: vi.fn(),
    },
  };
});

function renderFilter() {
  return renderHook(() => useSidebarFilter(new Set(), SNAPSHOT));
}

describe('pinned sidebar persistence', () => {
  it('rolls back an optimistic project pin when durable persistence fails', async () => {
    mutatePinnedOrder.mockRejectedValueOnce(new Error('disk full'));
    const view = renderFilter();

    let write!: Promise<void>;
    act(() => {
      write = view.result.current.promotePin('project:local:/workspace/a');
    });
    expect(view.result.current.manualPinnedOrder).toEqual(['project:local:/workspace/a']);

    await act(async () => {
      await expect(write).rejects.toThrow('disk full');
    });
    expect(view.result.current.manualPinnedOrder).toEqual([]);
  });

  it('does not let an older failed write roll back a newer optimistic action', async () => {
    const first = deferred<string[]>();
    const second = deferred<string[]>();
    mutatePinnedOrder
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const view = renderFilter();

    let firstWrite!: Promise<void>;
    let secondWrite!: Promise<void>;
    act(() => {
      firstWrite = view.result.current.promotePin('project:local:/workspace/a');
      secondWrite = view.result.current.promotePin('project:local:/workspace/b');
    });
    expect(view.result.current.manualPinnedOrder).toEqual([
      'project:local:/workspace/b',
      'project:local:/workspace/a',
    ]);

    await act(async () => {
      first.reject(new Error('first failed'));
      await expect(firstWrite).rejects.toThrow('first failed');
    });
    expect(view.result.current.manualPinnedOrder).toEqual([
      'project:local:/workspace/b',
      'project:local:/workspace/a',
    ]);

    await waitFor(() => expect(mutatePinnedOrder).toHaveBeenCalledTimes(2));
    await act(async () => {
      second.reject(new Error('second failed'));
      await expect(secondWrite).rejects.toThrow('second failed');
    });
    expect(view.result.current.manualPinnedOrder).toEqual([]);
  });

  it('keeps a mounted hook bound to its initial owner when the global owner advances', async () => {
    const view = renderFilter();

    act(() => {
      pinnedListeners[0]?.(['owner-a-session'], OWNER_STAMP);
    });
    expect(view.result.current.manualPinnedOrder).toEqual(['owner-a-session']);

    act(() => {
      setDataOwnerGeneration('owner-b', 2);
      pinnedListeners[0]?.(['owner-b-session'], {
        dataOwnerId: 'owner-b',
        ownerGeneration: 2,
      });
    });
    expect(view.result.current.manualPinnedOrder).toEqual(['owner-a-session']);

    let write!: Promise<void>;
    act(() => {
      write = view.result.current.promotePin('owner-a-new-session');
    });
    await act(async () => {
      await write;
    });
    expect(mutatePinnedOrder).toHaveBeenLastCalledWith(
      { kind: 'promote', entryId: 'owner-a-new-session' },
      OWNER_STAMP,
    );
  });

  it('uses the drag snapshot as the reorder base when a newer pin broadcast arrives', async () => {
    durablePinnedOrder = ['session-a', 'session-b'];
    const initialSnapshot = {
      ...SNAPSHOT,
      pinnedOrderIsAuthoritative: true,
      pinnedOrder: Array.from(durablePinnedOrder),
    };
    const view = renderHook(() => useSidebarFilter(new Set(), initialSnapshot));
    const dragBaseOrder = Array.from(view.result.current.manualPinnedOrder);

    durablePinnedOrder = ['session-c', 'session-a', 'session-b'];
    act(() => {
      pinnedListeners[0]?.(Array.from(durablePinnedOrder), OWNER_STAMP);
    });
    expect(view.result.current.manualPinnedOrder).toEqual(['session-c', 'session-a', 'session-b']);

    mutatePinnedOrder.mockImplementationOnce(async (mutation: SidebarPinnedOrderMutation) => {
      expect(mutation).toEqual({
        kind: 'reorder',
        baseOrder: ['session-a', 'session-b'],
        order: ['session-b', 'session-a'],
      });
      durablePinnedOrder = ['session-c', 'session-b', 'session-a'];
      return Array.from(durablePinnedOrder);
    });

    let write!: Promise<void>;
    act(() => {
      write = view.result.current.setManualPinnedOrder(
        ['session-b', 'session-a'],
        ['session-a', 'session-b'],
        dragBaseOrder,
      );
    });
    await act(async () => {
      await expect(write).resolves.toBeUndefined();
    });

    expect(view.result.current.manualPinnedOrder).toEqual(['session-c', 'session-b', 'session-a']);
  });

  it('keeps the legacy localStorage copy when its first main-process write fails', async () => {
    window.localStorage.setItem(MANUAL_PINNED_ORDER_KEY, '["legacy-session"]');
    mutatePinnedOrder.mockRejectedValueOnce(new Error('read-only disk'));
    const view = renderFilter();

    expect(view.result.current.manualPinnedOrder).toEqual(['legacy-session']);
    await waitFor(() => expect(mutatePinnedOrder).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(view.result.current.manualPinnedOrder).toEqual(['legacy-session']));
    expect(window.localStorage.getItem(MANUAL_PINNED_ORDER_KEY)).toBe('["legacy-session"]');
  });

  it('retries legacy migration after a hidden-only scoped snapshot is created', async () => {
    window.localStorage.setItem(MANUAL_PINNED_ORDER_KEY, '["legacy-session"]');
    mutatePinnedOrder.mockRejectedValueOnce(new Error('temporary failure'));
    const first = renderFilter();
    await waitFor(() => expect(mutatePinnedOrder).toHaveBeenCalledTimes(1));
    expect(window.localStorage.getItem(MANUAL_PINNED_ORDER_KEY)).toBe('["legacy-session"]');
    first.unmount();

    pinnedOrderIsAuthoritative = false;
    mutatePinnedOrder.mockClear();
    const reopened = renderFilter();

    await waitFor(() => expect(mutatePinnedOrder).toHaveBeenCalledTimes(1));
    expect(mutatePinnedOrder).toHaveBeenCalledWith(
      { kind: 'migrate-legacy', order: ['legacy-session'] },
      OWNER_STAMP,
    );
    expect(reopened.result.current.manualPinnedOrder).toEqual(['legacy-session']);
    expect(window.localStorage.getItem(MANUAL_PINNED_ORDER_KEY)).toBe('["legacy-session"]');
  });

  it('retries legacy migration before applying an action after the first migration fails', async () => {
    window.localStorage.setItem(MANUAL_PINNED_ORDER_KEY, '["legacy-session"]');
    mutatePinnedOrder.mockRejectedValueOnce(new Error('temporary failure'));
    const view = renderFilter();
    await waitFor(() => expect(mutatePinnedOrder).toHaveBeenCalledTimes(1));

    let write!: Promise<void>;
    act(() => {
      write = view.result.current.promotePin('new-session');
    });
    await act(async () => {
      await expect(write).resolves.toBeUndefined();
    });

    expect(mutatePinnedOrder.mock.calls.map(([mutation]) => mutation.kind)).toEqual([
      'migrate-legacy',
      'migrate-legacy',
      'promote',
    ]);
    expect(view.result.current.manualPinnedOrder).toEqual(['new-session', 'legacy-session']);
    expect(window.localStorage.getItem(MANUAL_PINNED_ORDER_KEY)).toBe('["legacy-session"]');
  });

  it('drops invalid legacy entries before migration so later pin actions remain usable', async () => {
    const boundarySession = 's'.repeat(SIDEBAR_PINNED_ORDER_ENTRY_MAX_LENGTH);
    const projectPrefix = 'project:';
    const boundaryProject = `${projectPrefix}${'p'.repeat(
      SIDEBAR_PINNED_ORDER_ENTRY_MAX_LENGTH - projectPrefix.length,
    )}`;
    const overlongSession = 'x'.repeat(SIDEBAR_PINNED_ORDER_ENTRY_MAX_LENGTH + 1);
    const overlongProject = `${projectPrefix}${'q'.repeat(
      SIDEBAR_PINNED_ORDER_ENTRY_MAX_LENGTH - projectPrefix.length + 1,
    )}`;
    const legacyRaw = JSON.stringify([
      'legacy-session',
      boundarySession,
      overlongSession,
      boundaryProject,
      overlongProject,
      'legacy-session',
      '',
      42,
    ]);
    window.localStorage.setItem(MANUAL_PINNED_ORDER_KEY, legacyRaw);
    const view = renderFilter();

    expect(view.result.current.manualPinnedOrder).toEqual([
      'legacy-session',
      boundarySession,
      boundaryProject,
    ]);
    await waitFor(() => expect(mutatePinnedOrder).toHaveBeenCalledTimes(1));
    expect(mutatePinnedOrder.mock.calls[0]?.[0]).toEqual({
      kind: 'migrate-legacy',
      order: ['legacy-session', boundarySession, boundaryProject],
    });
    expect(window.localStorage.getItem(MANUAL_PINNED_ORDER_KEY)).toBe(legacyRaw);

    let write!: Promise<void>;
    act(() => {
      write = view.result.current.promotePin('new-session');
    });
    await act(async () => {
      await expect(write).resolves.toBeUndefined();
    });

    expect(mutatePinnedOrder.mock.calls.map(([mutation]) => mutation.kind)).toEqual([
      'migrate-legacy',
      'promote',
    ]);
    expect(view.result.current.manualPinnedOrder).toEqual([
      'new-session',
      'legacy-session',
      boundarySession,
      boundaryProject,
    ]);
  });

  it('cancels a delayed legacy migration when another window has already persisted state', async () => {
    window.localStorage.setItem(MANUAL_PINNED_ORDER_KEY, '["legacy-session"]');
    window.electronAPI.sidebarSettings.loadSnapshot = () => ({
      ...SNAPSHOT,
      pinnedOrderIsAuthoritative: true,
      pinnedOrder: ['new-session'],
    });

    const view = renderFilter();

    await waitFor(() => expect(view.result.current.manualPinnedOrder).toEqual(['new-session']));
    expect(mutatePinnedOrder).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(MANUAL_PINNED_ORDER_KEY)).toBe('["legacy-session"]');
  });

  it('keeps Main authoritative so stale legacy pins do not revive', async () => {
    window.localStorage.setItem(MANUAL_PINNED_ORDER_KEY, '["stale-session"]');
    durablePinnedOrder = ['new-session'];
    pinnedOrderIsAuthoritative = true;
    const authoritativeSnapshot = {
      ...SNAPSHOT,
      pinnedOrderIsAuthoritative: true,
      pinnedOrder: ['new-session'],
    };
    const view = renderHook(() => useSidebarFilter(new Set(), authoritativeSnapshot));

    expect(view.result.current.manualPinnedOrder).toEqual(['new-session']);
    expect(window.localStorage.getItem(MANUAL_PINNED_ORDER_KEY)).toBe('["stale-session"]');

    await act(async () => {
      await view.result.current.removePin('new-session');
    });
    expect(durablePinnedOrder).toEqual([]);
    view.unmount();

    const reopened = renderFilter();
    expect(reopened.result.current.manualPinnedOrder).toEqual([]);
    expect(mutatePinnedOrder).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(MANUAL_PINNED_ORDER_KEY)).toBe('["stale-session"]');
  });

  it('keeps an explicitly empty main snapshot authoritative over stale legacy pins', () => {
    window.localStorage.setItem(MANUAL_PINNED_ORDER_KEY, '["stale-session"]');
    pinnedOrderIsAuthoritative = true;
    const authoritativeSnapshot = {
      ...SNAPSHOT,
      pinnedOrderIsAuthoritative: true,
    };

    const view = renderHook(() => useSidebarFilter(new Set(), authoritativeSnapshot));

    expect(view.result.current.manualPinnedOrder).toEqual([]);
    expect(window.localStorage.getItem(MANUAL_PINNED_ORDER_KEY)).toBe('["stale-session"]');
    expect(mutatePinnedOrder).not.toHaveBeenCalled();
  });

  it('cancels legacy migration when the post-subscription snapshot is explicitly empty', () => {
    window.localStorage.setItem(MANUAL_PINNED_ORDER_KEY, '["stale-session"]');
    pinnedOrderIsAuthoritative = true;

    const view = renderFilter();

    expect(view.result.current.manualPinnedOrder).toEqual([]);
    expect(window.localStorage.getItem(MANUAL_PINNED_ORDER_KEY)).toBe('["stale-session"]');
    expect(mutatePinnedOrder).not.toHaveBeenCalled();
  });

  it('does not claim or migrate legacy pins when Main has already advanced owners', () => {
    window.localStorage.setItem(MANUAL_PINNED_ORDER_KEY, '["owner-a-session"]');
    window.electronAPI.sidebarSettings.onPinnedOrderChanged = (listener: PinnedListener) => {
      pinnedListeners.push(listener);
      setDataOwnerGeneration('owner-b', 2);
      return () => {
        pinnedListeners = pinnedListeners.filter((entry) => entry !== listener);
      };
    };
    window.electronAPI.sidebarSettings.loadSnapshot = () => ({
      dataOwnerId: 'owner-b',
      ownerGeneration: 2,
      pinnedOrderIsAuthoritative: false,
      pinnedOrder: [],
      hiddenProjectKeys: [],
      hiddenMainViewGhostIds: [],
    });

    const view = renderFilter();

    expect(view.result.current.manualPinnedOrder).toEqual([]);
    expect(mutatePinnedOrder).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(MANUAL_PINNED_ORDER_KEY)).toBe('["owner-a-session"]');
    expect(window.localStorage.getItem(sidebarOwnerTesting.OWNER_CLAIM_KEY)).toBeNull();
  });

  it('migrates a valid empty legacy array to preserve the cleared state', async () => {
    window.localStorage.setItem(MANUAL_PINNED_ORDER_KEY, '[]');
    const view = renderFilter();

    expect(view.result.current.manualPinnedOrder).toEqual([]);
    await waitFor(() => expect(mutatePinnedOrder).toHaveBeenCalledTimes(1));
    expect(mutatePinnedOrder).toHaveBeenCalledWith(
      { kind: 'migrate-legacy', order: [] },
      expect.objectContaining(OWNER_STAMP),
    );
    expect(window.localStorage.getItem(MANUAL_PINNED_ORDER_KEY)).toBe('[]');
  });

  it('ignores invalid legacy bytes when the fresh Main snapshot is authoritative', () => {
    window.localStorage.setItem(MANUAL_PINNED_ORDER_KEY, '{broken');
    pinnedOrderIsAuthoritative = true;

    const view = renderFilter();

    expect(view.result.current.manualPinnedOrder).toEqual([]);
    expect(window.localStorage.getItem(MANUAL_PINNED_ORDER_KEY)).toBe('{broken');
    expect(mutatePinnedOrder).not.toHaveBeenCalled();
  });

  it('does not let a later account claim legacy pins while Main persistence is blocked', async () => {
    window.localStorage.setItem(MANUAL_PINNED_ORDER_KEY, '["owner-a-session"]');
    mutatePinnedOrder.mockRejectedValueOnce(new Error('migration blocked'));
    const ownerAView = renderFilter();
    await waitFor(() => expect(mutatePinnedOrder).toHaveBeenCalledTimes(1));
    expect(
      JSON.parse(window.localStorage.getItem(sidebarOwnerTesting.OWNER_CLAIM_KEY) ?? 'null'),
    ).toMatchObject({
      version: 1,
      ownerId: 'owner-a',
      legacy: {
        schemaVersion: 1,
        values: { [MANUAL_PINNED_ORDER_KEY]: '["owner-a-session"]' },
      },
    });
    ownerAView.unmount();

    dataOwnerTesting.reset();
    setDataOwnerGeneration('owner-b', 2);
    const ownerBSnapshot = {
      dataOwnerId: 'owner-b',
      ownerGeneration: 2,
      pinnedOrderIsAuthoritative: false,
      pinnedOrder: [],
      hiddenProjectKeys: [],
      hiddenMainViewGhostIds: [],
    };
    window.electronAPI.sidebarSettings.loadSnapshot = () => ownerBSnapshot;
    mutatePinnedOrder.mockClear();

    const ownerBView = renderHook(() => useSidebarFilter(new Set(), ownerBSnapshot));

    expect(ownerBView.result.current.manualPinnedOrder).toEqual([]);
    expect(window.localStorage.getItem(MANUAL_PINNED_ORDER_KEY)).toBe('["owner-a-session"]');
    expect(mutatePinnedOrder).not.toHaveBeenCalled();
  });
});
