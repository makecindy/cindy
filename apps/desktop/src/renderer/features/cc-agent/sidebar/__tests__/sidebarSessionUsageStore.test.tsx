// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const estimatedSessionValueBatchFor = vi.fn();

vi.mock('@/lib/makerTransport', () => ({
  estimatedSessionValueBatchFor: (...args: unknown[]) => estimatedSessionValueBatchFor(...args),
}));

vi.mock('@/contexts/dataOwnerGeneration', () => ({
  isDataOwnerPushCurrent: () => true,
}));

import {
  __resetSidebarSessionUsageStoreForTests,
  useSidebarSessionUsageMoney,
} from '../sidebarSessionUsageStore';

describe('useSidebarSessionUsageMoney', () => {
  let turnCostListener: ((payload: { sessionId: string }) => void) | undefined;

  beforeEach(() => {
    __resetSidebarSessionUsageStoreForTests();
    turnCostListener = undefined;
    estimatedSessionValueBatchFor.mockReset();
    estimatedSessionValueBatchFor.mockResolvedValue({
      's-1': {
        estimatedValueMoney: { amount: 0.12, currency: 'USD', approximate: true, kind: 'value-estimate' },
        excludedActualMoney: null,
      },
      's-2': {
        estimatedValueMoney: { amount: 0.34, currency: 'USD', approximate: true, kind: 'value-estimate' },
        excludedActualMoney: null,
      },
    });
    vi.stubGlobal('window', {
      electronAPI: {
        onUsageSessionSpendChanged: vi.fn(() => () => undefined),
        onUsageMessageTurnCost: vi.fn((cb: (payload: { sessionId: string }) => void) => {
          turnCostListener = cb;
          return () => undefined;
        }),
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
      useSidebarSessionUsageMoney('s-1', { amount: 1, currency: 'USD', kind: 'actual-cost' }, 1, 'regular', false),
    );
    const second = renderHook(() =>
      useSidebarSessionUsageMoney('s-2', { amount: 2, currency: 'USD', kind: 'actual-cost' }, 2, 'hidden', false),
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
          estimatedValueMoney: { amount: 0.99, currency: 'USD', approximate: true, kind: 'value-estimate' },
          excludedActualMoney: null,
        },
      });

    const hook = renderHook(() =>
      useSidebarSessionUsageMoney('s-1', { amount: 1, currency: 'USD', kind: 'actual-cost' }, 1, 'regular', false),
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
          estimatedValueMoney: { amount: 0.12, currency: 'USD', approximate: true, kind: 'value-estimate' },
          excludedActualMoney: null,
        },
      });
      await Promise.resolve();
      await vi.runAllTimersAsync();
    });

    expect(estimatedSessionValueBatchFor).toHaveBeenCalledTimes(2);
    expect(hook.result.current.estimatedValueMoney?.amount).toBeCloseTo(0.99);
  });
});
