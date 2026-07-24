import { describe, expect, it } from 'vitest';

import {
  resolveEstimatedValueTurnCostEntry,
  shouldApplyEstimatedValueEntry,
  syncEstimatedValueCostsFromStoreSnapshot,
} from '@/hooks/useSessionEstimatedValue';
import type { ChatMessage } from '@/lib/makerChatStore';
import { buildTurnUsageDetails } from '../../shared/turnUsageDetails';
import type { RegionalMoney } from '../../shared/regionalMoney';

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

function assistantMessage(
  clientId: string,
  costUsd?: number,
): ChatMessage {
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
    const current = new Map([['persisted', usdEstimate(0.12)]]);
    const result = syncEstimatedValueCostsFromStoreSnapshot(
      current,
      new Set(),
      { messages: [], historyLoaded: false, hasMoreMessages: true },
    );

    expect(result).toBeNull();
  });

  it('clears all costs when /clear leaves an authoritative empty transcript', () => {
    const result = syncEstimatedValueCostsFromStoreSnapshot(
      new Map([
        ['persisted', usdEstimate(0.12)],
        ['visible', usdEstimate(0.03)],
      ]),
      new Set(['visible']),
      { messages: [], historyLoaded: true, hasMoreMessages: false },
    );

    expect(result?.costs.size).toBe(0);
    expect(result?.storeClientIds.size).toBe(0);
  });

  it('removes stale visible ids while keeping DB-only hidden history costs', () => {
    const result = syncEstimatedValueCostsFromStoreSnapshot(
      new Map([
        ['hidden-history', usdEstimate(0.12)],
        ['old-visible', usdEstimate(0.03)],
      ]),
      new Set(['old-visible']),
      {
        messages: [
          assistantMessage('new-visible', 0.04),
          assistantMessage('visible-no-cost'),
        ],
        historyLoaded: true,
        hasMoreMessages: true,
      },
    );

    expect(result?.costs.get('hidden-history')?.amount).toBe(0.12);
    expect(result?.costs.get('new-visible')?.amount).toBe(0.04);
    expect(result?.costs.has('old-visible')).toBe(false);
    expect(result?.costs.has('visible-no-cost')).toBe(false);
  });
});

describe('resolveEstimatedValueTurnCostEntry', () => {
  it('corrects realtime stale full-cache estimates before merging session value', () => {
    expect(resolveEstimatedValueTurnCostEntry({
      clientId: 'stale',
      turnMoney: usdEstimate(8.76),
      turnCostIsEstimate: true,
      turnUsageDetails: GPT_DETAILS,
    })?.money.amount).toBeCloseTo(2.011);
  });

  it('corrects stale legacy estimates after their CN fixed-FX projection', () => {
    expect(resolveEstimatedValueTurnCostEntry({
      clientId: 'stale-cn',
      turnMoney: legacyCnyEstimate(8.76 * 6.7),
      turnCostIsEstimate: true,
      turnUsageDetails: GPT_DETAILS,
    })?.money.amount).toBeCloseTo(2.011 * 6.7);
  });

  it('preserves realtime live pricing estimates that do not match stale full-cache formulas', () => {
    expect(resolveEstimatedValueTurnCostEntry({
      clientId: 'live',
      turnMoney: usdEstimate(3.14),
      turnCostIsEstimate: true,
      turnUsageDetails: GPT_DETAILS,
    })?.money.amount).toBe(3.14);
  });

  it('ignores non-estimate realtime entries', () => {
    expect(resolveEstimatedValueTurnCostEntry({
      clientId: 'api-cost',
      turnCostUsd: 0.42,
      turnCostIsEstimate: false,
      turnUsageDetails: GPT_DETAILS,
    })).toBeNull();
  });
});

describe('shouldApplyEstimatedValueEntry', () => {
  it('ignores delayed entries after an authoritative /clear snapshot', () => {
    expect(shouldApplyEstimatedValueEntry(
      { messages: [], historyLoaded: true, hasMoreMessages: false },
      'stale-assistant',
      true,
    )).toBe(false);
  });

  it('allows entries for visible messages after a clear', () => {
    expect(shouldApplyEstimatedValueEntry(
      {
        messages: [assistantMessage('new-assistant')],
        historyLoaded: true,
        hasMoreMessages: false,
      },
      'new-assistant',
      true,
    )).toBe(true);
  });

  it('keeps ignoring stale entries after a new transcript starts', () => {
    expect(shouldApplyEstimatedValueEntry(
      {
        messages: [assistantMessage('new-assistant')],
        historyLoaded: true,
        hasMoreMessages: false,
      },
      'stale-assistant',
      true,
    )).toBe(false);
  });

  it('allows DB-backed entries before any clear marker exists', () => {
    expect(shouldApplyEstimatedValueEntry(
      { messages: [], historyLoaded: false, hasMoreMessages: true },
      'persisted-history',
      false,
    )).toBe(true);
  });
});
