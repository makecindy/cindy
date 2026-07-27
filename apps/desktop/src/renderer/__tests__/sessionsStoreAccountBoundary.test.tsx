// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { Session } from '@/lib/ccAgent.types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type SpendPayload = {
  sessionId: string;
  totalMoney?: Session['totalMoney'];
  totalCostUsd?: number;
};

const mocks = vi.hoisted(() => {
  let spendListener:
    | ((payload: SpendPayload) => void)
    | undefined;
  const onUsageSessionSpendChanged = vi.fn(
    (listener: (payload: SpendPayload) => void) => {
      spendListener = listener;
      return vi.fn();
    },
  );
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { onUsageSessionSpendChanged },
  });
  return {
    list: vi.fn(),
    emitSessionSpend(payload: SpendPayload): void {
      spendListener?.(payload);
    },
  };
});

vi.mock('@/lib/sessionService', () => ({
  list: mocks.list,
  create: vi.fn(),
}));

import { useCCSessions } from '@/hooks/useCCSessions';
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
    sessionsStore.reset();
  });

  afterEach(() => {
    cleanup();
    sessionsStore.reset();
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

    expect(sessionsStore.getByFilter('active')?.map(({ id }) => id)).toEqual([
      'new-account',
    ]);
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
    const replacementRequest = deferred<Session[]>();
    mocks.list
      .mockImplementationOnce(() => staleRequest.promise)
      .mockImplementationOnce(() => replacementRequest.promise);

    const staleLoad = sessionsStore.ensureByFilter('all');
    act(() => sessionsStore.patchLocal('deleted', { status: 'deleted' }));

    expect(mocks.list).toHaveBeenCalledTimes(2);
    replacementRequest.resolve([session('keep')]);
    await waitFor(() => {
      expect(sessionsStore.getByFilter('all')?.map(({ id }) => id)).toEqual(['keep']);
    });

    staleRequest.resolve([session('deleted'), session('stale')]);
    await staleLoad;

    expect(sessionsStore.getByFilter('all')?.map(({ id }) => id)).toEqual(['keep']);
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

  it('patches structured CNY spend without fabricating a USD projection', async () => {
    mocks.list.mockResolvedValueOnce([
      session('target', { totalCostUsd: 1 }),
    ]);
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
