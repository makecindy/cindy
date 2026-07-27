// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useRuns } from '../useRuns';

type Listener = (payload: unknown) => void;

let scheduleListeners: Listener[] = [];
let turnCostListeners: Listener[] = [];
let listRuns: ReturnType<typeof vi.fn>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  scheduleListeners = [];
  turnCostListeners = [];
  listRuns = vi.fn(async () => []);
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    maker: {
      schedule: {
        listRuns,
        onEvent: (listener: Listener) => {
          scheduleListeners.push(listener);
          return () => {
            scheduleListeners = scheduleListeners.filter((item) => item !== listener);
          };
        },
      },
    },
    onUsageMessageTurnCost: (listener: Listener) => {
      turnCostListeners.push(listener);
      return () => {
        turnCostListeners = turnCostListeners.filter((item) => item !== listener);
      };
    },
  };
});

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  vi.restoreAllMocks();
});

describe('useRuns 异步费用刷新', () => {
  it('费用广播晚于 completed 时重新读取运行历史', async () => {
    const { unmount } = renderHook(() => useRuns('schedule-1'));
    await waitFor(() => expect(listRuns).toHaveBeenCalledTimes(1));

    act(() => {
      turnCostListeners.forEach((listener) =>
        listener({ sessionId: 'session-1', clientId: 'assistant-1', turnCostUsd: 0.42 }),
      );
    });

    await waitFor(() => expect(listRuns).toHaveBeenCalledTimes(2));
    unmount();
    expect(turnCostListeners).toHaveLength(0);
  });

  it('同一 schedule 的旧刷新响应不能覆盖较新的费用快照', async () => {
    const firstRefresh = deferred<unknown[]>();
    const secondRefresh = deferred<unknown[]>();
    listRuns
      .mockResolvedValueOnce([])
      .mockImplementationOnce(() => firstRefresh.promise)
      .mockImplementationOnce(() => secondRefresh.promise);

    const { result } = renderHook(() => useRuns('schedule-1'));
    await waitFor(() => expect(listRuns).toHaveBeenCalledTimes(1));

    act(() => {
      turnCostListeners.forEach((listener) => listener({}));
      turnCostListeners.forEach((listener) => listener({}));
    });
    await waitFor(() => expect(listRuns).toHaveBeenCalledTimes(3));

    const latestRuns = [{ id: 'latest-run' }];
    const staleRuns = [{ id: 'stale-run' }];
    await act(async () => {
      secondRefresh.resolve(latestRuns);
      await secondRefresh.promise;
    });
    await waitFor(() => expect(result.current.runs).toEqual(latestRuns));

    await act(async () => {
      firstRefresh.resolve(staleRuns);
      await firstRefresh.promise;
    });
    expect(result.current.runs).toEqual(latestRuns);
  });

  it('清空 scheduleId 时结束旧请求留下的 loading 状态', async () => {
    const pendingRefresh = deferred<unknown[]>();
    listRuns.mockImplementationOnce(() => pendingRefresh.promise);

    const { result, rerender } = renderHook(
      ({ scheduleId }: { scheduleId: string | null }) => useRuns(scheduleId),
      { initialProps: { scheduleId: 'schedule-1' as string | null } },
    );
    await waitFor(() => expect(result.current.loading).toBe(true));

    rerender({ scheduleId: null });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.runs).toEqual([]);
    expect(result.current.hasLoaded).toBe(false);

    await act(async () => {
      pendingRefresh.resolve([{ id: 'stale-run' }]);
      await pendingRefresh.promise;
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.runs).toEqual([]);
  });
});
