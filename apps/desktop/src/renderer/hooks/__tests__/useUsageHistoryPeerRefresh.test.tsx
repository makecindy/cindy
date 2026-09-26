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
});
