// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import type { Schedule } from '@cindy/maker-scheduler';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RegionalMoney } from '../../../../../shared/regionalMoney';

const billingSettings = vi.hoisted(() => ({ showSdkCostForCustomProviders: true }));
const listCostSummaries = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useCustomProviderBillingSettings', () => ({
  useCustomProviderBillingSettings: () => billingSettings,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ warn: vi.fn() }),
}));

import { useScheduleCostSummaries } from '../useScheduleCostSummaries';

function estimate(
  amount: number,
  estimateReasons: RegionalMoney['estimateReasons'],
): RegionalMoney {
  return {
    amount,
    currency: 'USD',
    approximate: true,
    kind: 'value-estimate',
    estimateReasons,
  };
}

const schedule = { id: 'schedule-1' } as Schedule;

beforeEach(() => {
  billingSettings.showSdkCostForCustomProviders = true;
  listCostSummaries.mockReset();
  listCostSummaries.mockResolvedValue([
    {
      scheduleId: schedule.id,
      totalMoney: {
        amount: 1,
        currency: 'USD',
        approximate: false,
        kind: 'actual-cost',
      },
      totalEstimatedValueMoney: estimate(0.7, ['reference-price', 'sdk-estimate']),
      totalSdkEstimatedValueMoney: estimate(0.5, ['sdk-estimate']),
      sessionCount: 1,
      sessions: [
        {
          sessionId: 'session-1',
          totalMoney: {
            amount: 1,
            currency: 'USD',
            approximate: false,
            kind: 'actual-cost',
          },
          totalEstimatedValueMoney: estimate(0.7, ['reference-price', 'sdk-estimate']),
          totalSdkEstimatedValueMoney: estimate(0.5, ['sdk-estimate']),
        },
      ],
    },
  ]);
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      maker: {
        schedule: {
          listCostSummaries,
          onEvent: vi.fn(() => () => undefined),
        },
      },
      onUsageSessionSpendChanged: vi.fn(() => () => undefined),
      onUsageMessageTurnCost: vi.fn(() => () => undefined),
    },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useScheduleCostSummaries', () => {
  it('hides cached SDK estimates immediately when the preference is disabled', async () => {
    const hook = renderHook(() => useScheduleCostSummaries([schedule]));

    await waitFor(() => expect(hook.result.current.loaded).toBe(true));
    expect(
      hook.result.current.summaries.get(schedule.id)?.totalEstimatedValueMoney.amount,
    ).toBeCloseTo(0.7);

    listCostSummaries.mockRejectedValueOnce(new Error('refresh unavailable'));
    billingSettings.showSdkCostForCustomProviders = false;
    hook.rerender();

    expect(
      hook.result.current.summaries.get(schedule.id)?.totalEstimatedValueMoney.amount,
    ).toBeCloseTo(0.2);
    expect(
      hook.result.current.summaries.get(schedule.id)?.sessions?.[0]?.totalEstimatedValueMoney
        .amount,
    ).toBeCloseTo(0.2);

    await act(async () => {
      await Promise.resolve();
    });
    expect(listCostSummaries).toHaveBeenCalledTimes(1);
  });
});
