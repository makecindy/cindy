import { describe, expect, it } from 'vitest';

import {
  resolveEstimatedValueTurnCostEntry,
  shouldApplyEstimatedValueEntry,
  syncEstimatedValueCostsFromStoreSnapshot,
} from '@/hooks/useSessionEstimatedValue';
import { combineSessionUsageMoney } from '@/hooks/useSessionUsageMoney';
import type { ChatMessage } from '@/lib/makerChatStore';
import { buildTurnUsageDetails } from '../../shared/turnUsageDetails';
import type { RegionalMoney } from '../../shared/regionalMoney';
import { hasSubscriptionEstimateSource, turnEstimateAmounts } from '../../shared/turnEstimateAmounts';

function usdEstimate(amount: number): RegionalMoney {
  return {
    amount,
    currency: 'USD',
    approximate: true,
    kind: 'value-estimate',
    estimateReasons: ['subscription-value'],
  };
}

function legacyCnyEstimate(amount: number): RegionalMoney {
  return {
    amount,
    currency: 'CNY',
    approximate: true,
    kind: 'value-estimate',
    estimateReasons: ['fixed-fx', 'legacy-usd', 'subscription-value'],
  };
}

function assistantMessage(clientId: string, costUsd?: number): ChatMessage {
  return {
    clientId,
    role: 'assistant',
    content: 'ok',
    createdAt: new Date(0).toISOString(),
    ...(typeof costUsd === 'number'
      ? { turnMoney: usdEstimate(costUsd), turnCostIsEstimate: true }
      : {}),
  } as ChatMessage;
}

const GPT_DETAILS = buildTurnUsageDetails({
  inputTokens: 213_800,
  outputTokens: 6_400,
  cacheReadTokens: 1_500_000,
  cacheCreateTokens: 0,
  model: 'gpt-5.5',
});
if (!GPT_DETAILS) {
  throw new Error('expected test GPT turn usage details to be buildable');
}

describe('syncEstimatedValueCostsFromStoreSnapshot', () => {
  it('preserves DB-backed costs before chat history has loaded', () => {
    const current = new Map([['persisted', [usdEstimate(0.12)]]]);
    const result = syncEstimatedValueCostsFromStoreSnapshot(current, [], {
      messages: [],
      historyLoaded: false,
      hasMoreMessages: true,
    });

    expect(result).toBeNull();
  });

  it('clears all costs when /clear leaves an authoritative empty transcript', () => {
    const result = syncEstimatedValueCostsFromStoreSnapshot(
      new Map([
        ['persisted', [usdEstimate(0.12)]],
        ['visible', [usdEstimate(0.03)]],
      ]),
      ['visible'],
      { messages: [], historyLoaded: true, hasMoreMessages: false },
    );

    expect(result?.costs.size).toBe(0);
    expect(result?.storeClientIds).toHaveLength(0);
  });

  // Regression: a long task's "本对话" total jumped between the full history
  // value and only the loaded page whenever the chat window trimmed or reseeded
  // its oldest rows. Rows leaving the top of the window still exist in the DB;
  // only rows removed from inside the window (delete / rewind / edit) are gone.
  it.each([
    {
      name: 'keeps history costs for rows that only scrolled out of the loaded window',
      next: ['middle', 'latest', 'new-visible'],
      kept: ['hidden-history', 'oldest', 'middle', 'latest', 'new-visible'],
      removed: [],
    },
    {
      name: 'keeps every history cost when the loaded window is replaced by a newer page',
      next: ['new-visible'],
      kept: ['hidden-history', 'oldest', 'middle', 'latest', 'new-visible'],
      removed: [],
    },
    {
      name: 'removes rows deleted from inside the loaded window',
      next: ['oldest', 'latest', 'new-visible'],
      kept: ['hidden-history', 'oldest', 'latest', 'new-visible'],
      removed: ['middle'],
    },
  ])('$name', ({ next, kept, removed }) => {
    const messages = next.map((clientId) =>
      clientId === 'new-visible' ? assistantMessage(clientId, 0.04) : assistantMessage(clientId, 0.03),
    );
    const result = syncEstimatedValueCostsFromStoreSnapshot(
      new Map([
        ['hidden-history', [usdEstimate(0.12)]],
        ['oldest', [usdEstimate(0.03)]],
        ['middle', [usdEstimate(0.03)]],
        ['latest', [usdEstimate(0.03)]],
      ]),
      ['oldest', 'middle', 'latest'],
      { messages: [...messages, assistantMessage('visible-no-cost')], historyLoaded: true, hasMoreMessages: true },
    );

    expect([...(result?.costs.keys() ?? [])].sort()).toEqual([...kept].sort());
    for (const clientId of removed) expect(result?.costs.has(clientId)).toBe(false);
    expect(result?.costs.has('visible-no-cost')).toBe(false);
  });
});

describe('resolveEstimatedValueTurnCostEntry', () => {
  // PR #12622: estimates outside the loaded message window are replayed from
  // the history projection without the original billing details.
  it.each(['subscription', 'provider', 'unknown', undefined] as const)(
    'preserves the recorded legacy %s classification on history replay',
    (billingSource) => {
      const [money] = turnEstimateAmounts({
        turnCostUsd: 0.53,
        turnCostIsEstimate: true,
        turnUsageDetails: buildTurnUsageDetails({ inputTokens: 200, billingSource }),
      });
      const replay = resolveEstimatedValueTurnCostEntry({
        clientId: 'historical-estimate',
        turnMoney: money,
        turnCostIsEstimate: true,
      })?.money;
      expect(replay).toMatchObject({ amount: 0.53, currency: 'USD', approximate: true, kind: 'value-estimate' });
      expect(replay?.estimateReasons).toContain('legacy-usd');
      expect(hasSubscriptionEstimateSource(replay)).toBe(billingSource === 'subscription');
    },
  );

  // PR #12622: the session estimate keeps the subscription source and only
  // the model amount when the same turn includes a separately charged image.
  it('retains subscription value alongside a separate media charge', () => {
    const subscription = usdEstimate(0.53);
    const image: RegionalMoney = { amount: 0.22, currency: 'USD', approximate: false, kind: 'actual-cost' };
    expect(resolveEstimatedValueTurnCostEntry({
      clientId: 'image-in-subscription-turn',
      turnMoney: subscription,
      turnCostIsEstimate: true,
      turnUsageDetails: buildTurnUsageDetails({
        inputTokens: 200,
        billingSource: 'subscription',
        perModelCost: [{ model: 'model-a', money: subscription, billingSource: 'subscription' }],
        additionalCosts: [image],
      }),
    })).toEqual({ clientId: 'image-in-subscription-turn', money: subscription });
  });

  // Unit: persisted model evidence and the live segment must produce the same two values on replay.
  it('preserves the other native estimate without counting the primary model twice', () => {
    const dollars = usdEstimate(2);
    const yuan = { ...usdEstimate(7), currency: 'CNY' as const };
    const payload = { clientId: 'mixed', turnMoney: dollars, turnCostIsEstimate: true,
      turnUsageDetails: buildTurnUsageDetails({ inputTokens: 2, perModelCost: [
        { model: 'model-a', money: dollars }, { model: 'model-b', money: yuan },
      ] })! };
    expect(resolveEstimatedValueTurnCostEntry(payload)).toEqual({
      clientId: 'mixed', money: dollars, additionalEstimates: [yuan],
    });
    const snapshot = { messages: [{ ...assistantMessage('mixed'), ...payload }], historyLoaded: true, hasMoreMessages: false };
    const first = syncEstimatedValueCostsFromStoreSnapshot(new Map(), [], snapshot)!;
    const replay = syncEstimatedValueCostsFromStoreSnapshot(first.costs, first.storeClientIds, snapshot)!;
    expect(replay.costs.get('mixed')).toEqual([dollars, yuan]);
  });

  it('corrects realtime stale full-cache estimates before merging session value', () => {
    expect(
      resolveEstimatedValueTurnCostEntry({
        clientId: 'stale',
        turnMoney: usdEstimate(8.76),
        turnCostIsEstimate: true,
        turnUsageDetails: GPT_DETAILS,
      })?.money.amount,
    ).toBeCloseTo(2.011);
  });

  it('corrects stale legacy estimates after their CN fixed-FX projection', () => {
    expect(
      resolveEstimatedValueTurnCostEntry({
        clientId: 'stale-cn',
        turnMoney: legacyCnyEstimate(8.76 * 6.7),
        turnCostIsEstimate: true,
        turnUsageDetails: GPT_DETAILS,
      })?.money.amount,
    ).toBeCloseTo(2.011 * 6.7);
  });

  it('preserves realtime live pricing estimates that do not match stale full-cache formulas', () => {
    expect(
      resolveEstimatedValueTurnCostEntry({
        clientId: 'live',
        turnMoney: usdEstimate(3.14),
        turnCostIsEstimate: true,
        turnUsageDetails: GPT_DETAILS,
      })?.money.amount,
    ).toBe(3.14);
  });

  it('ignores non-estimate realtime entries', () => {
    expect(
      resolveEstimatedValueTurnCostEntry({
        clientId: 'api-cost',
        turnCostUsd: 0.42,
        turnCostIsEstimate: false,
        turnUsageDetails: GPT_DETAILS,
      }),
    ).toBeNull();
  });
});

describe('shouldApplyEstimatedValueEntry', () => {
  it('ignores delayed entries after an authoritative /clear snapshot', () => {
    expect(
      shouldApplyEstimatedValueEntry(
        { messages: [], historyLoaded: true, hasMoreMessages: false },
        'stale-assistant',
        true,
      ),
    ).toBe(false);
  });

  it('allows entries for visible messages after a clear', () => {
    expect(
      shouldApplyEstimatedValueEntry(
        {
          messages: [assistantMessage('new-assistant')],
          historyLoaded: true,
          hasMoreMessages: false,
        },
        'new-assistant',
        true,
      ),
    ).toBe(true);
  });

  it('keeps ignoring stale entries after a new transcript starts', () => {
    expect(
      shouldApplyEstimatedValueEntry(
        {
          messages: [assistantMessage('new-assistant')],
          historyLoaded: true,
          hasMoreMessages: false,
        },
        'stale-assistant',
        true,
      ),
    ).toBe(false);
  });

  it('allows DB-backed entries before any clear marker exists', () => {
    expect(
      shouldApplyEstimatedValueEntry(
        { messages: [], historyLoaded: false, hasMoreMessages: true },
        'persisted-history',
        false,
      ),
    ).toBe(true);
  });
});

describe('combineSessionUsageMoney', () => {
  it.each([
    null,
    { amount: 0, currency: 'CNY', approximate: false, kind: 'actual-cost' } as RegionalMoney,
  ])(
    'shows USD subscription value when actual cost is absent or a zero CNY placeholder: %j',
    (actual) => {
      const estimate = usdEstimate(0.67052);
      const result = combineSessionUsageMoney(actual, estimate);
      expect(result.estimatedValueMoney).toEqual(estimate);
      expect(result.totalMoney).toMatchObject({
        amount: 0.67052,
        currency: 'USD',
        kind: 'value-estimate',
      });
    },
  );

  it('does not display a total before either source has a positive amount', () => {
    expect(combineSessionUsageMoney(null, null).totalMoney).toBeNull();
    expect(
      combineSessionUsageMoney(
        { amount: 0, currency: 'CNY', approximate: false, kind: 'actual-cost' },
        usdEstimate(0),
      ).totalMoney,
    ).toBeNull();
  });

  it('adds CN actual cost and subscription value into one stable session total', () => {
    const result = combineSessionUsageMoney(
      {
        amount: 0.393092,
        currency: 'CNY',
        approximate: false,
        kind: 'actual-cost',
      },
      {
        amount: 0.866712,
        currency: 'CNY',
        approximate: true,
        kind: 'value-estimate',
        estimateReasons: ['subscription-value', 'reference-price'],
      },
    );

    expect(result.totalMoney).toMatchObject({
      currency: 'CNY',
      approximate: true,
      kind: 'actual-cost',
    });
    expect(result.totalMoney?.amount).toBeCloseTo(1.259804, 10);
  });

  it.each([0, 1])('keeps ambiguous legacy USD hidden against a CNY balance of %s', (amount) => {
    const result = combineSessionUsageMoney(
      { amount, currency: 'CNY', approximate: false, kind: 'actual-cost' },
      { ...usdEstimate(1), estimateReasons: ['legacy-usd', 'subscription-value'] },
    );
    expect(result.estimatedValueMoney).toBeNull();
    if (amount > 0) expect(result.totalMoney).toMatchObject({ amount, currency: 'CNY' });
    else expect(result.totalMoney).toBeNull();
  });

  it('preserves legacy USD estimates within a matching USD ledger', () => {
    const result = combineSessionUsageMoney(
      { amount: 0, currency: 'USD', approximate: false, kind: 'actual-cost' },
      { ...usdEstimate(1), estimateReasons: ['legacy-usd', 'subscription-value'] },
    );
    expect(result.totalMoney).toMatchObject({ amount: 1, currency: 'USD' });
  });

  it('preserves different currencies separately without inventing a combined total', () => {
    const result = combineSessionUsageMoney(
      {
        amount: 1,
        currency: 'CNY',
        approximate: false,
        kind: 'actual-cost',
      },
      {
        amount: 1,
        currency: 'USD',
        approximate: true,
        kind: 'value-estimate',
        estimateReasons: ['reference-price', 'subscription-value'],
      },
    );

    expect(result.estimatedValueMoney).toMatchObject({ amount: 1, currency: 'USD' });
    expect(result.actualMoney).toMatchObject({ amount: 1, currency: 'CNY' });
    expect(result.totalMoney).toBeNull();
  });
});
