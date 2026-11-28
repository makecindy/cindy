// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { emitPatch } from '@/lib/sessionsBus';

import { useUsageHistory } from '../useUsageHistory';

const money = {
  amount: 0,
  currency: 'USD' as const,
  approximate: false,
  kind: 'actual-cost' as const,
};
const payload = {
  generatedAt: 1,
  todayKey: '2026-09-26',
  days: [],
  modelDaily: [],
  models: [],
  streak: { current: 0, longest: 0 },
  totals: {
    today: money,
    last30Days: money,
    last30DaysWithEstimatedValue: money,
    last30DaysEstimatedValue: money,
    todayTokens: 0,
    last30DaysTokens: 0,
  },
  anomaly: { isAnomalous: false, trailing7DayAvg: null },
};

const getHistory = vi.fn<
  (opts?: { device?: string; includeTasks?: boolean }) => Promise<typeof payload>
>(async () => payload);

beforeEach(() => {
  vi.useFakeTimers();
  getHistory.mockClear();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    maker: {
      usage: {
        getHistory,
        onTodaySpendChanged: () => () => {},
        onTodayTokensChanged: () => () => {},
        onModelPricingChanged: () => () => {},
      },
    },
  };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const callsFor = (device: string | undefined) =>
  getHistory.mock.calls.filter(([opts]) => opts?.device === device).length;

describe('useUsageHistory peer refresh', () => {
  it('re-reads a multi-device scope periodically while mounted and stops on unmount', async () => {
    const view = renderHook(() => useUsageHistory({ userId: 'peer-refresh', device: 'all' }));
    await act(async () => {});
    expect(callsFor('all')).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(callsFor('all')).toBe(2);

    view.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(callsFor('all')).toBe(2);
  });

  it('does not poll the local-only scope', async () => {
    renderHook(() => useUsageHistory({ userId: 'peer-refresh-local' }));
    await act(async () => {});
    const initial = callsFor(undefined);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(180_000);
    });
    expect(callsFor(undefined)).toBe(initial);
  });

  it('re-reads when a task is renamed or deleted, but not on unrelated session patches', async () => {
    renderHook(() => useUsageHistory({ userId: 'task-meta-refresh', device: 'all' }));
    await act(async () => {});
    const initial = callsFor('all');

    emitPatch('s1', { pinned: true } as never);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(callsFor('all')).toBe(initial);

    emitPatch('s1', { title: 'Renamed' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(callsFor('all')).toBe(initial + 1);
  });

  it('requests task data only for callers that opt in', async () => {
    renderHook(() => useUsageHistory({ userId: 'tasks-default' }));
    renderHook(() => useUsageHistory({ userId: 'tasks-opt-in', includeTasks: true }));
    await act(async () => {});
    expect(getHistory.mock.calls.map(([opts]) => opts?.includeTasks === true)).toEqual([
      false,
      true,
    ]);
  });

  it('re-reads task metadata when a Make source arrives', async () => {
    renderHook(() => useUsageHistory({ userId: 'task-source-refresh', includeTasks: true }));
    await act(async () => {});
    const initial = callsFor(undefined);

    emitPatch('s1', { source: 'cindy-make' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(callsFor(undefined)).toBe(initial + 1);
  });
});

// L340 renderer tier: a window left at the prior generation must ignore the
// actual usage subscription, including while the same account's new window updates.
it('only the window at the settled generation refreshes on the turn receipt', async () => {
  const { setDataOwnerGeneration } = await import('../../contexts/dataOwnerGeneration');
  let notify: ((snapshot: unknown, owner?: unknown) => void) | undefined;
  const usage = window.electronAPI.maker.usage;
  const subscribe = vi.spyOn(usage, 'onTodayTokensChanged').mockImplementation(fn => {
    notify = fn as typeof notify;
    return () => {};
  });
  try {
    setDataOwnerGeneration('account', 7);
    renderHook(() => useUsageHistory({ userId: 'stamped-turn' }));
    await act(async () => {});
    const before = getHistory.mock.calls.length;
    const settle = async () => {
      notify!({}, { dataOwnerId: 'account', ownerGeneration: 8 });
      await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    };
    await settle();
    expect(getHistory).toHaveBeenCalledTimes(before);
    setDataOwnerGeneration('account', 8);
    await settle();
    expect(getHistory).toHaveBeenCalledTimes(before + 1);
  } finally {
    subscribe.mockRestore();
    setDataOwnerGeneration(null, 0);
  }
});

// Renderer tier: the first push can precede the AuthProvider commit in this window.
// On the actual hook's generation update, pull the missed view once without polling.
it('reads today and history when a window catches up with an earlier stamped push', async () => {
  const auth = await import('@/contexts/AuthContext');
  const { setDataOwnerGeneration } = await import('@/contexts/dataOwnerGeneration');
  const { useTodaySpend } = await import('../useTodaySpend');
  const generation = vi.spyOn(auth, 'useOptionalDataOwnerGeneration').mockReturnValue(41);
  const usage = window.electronAPI.maker.usage;
  const getToday = vi.fn(async () => ({ day: 'fixture', totalTokens: 10 }));
  const offs = new Set<(data: { total: number }, stamp: unknown) => void>();
  Object.assign(usage, { getToday, onTodayTokensChanged: (cb: (value: {total:number}, stamp:unknown) => void) => {
    offs.add(cb); return () => offs.delete(cb);
  } });
  try {
    setDataOwnerGeneration('a', 41);
    const view = renderHook(() => { useUsageHistory({userId:'window-catchup'}); return useTodaySpend(); });
    await act(async () => {});
    expect(view.result.current.codexTokens).toBe(10);
    const initial = getHistory.mock.calls.length;
    act(() => { for (const cb of offs) cb({total:3}, {dataOwnerId:'b',ownerGeneration:42}); });
    expect(view.result.current.codexTokens).toBe(10);
    getToday.mockResolvedValue({day:'fixture',totalTokens:3});
    generation.mockReturnValue(42);
    setDataOwnerGeneration('b',42);
    await act(async () => { view.rerender(); });
    expect(getToday).toHaveBeenCalledTimes(4);
    expect(view.result.current.codexTokens).toBe(3);
    expect(getHistory).toHaveBeenCalledTimes(initial+1);
    view.unmount();
  } finally { generation.mockRestore(); setDataOwnerGeneration(null); }
});
