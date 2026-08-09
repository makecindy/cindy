// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  setDataOwnerGeneration,
  __testing as dataOwnerTesting,
} from '@/contexts/dataOwnerGeneration';
import { MANUAL_PINNED_ORDER_KEY, useSidebarFilter } from '../useSidebarFilter';
import type { DataOwnerPushStamp } from '../../../../../shared/dataOwnerPush';
import type { SidebarPinnedOrderMutation } from '../../../../../shared/sidebarSettings';

const OWNER_STAMP: DataOwnerPushStamp = { dataOwnerId: 'owner-a', ownerGeneration: 1 };
const SNAPSHOT = {
  ...OWNER_STAMP,
  pinnedOrder: [] as string[],
  hiddenProjectKeys: [] as string[],
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

beforeEach(() => {
  dataOwnerTesting.reset();
  setDataOwnerGeneration('owner-a', 1);
  window.localStorage.clear();
  pinnedListeners = [];
  durablePinnedOrder = [];
  mutatePinnedOrder = vi.fn().mockImplementation(async (mutation: SidebarPinnedOrderMutation) => {
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
    return Array.from(durablePinnedOrder);
  });
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    platform: 'linux',
    sidebarSettings: {
      loadSnapshot: () => ({ ...SNAPSHOT, pinnedOrder: Array.from(durablePinnedOrder) }),
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

  it('accepts only broadcasts for the current owner generation', () => {
    const view = renderFilter();

    act(() => {
      pinnedListeners[0]?.(['owner-a-session'], OWNER_STAMP);
    });
    expect(view.result.current.manualPinnedOrder).toEqual(['owner-a-session']);

    act(() => {
      pinnedListeners[0]?.(['owner-b-session'], {
        dataOwnerId: 'owner-b',
        ownerGeneration: 2,
      });
    });
    expect(view.result.current.manualPinnedOrder).toEqual(['owner-a-session']);
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
    expect(window.localStorage.getItem(MANUAL_PINNED_ORDER_KEY)).toBeNull();
  });

  it('cancels a delayed legacy migration when another window has already persisted state', async () => {
    window.localStorage.setItem(MANUAL_PINNED_ORDER_KEY, '["legacy-session"]');
    window.electronAPI.sidebarSettings.loadSnapshot = () => ({
      ...SNAPSHOT,
      pinnedOrder: ['new-session'],
    });

    const view = renderFilter();

    await waitFor(() => expect(view.result.current.manualPinnedOrder).toEqual(['new-session']));
    expect(mutatePinnedOrder).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(MANUAL_PINNED_ORDER_KEY)).toBeNull();
  });

  it('clears a stale legacy copy when main is authoritative so cleared pins do not revive', async () => {
    window.localStorage.setItem(MANUAL_PINNED_ORDER_KEY, '["stale-session"]');
    durablePinnedOrder = ['new-session'];
    const authoritativeSnapshot = { ...SNAPSHOT, pinnedOrder: ['new-session'] };
    const view = renderHook(() => useSidebarFilter(new Set(), authoritativeSnapshot));

    expect(view.result.current.manualPinnedOrder).toEqual(['new-session']);
    expect(window.localStorage.getItem(MANUAL_PINNED_ORDER_KEY)).toBeNull();

    await act(async () => {
      await view.result.current.removePin('new-session');
    });
    expect(durablePinnedOrder).toEqual([]);
    view.unmount();

    const reopened = renderFilter();
    expect(reopened.result.current.manualPinnedOrder).toEqual([]);
    expect(mutatePinnedOrder).toHaveBeenCalledTimes(1);
  });
});
