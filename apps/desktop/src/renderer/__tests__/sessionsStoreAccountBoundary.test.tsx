// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { Session } from '@/lib/ccAgent.types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type SpendPayload = {
  sessionId: string;
  totalMoney?: Session['totalMoney'];
  totalCostUsd?: number;
};
type OwnerStamp = { dataOwnerId: string | null; ownerGeneration: number };

const stickyOrigin = vi.hoisted(() => ({
  deviceBySession: new Map<string, string>(),
}));

vi.mock('@/features/device-link/stickySessionOrigin', () => ({
  getStickySessionDeviceId: (sessionId: string | null | undefined): string | undefined =>
    sessionId ? stickyOrigin.deviceBySession.get(sessionId) : undefined,
}));

const mocks = vi.hoisted(() => {
  let spendListener: ((payload: SpendPayload, ownerStamp?: OwnerStamp) => void) | undefined;
  let sessionPatchListener:
    | ((payload: { sessionId: string; patch: Partial<Session> }, ownerStamp?: OwnerStamp) => void)
    | undefined;
  const onUsageSessionSpendChanged = vi.fn(
    (listener: (payload: SpendPayload, ownerStamp?: OwnerStamp) => void) => {
      spendListener = listener;
      return vi.fn();
    },
  );
  const onSessionPatched = vi.fn(
    (
      listener: (payload: { sessionId: string; patch: Partial<Session> }, ownerStamp?: OwnerStamp) => void,
    ) => {
      sessionPatchListener = listener;
      return vi.fn();
    },
  );
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      onUsageSessionSpendChanged,
      localDb: {
        sessionsPush: {
          onPatched: onSessionPatched,
          onCreated: vi.fn(() => vi.fn()),
        },
      },
    },
  });
  return {
    list: vi.fn(),
    emitSessionSpend(payload: SpendPayload, ownerStamp?: OwnerStamp): void {
      spendListener?.(payload, ownerStamp);
    },
    emitSessionPatch(
      payload: { sessionId: string; patch: Partial<Session> },
      ownerStamp?: OwnerStamp,
    ): void {
      sessionPatchListener?.(payload, ownerStamp);
    },
  };
});

vi.mock('@/lib/sessionService', () => ({
  list: mocks.list,
  create: vi.fn(),
}));

import { useCCSessions } from '@/hooks/useCCSessions';
import {
  __testing as dataOwnerTesting,
  setDataOwnerGeneration,
} from '@/contexts/dataOwnerGeneration';
import { sessionsStore } from '@/lib/sessionsStore';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function session(id: string, partial: Partial<Session> = {}): Session {
  return { id, ...partial } as Session;
}

describe('sessionsStore account boundaries', () => {
  beforeEach(() => {
    mocks.list.mockReset();
    stickyOrigin.deviceBySession.clear();
    sessionsStore.reset();
  });

  afterEach(() => {
    cleanup();
    sessionsStore.reset();
    dataOwnerTesting.reset();
  });

  it('rejects an old hook patch callback after the data owner changes', async () => {
    const pinnedAt = '2026-08-27T01:00:00.000Z';
    setDataOwnerGeneration('owner-a', 1);
    mocks.list.mockResolvedValueOnce([
      session('same-id', { pinnedAt, summary: 'owner-a summary' }),
    ]);
    const view = renderHook(() => useCCSessions());
    await waitFor(() => expect(view.result.current.sessions).toHaveLength(1));
    const oldPatchLocal = view.result.current.patchLocal;

    const newRequest = deferred<Session[]>();
    mocks.list.mockImplementationOnce(() => newRequest.promise);
    setDataOwnerGeneration('owner-b', 2);
    act(() => sessionsStore.reset());
    expect(mocks.list).toHaveBeenCalledTimes(2);

    act(() => {
      oldPatchLocal('same-id', { pinnedAt: null, summary: null });
    });
    newRequest.resolve([
      session('same-id', { pinnedAt, summary: 'owner-b summary' }),
    ]);
    await waitFor(() => {
      expect(view.result.current.sessions).toEqual([
        expect.objectContaining({
          id: 'same-id',
          pinnedAt,
          summary: 'owner-b summary',
        }),
      ]);
    });
  });

  it('ignores a stale owner-stamped local sessions push', async () => {
    setDataOwnerGeneration('owner-b', 2);
    const pinnedAt = '2026-08-27T01:00:00.000Z';
    mocks.list.mockResolvedValueOnce([
      session('same-id', { pinnedAt, summary: 'owner-b summary' }),
    ]);
    await sessionsStore.ensureByFilter('active');

    act(() => {
      mocks.emitSessionPatch(
        { sessionId: 'same-id', patch: { pinnedAt: null, summary: null } },
        { dataOwnerId: 'owner-a', ownerGeneration: 1 },
      );
    });
    expect(sessionsStore.findById('same-id')).toEqual(
      expect.objectContaining({ pinnedAt, summary: 'owner-b summary' }),
    );

    act(() => {
      mocks.emitSessionPatch(
        { sessionId: 'same-id', patch: { pinnedAt: null, summary: null } },
        { dataOwnerId: 'owner-b', ownerGeneration: 2 },
      );
    });
    expect(sessionsStore.findById('same-id')).toEqual(
      expect.objectContaining({ pinnedAt: null, summary: null }),
    );
  });

  it('rejects a remote device-link patchLocal while a same-id local refresh is in flight', async () => {
    const sessionId = 'same-id';
    const pinnedAt = '2026-08-27T01:00:00.000Z';
    stickyOrigin.deviceBySession.set(sessionId, 'device-a');
    setDataOwnerGeneration('owner-b', 2);
    const pinned = session(sessionId, { pinnedAt, summary: 'local summary' });
    mocks.list.mockResolvedValueOnce([pinned]);
    await sessionsStore.ensureByFilter('active');
    const view = renderHook(() => useCCSessions());

    const staleRequest = deferred<Session[]>();
    mocks.list.mockImplementationOnce(() => staleRequest.promise);
    const staleLoad = sessionsStore.forceRefresh('active');
    act(() => {
      view.result.current.patchLocal(sessionId, { pinnedAt: null, summary: null });
    });
    await act(async () => {
      staleRequest.resolve([pinned]);
      await staleLoad;
    });
    expect(sessionsStore.findById(sessionId)).toEqual(
      expect.objectContaining({ pinnedAt, summary: 'local summary' }),
    );

    stickyOrigin.deviceBySession.delete(sessionId);
    act(() => {
      view.result.current.patchLocal(sessionId, { pinnedAt: null, summary: null });
    });
    expect(sessionsStore.findById(sessionId)).toEqual(
      expect.objectContaining({ pinnedAt: null, summary: null }),
    );
  });

  it('does not let a request started before reset repopulate the cache', async () => {
    const oldRequest = deferred<Session[]>();
    const newRequest = deferred<Session[]>();
    mocks.list
      .mockImplementationOnce(() => oldRequest.promise)
      .mockImplementationOnce(() => newRequest.promise);

    const oldLoad = sessionsStore.ensureByFilter('active');
    sessionsStore.reset();
    const newLoad = sessionsStore.ensureByFilter('active');

    newRequest.resolve([session('new-account')]);
    await newLoad;
    oldRequest.resolve([session('old-account')]);
    await oldLoad;

    expect(sessionsStore.getByFilter('active')?.map(({ id }) => id)).toEqual(['new-account']);
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });

  it('clears an already mounted hook snapshot and reloads after reset', async () => {
    mocks.list.mockResolvedValueOnce([session('old-account')]);
    await sessionsStore.ensureByFilter('active');

    const newRequest = deferred<Session[]>();
    mocks.list.mockImplementationOnce(() => newRequest.promise);
    const view = renderHook(() => useCCSessions());
    expect(view.result.current.sessions.map(({ id }) => id)).toEqual(['old-account']);

    act(() => sessionsStore.reset());
    expect(view.result.current.sessions).toEqual([]);
    expect(view.result.current.isLoading).toBe(true);

    newRequest.resolve([session('new-account')]);
    await waitFor(() => {
      expect(view.result.current.sessions.map(({ id }) => id)).toEqual(['new-account']);
    });
    expect(view.result.current.isLoading).toBe(false);
  });

  it.each(['active', 'all'] as const)(
    'clears a failed %s load after another caller recovers the bucket',
    async (filter) => {
      mocks.list.mockRejectedValueOnce(new Error('temporary load failure'));
      const view = renderHook(() => useCCSessions({ includeArchived: filter }));
      await waitFor(() =>
        expect(view.result.current.error?.message).toBe('temporary load failure'),
      );
      expect(view.result.current.isLoading).toBe(false);
      expect(view.result.current.sessions).toEqual([]);

      mocks.list.mockResolvedValueOnce([session('recovered')]);
      await act(async () => {
        await sessionsStore.forceRefresh(filter);
      });
      expect(view.result.current.sessions.map(({ id }) => id)).toEqual(['recovered']);
      expect(view.result.current.error).toBeNull();

      mocks.list.mockResolvedValueOnce([]);
      await act(async () => {
        await sessionsStore.forceRefresh(filter);
      });
      expect(view.result.current.sessions).toEqual([]);
      expect(view.result.current.error).toBeNull();
    },
  );

  it('removes a deleted session from every loaded filter without refetching', async () => {
    mocks.list
      .mockResolvedValueOnce([session('deleted'), session('keep-active')])
      .mockResolvedValueOnce([session('deleted'), session('keep-all')]);
    await sessionsStore.ensureByFilter('active');
    await sessionsStore.ensureByFilter('all');
    mocks.list.mockReset();

    act(() => sessionsStore.patchLocal('deleted', { status: 'deleted' }));

    expect(sessionsStore.getByFilter('active')?.map(({ id }) => id)).toEqual(['keep-active']);
    expect(sessionsStore.getByFilter('all')?.map(({ id }) => id)).toEqual(['keep-all']);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('does not let a request started before delete restore the deleted session', async () => {
    const staleRequest = deferred<Session[]>();
    mocks.list.mockImplementationOnce(() => staleRequest.promise);

    const staleLoad = sessionsStore.ensureByFilter('all');
    act(() => sessionsStore.patchLocal('deleted', { status: 'deleted' }));

    expect(mocks.list).toHaveBeenCalledTimes(1);
    staleRequest.resolve([session('deleted'), session('keep')]);
    await staleLoad;

    expect(sessionsStore.getByFilter('all')?.map(({ id }) => id)).toEqual(['keep']);
  });

  it('clears pin metadata overrides when a removed session id is reused', async () => {
    const pinnedAt = '2026-08-27T01:00:00.000Z';
    const pinned = session('reused-id', { pinnedAt, summary: 'old summary' });
    mocks.list.mockResolvedValueOnce([pinned]);
    await sessionsStore.ensureByFilter('active');

    const staleRequest = deferred<Session[]>();
    mocks.list.mockImplementationOnce(() => staleRequest.promise);
    const staleLoad = sessionsStore.forceRefresh('active');
    sessionsStore.patchLocal('reused-id', { pinnedAt: null, summary: null });
    sessionsStore.removeLocal('reused-id');

    staleRequest.resolve([pinned]);
    await staleLoad;
    expect(sessionsStore.findById('reused-id')).toEqual(
      expect.objectContaining({ pinnedAt, summary: 'old summary' }),
    );
  });

  it('patches only the matching cached session when persisted spend changes', async () => {
    mocks.list.mockResolvedValueOnce([
      session('target', { totalCostUsd: 1 }),
      session('other', { totalCostUsd: 3 }),
    ]);
    await sessionsStore.ensureByFilter('active');
    mocks.list.mockClear();
    const subscriber = vi.fn();
    const unsubscribe = sessionsStore.subscribe(subscriber);

    act(() => {
      mocks.emitSessionSpend({ sessionId: 'target', totalCostUsd: 2 });
    });

    expect(sessionsStore.getByFilter('active')).toEqual([
      expect.objectContaining({ id: 'target', totalCostUsd: 2 }),
      expect.objectContaining({ id: 'other', totalCostUsd: 3 }),
    ]);
    expect(subscriber).toHaveBeenCalledTimes(1);
    expect(mocks.list).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('ignores a delayed spend push stamped for the previous owner', async () => {
    setDataOwnerGeneration('owner-b', 2);
    mocks.list.mockResolvedValueOnce([session('same-id', { totalCostUsd: 1 })]);
    await sessionsStore.ensureByFilter('active');

    act(() => {
      mocks.emitSessionSpend(
        { sessionId: 'same-id', totalCostUsd: 9 },
        { dataOwnerId: 'owner-a', ownerGeneration: 1 },
      );
    });

    expect(sessionsStore.getByFilter('active')).toEqual([
      expect.objectContaining({ id: 'same-id', totalCostUsd: 1 }),
    ]);

    act(() => {
      mocks.emitSessionSpend(
        { sessionId: 'same-id', totalCostUsd: 2 },
        { dataOwnerId: 'owner-b', ownerGeneration: 2 },
      );
    });

    expect(sessionsStore.getByFilter('active')).toEqual([
      expect.objectContaining({ id: 'same-id', totalCostUsd: 2 }),
    ]);
  });

  it('patches structured CNY spend without fabricating a USD projection', async () => {
    mocks.list.mockResolvedValueOnce([session('target', { totalCostUsd: 1 })]);
    await sessionsStore.ensureByFilter('active');

    act(() => {
      mocks.emitSessionSpend({
        sessionId: 'target',
        totalMoney: {
          amount: 3,
          currency: 'CNY',
          approximate: false,
          kind: 'actual-cost',
        },
      });
    });

    expect(sessionsStore.getByFilter('active')).toEqual([
      expect.objectContaining({
        id: 'target',
        totalCostUsd: 1,
        totalMoney: {
          amount: 3,
          currency: 'CNY',
          approximate: false,
          kind: 'actual-cost',
        },
      }),
    ]);
  });

  it('preserves spend received while a stale session list response is in flight', async () => {
    const staleRequest = deferred<Session[]>();
    mocks.list.mockImplementationOnce(() => staleRequest.promise);

    const load = sessionsStore.ensureByFilter('active');
    act(() => {
      mocks.emitSessionSpend({ sessionId: 'target', totalCostUsd: 2 });
    });
    staleRequest.resolve([
      session('target', { totalCostUsd: 1 }),
      session('other', { totalCostUsd: 3 }),
    ]);
    await load;

    expect(sessionsStore.getByFilter('active')).toEqual([
      expect.objectContaining({ id: 'target', totalCostUsd: 2 }),
      expect.objectContaining({ id: 'other', totalCostUsd: 3 }),
    ]);
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it('clears remembered spend overrides at the account boundary', async () => {
    act(() => {
      mocks.emitSessionSpend({ sessionId: 'same-id', totalCostUsd: 2 });
    });
    sessionsStore.reset();
    mocks.list.mockResolvedValueOnce([session('same-id', { totalCostUsd: 1 })]);

    await sessionsStore.ensureByFilter('active');

    expect(sessionsStore.getByFilter('active')).toEqual([
      expect.objectContaining({ id: 'same-id', totalCostUsd: 1 }),
    ]);
  });

  it('does not replay an old spend event over a newer list request', async () => {
    mocks.list.mockResolvedValueOnce([session('target', { totalCostUsd: 1 })]);
    await sessionsStore.ensureByFilter('active');
    act(() => {
      mocks.emitSessionSpend({ sessionId: 'target', totalCostUsd: 2 });
    });
    mocks.list.mockResolvedValueOnce([session('target', { totalCostUsd: 3 })]);

    await sessionsStore.forceRefresh('active');

    expect(sessionsStore.getByFilter('active')).toEqual([
      expect.objectContaining({ id: 'target', totalCostUsd: 3 }),
    ]);
  });
});
