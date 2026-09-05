// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const estimatedSessionValueBatchFor = vi.fn();
let remotePushListener:
  ((payload: { deviceId: string; channel: string; payload: unknown }) => void) | undefined;

vi.mock('@/lib/makerTransport', () => ({
  estimatedSessionValueBatchFor: (...args: unknown[]) => estimatedSessionValueBatchFor(...args),
}));

vi.mock('@/contexts/dataOwnerGeneration', () => ({
  isDataOwnerPushCurrent: () => true,
}));

vi.mock('@/lib/remoteDataOwnerPushFence', () => ({
  isDeviceLinkRemotePushCurrent: () => true,
}));

vi.mock('@/features/device-link/stickySessionOrigin', () => ({
  getStickySessionDeviceId: (sessionId: string) => (sessionId === 'remote-1' ? 'dev-1' : undefined),
}));

import {
  __resetSidebarSessionUsageStoreForTests,
  useSidebarSessionUsageMoney,
} from '../sidebarSessionUsageStore';

describe('useSidebarSessionUsageMoney', () => {
  let turnCostListener: ((payload: { sessionId: string }) => void) | undefined;
  let spendListener:
    | ((payload: { sessionId: string; totalMoney?: unknown; totalCostUsd?: number }) => void)
    | undefined;

  beforeEach(() => {
    __resetSidebarSessionUsageStoreForTests();
    turnCostListener = undefined;
    spendListener = undefined;
    remotePushListener = undefined;
    estimatedSessionValueBatchFor.mockReset();
    estimatedSessionValueBatchFor.mockResolvedValue({
      's-1': {
        projectionVersion: 1,
        estimatedValueMoney: {
          amount: 0.12,
          currency: 'USD',
          approximate: true,
          kind: 'value-estimate',
        },
        excludedActualMoney: null,
      },
      's-2': {
        projectionVersion: 1,
        estimatedValueMoney: {
          amount: 0.34,
          currency: 'USD',
          approximate: true,
          kind: 'value-estimate',
        },
        excludedActualMoney: null,
      },
      'remote-1': {
        projectionVersion: 1,
        estimatedValueMoney: null,
        excludedActualMoney: null,
      },
    });
    vi.stubGlobal('window', {
      electronAPI: {
        onUsageSessionSpendChanged: vi.fn((cb: typeof spendListener) => {
          spendListener = cb;
          return () => {
            spendListener = undefined;
          };
        }),
        onUsageMessageTurnCost: vi.fn((cb: (payload: { sessionId: string }) => void) => {
          turnCostListener = cb;
          return () => undefined;
        }),
        deviceLink: {
          onRemotePush: vi.fn((cb: typeof remotePushListener) => {
            remotePushListener = cb ?? undefined;
            return () => {
              remotePushListener = undefined;
            };
          }),
        },
      },
    });
  });

  afterEach(() => {
    __resetSidebarSessionUsageStoreForTests();
    vi.useRealTimers();
  });

  it('coalesces visible sidebar rows into one main-process batch query', async () => {
    vi.useFakeTimers();
    const first = renderHook(() =>
      useSidebarSessionUsageMoney(
        's-1',
        { amount: 1, currency: 'USD', approximate: false, kind: 'actual-cost' },
        1,
        'regular',
        false,
      ),
    );
    const second = renderHook(() =>
      useSidebarSessionUsageMoney(
        's-2',
        { amount: 2, currency: 'USD', approximate: false, kind: 'actual-cost' },
        2,
        'hidden',
        false,
      ),
    );

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(estimatedSessionValueBatchFor).toHaveBeenCalledTimes(1);
    expect(estimatedSessionValueBatchFor).toHaveBeenCalledWith(
      [
        { sessionId: 's-1', presentation: 'regular', showSdkEstimate: false },
        { sessionId: 's-2', presentation: 'hidden', showSdkEstimate: false },
      ],
      false,
    );
    expect(first.result.current.estimatedValueMoney?.amount).toBeCloseTo(0.12);
    expect(second.result.current.estimatedValueMoney?.amount).toBeCloseTo(0.34);
    expect(window.electronAPI.onUsageMessageTurnCost).toHaveBeenCalledTimes(1);
    expect(window.electronAPI.onUsageSessionSpendChanged).toHaveBeenCalledTimes(1);
  });

  it('does not query until a visible cost field registers interest', async () => {
    vi.useFakeTimers();
    renderHook(() => useSidebarSessionUsageMoney(undefined, null, null, 'regular', false));
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(estimatedSessionValueBatchFor).not.toHaveBeenCalled();
  });

  it('fails closed for regular sessions until a versioned projection excludes legacy SDK cost', async () => {
    vi.useFakeTimers();
    let resolveProjection: ((value: unknown) => void) | undefined;
    estimatedSessionValueBatchFor.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveProjection = resolve;
        }),
    );

    const hook = renderHook(() =>
      useSidebarSessionUsageMoney(
        's-1',
        { amount: 1, currency: 'USD', approximate: false, kind: 'actual-cost' },
        1,
        'regular',
        false,
      ),
    );

    expect(hook.result.current.actualMoney).toBeNull();
    expect(hook.result.current.totalMoney).toBeNull();
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(hook.result.current.actualMoney).toBeNull();

    await act(async () => {
      resolveProjection?.({
        's-1': {
          projectionVersion: 1,
          estimatedValueMoney: null,
          excludedActualMoney: {
            amount: 0.25,
            currency: 'USD',
            approximate: false,
            kind: 'actual-cost',
          },
        },
      });
      await Promise.resolve();
    });

    expect(hook.result.current.actualMoney?.amount).toBeCloseTo(0.75);
    expect(hook.result.current.totalMoney?.amount).toBeCloseTo(0.75);
  });

  it('keeps regular session actual money hidden when the projection is unversioned', async () => {
    vi.useFakeTimers();
    estimatedSessionValueBatchFor.mockResolvedValueOnce({
      's-1': {
        estimatedValueMoney: null,
        excludedActualMoney: null,
      },
    });
    const hook = renderHook(() =>
      useSidebarSessionUsageMoney(
        's-1',
        { amount: 1, currency: 'USD', approximate: false, kind: 'actual-cost' },
        1,
        'regular',
        false,
      ),
    );

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(hook.result.current.actualMoney).toBeNull();
    expect(hook.result.current.totalMoney).toBeNull();
  });

  it('invalidates an old projection before applying a new spend and stays closed on refresh failure', async () => {
    vi.useFakeTimers();
    const hook = renderHook(() =>
      useSidebarSessionUsageMoney(
        's-1',
        { amount: 1, currency: 'USD', approximate: false, kind: 'actual-cost' },
        1,
        'regular',
        false,
      ),
    );
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(hook.result.current.actualMoney?.amount).toBe(1);

    estimatedSessionValueBatchFor.mockRejectedValueOnce(new Error('projection unavailable'));
    await act(async () => {
      spendListener?.({ sessionId: 's-1', totalCostUsd: 2 });
    });
    expect(hook.result.current.actualMoney).toBeNull();

    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(hook.result.current.actualMoney).toBeNull();
    expect(hook.result.current.totalMoney?.amount).toBeCloseTo(0.12);
  });

  it('keeps a refresh that arrives while a batch query is in flight', async () => {
    vi.useFakeTimers();
    let resolveFirst: ((value: unknown) => void) | undefined;
    estimatedSessionValueBatchFor
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({
        's-1': {
          projectionVersion: 1,
          estimatedValueMoney: {
            amount: 0.99,
            currency: 'USD',
            approximate: true,
            kind: 'value-estimate',
          },
          excludedActualMoney: null,
        },
      });

    const hook = renderHook(() =>
      useSidebarSessionUsageMoney(
        's-1',
        { amount: 1, currency: 'USD', approximate: false, kind: 'actual-cost' },
        1,
        'regular',
        false,
      ),
    );
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(estimatedSessionValueBatchFor).toHaveBeenCalledTimes(1);

    await act(async () => {
      turnCostListener?.({ sessionId: 's-1' });
    });
    await act(async () => {
      resolveFirst?.({
        's-1': {
          projectionVersion: 1,
          estimatedValueMoney: {
            amount: 0.12,
            currency: 'USD',
            approximate: true,
            kind: 'value-estimate',
          },
          excludedActualMoney: null,
        },
      });
      await Promise.resolve();
      await vi.runAllTimersAsync();
    });

    expect(estimatedSessionValueBatchFor).toHaveBeenCalledTimes(2);
    expect(hook.result.current.estimatedValueMoney?.amount).toBeCloseTo(0.99);
  });

  it('drops an in-flight summary after its presentation changes', async () => {
    vi.useFakeTimers();
    let resolveFirst: ((value: unknown) => void) | undefined;
    estimatedSessionValueBatchFor
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({
        's-1': {
          projectionVersion: 1,
          estimatedValueMoney: null,
          excludedActualMoney: null,
        },
      });

    const hook = renderHook(
      ({
        presentation,
        showSdkEstimate,
      }: {
        presentation: 'estimate' | 'hidden';
        showSdkEstimate: boolean;
      }) =>
        useSidebarSessionUsageMoney(
          's-1',
          { amount: 1, currency: 'USD', approximate: false, kind: 'actual-cost' },
          1,
          presentation,
          showSdkEstimate,
        ),
      { initialProps: { presentation: 'estimate', showSdkEstimate: true } },
    );
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    hook.rerender({ presentation: 'hidden', showSdkEstimate: false });
    await act(async () => {
      resolveFirst?.({
        's-1': {
          projectionVersion: 1,
          estimatedValueMoney: {
            amount: 0.42,
            currency: 'USD',
            approximate: true,
            kind: 'value-estimate',
            estimateReasons: ['sdk-estimate'],
          },
          excludedActualMoney: null,
        },
      });
      await Promise.resolve();
      await vi.runAllTimersAsync();
    });

    expect(hook.result.current.estimatedValueMoney).toBeNull();
    expect(estimatedSessionValueBatchFor).toHaveBeenCalledTimes(2);
  });

  it('refreshes first-interest cache from the latest props after a row remounts', async () => {
    vi.useFakeTimers();
    const first = renderHook(() =>
      useSidebarSessionUsageMoney(
        's-1',
        { amount: 1, currency: 'USD', approximate: false, kind: 'actual-cost' },
        1,
        'regular',
        false,
      ),
    );
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(first.result.current.actualMoney?.amount).toBe(1);
    expect(estimatedSessionValueBatchFor).toHaveBeenCalledTimes(1);
    first.unmount();

    const updated = renderHook(() =>
      useSidebarSessionUsageMoney(
        's-1',
        { amount: 2, currency: 'USD', approximate: false, kind: 'actual-cost' },
        2,
        'regular',
        false,
      ),
    );
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(updated.result.current.actualMoney?.amount).toBe(2);
    expect(estimatedSessionValueBatchFor).toHaveBeenCalledTimes(2);
    updated.unmount();

    const cleared = renderHook(() =>
      useSidebarSessionUsageMoney('s-1', null, null, 'regular', false),
    );
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(cleared.result.current.actualMoney).toBeNull();
    expect(estimatedSessionValueBatchFor).toHaveBeenCalledTimes(3);
  });

  it('refreshes a mounted remote row when reconciled session money props change', async () => {
    vi.useFakeTimers();
    const hook = renderHook(
      ({ totalMoney, totalCostUsd }) =>
        useSidebarSessionUsageMoney('remote-1', totalMoney, totalCostUsd, 'regular', false),
      {
        initialProps: {
          totalMoney: {
            amount: 1,
            currency: 'USD' as const,
            approximate: false,
            kind: 'actual-cost' as const,
          } as {
            amount: number;
            currency: 'USD';
            approximate: boolean;
            kind: 'actual-cost';
          } | null,
          totalCostUsd: 1 as number | null,
        },
      },
    );
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(hook.result.current.actualMoney?.amount).toBe(1);

    hook.rerender({
      totalMoney: {
        amount: 2,
        currency: 'USD',
        approximate: false,
        kind: 'actual-cost',
      },
      totalCostUsd: 2,
    });
    expect(hook.result.current.actualMoney).toBeNull();
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(hook.result.current.actualMoney?.amount).toBe(2);

    hook.rerender({ totalMoney: null, totalCostUsd: 3 });
    expect(hook.result.current.actualMoney).toBeNull();
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(hook.result.current.actualMoney?.amount).toBe(3);

    hook.rerender({ totalMoney: null, totalCostUsd: null });
    expect(hook.result.current.actualMoney).toBeNull();
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(hook.result.current.actualMoney).toBeNull();
    expect(estimatedSessionValueBatchFor).toHaveBeenCalledTimes(4);
  });

  it('refreshes a remote sidebar row from remote spend and turn-cost pushes', async () => {
    vi.useFakeTimers();
    const hook = renderHook(() =>
      useSidebarSessionUsageMoney(
        'remote-1',
        { amount: 1, currency: 'USD', approximate: false, kind: 'actual-cost' },
        1,
        'regular',
        false,
      ),
    );
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    await act(async () => {
      remotePushListener?.({
        deviceId: 'dev-1',
        channel: 'usage:session-spend-changed',
        payload: { sessionId: 'remote-1', totalCostUsd: 2 },
      });
    });
    expect(hook.result.current.actualMoney).toBeNull();
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(hook.result.current.actualMoney?.amount).toBe(2);

    await act(async () => {
      remotePushListener?.({
        deviceId: 'dev-1',
        channel: 'usage:message-turn-cost',
        payload: { sessionId: 'remote-1' },
      });
    });
    expect(hook.result.current.actualMoney).toBeNull();
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(hook.result.current.actualMoney?.amount).toBe(2);
    expect(estimatedSessionValueBatchFor).toHaveBeenCalledTimes(3);
  });
});
