import { describe, expect, it } from 'vitest';

import type { ModelUsageDeltaEntry } from '../modelUsageDelta';
import {
  buildClaudeTurnUsageDetails,
  computeGatewayTurnCost,
  estimateClaudeSubscriptionTurnValue,
  getCodexBudgetEffectiveCostMultiplier,
  isAnthropicModel,
  normalizeModelIdForPricing,
  resolveClaudeTurnCostSinks,
  resolveTurnCost,
  type ResolvedModelCost,
  type TurnPricingContext,
} from '../turnCostCalculator';
import type {
  ModelPriceQuote,
  ModelPricingCatalog,
  RegionalMoney,
} from '../../../shared/regionalMoney';

const XD_GATEWAY: TurnPricingContext = {
  providerId: 'xd',
  billingRoute: 'xd-gateway',
};
const PROVIDER_API: TurnPricingContext = {
  providerId: 'anthropic',
  billingRoute: 'provider-api',
};
const SUBSCRIPTION: TurnPricingContext = {
  providerId: 'anthropic',
  billingRoute: 'subscription',
};

function quote(
  modelId: string,
  inputPerMtok: number,
  outputPerMtok: number,
  overrides: Partial<ModelPriceQuote> = {},
): ModelPriceQuote {
  return {
    providerId: 'xd',
    modelId,
    currency: 'USD',
    source: 'gateway',
    approximate: false,
    inputPerMtok,
    outputPerMtok,
    ...overrides,
  };
}

function catalog(...quotes: ModelPriceQuote[]): ModelPricingCatalog {
  const result: ModelPricingCatalog = {};
  for (const item of quotes) {
    (result[item.providerId] ??= {})[item.modelId] = item;
  }
  return result;
}

function usdMoney(
  amount: number,
  kind: RegionalMoney['kind'] = 'actual-cost',
): RegionalMoney {
  return {
    amount,
    currency: 'USD',
    approximate: kind === 'value-estimate',
    kind,
    ...(kind === 'value-estimate'
      ? { estimateReasons: ['subscription-value'] }
      : {}),
  };
}

function delta(
  model: string,
  values: Partial<ModelUsageDeltaEntry> = {},
): ModelUsageDeltaEntry {
  return {
    model,
    costUsdDelta: 0,
    inputTokensDelta: 0,
    outputTokensDelta: 0,
    cacheReadTokensDelta: 0,
    cacheCreateTokensDelta: 0,
    ...values,
  };
}

function resolvedModel(
  model: string,
  deltas: Partial<ResolvedModelCost['deltas']> = {},
  money: RegionalMoney | null = null,
): ResolvedModelCost {
  return {
    model,
    money,
    source: 'subscription',
    deltas: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
      ...deltas,
    },
  };
}

describe('model id and route helpers', () => {
  it('normalizes model suffixes without dropping provider prefixes', () => {
    expect(normalizeModelIdForPricing('gpt-5.5[1m]')).toBe('gpt-5.5');
    expect(normalizeModelIdForPricing('codex/gpt-5.5[1m]')).toBe('codex/gpt-5.5');
    expect(normalizeModelIdForPricing('  claude-opus-4-8  ')).toBe('claude-opus-4-8');
    expect(normalizeModelIdForPricing('')).toBe('unknown');
    expect(normalizeModelIdForPricing(null)).toBe('unknown');
  });

  it('recognizes Anthropic families and applies codex budget discount exactly once', () => {
    expect(isAnthropicModel('claude-sonnet-4-6')).toBe(true);
    expect(isAnthropicModel('sonnet')).toBe(true);
    expect(isAnthropicModel('gpt-5.5')).toBe(false);
    expect(getCodexBudgetEffectiveCostMultiplier('codex/gpt-5.5')).toBe(0.15);
    expect(getCodexBudgetEffectiveCostMultiplier('gpt-5.5')).toBe(1);
  });
});

describe('computeGatewayTurnCost', () => {
  it('returns null without a quote and uses input price for missing cache tiers', () => {
    const tokens = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheCreateTokens: 1_000_000,
    };
    expect(computeGatewayTurnCost(tokens, undefined)).toBeNull();
    expect(computeGatewayTurnCost(tokens, quote('m', 2, 8))).toBe(14);
  });

  it('uses explicit cache read/write prices when present', () => {
    expect(computeGatewayTurnCost(
      {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
        cacheCreateTokens: 1_000_000,
      },
      quote('m', 2, 8, {
        cacheReadPerMtok: 0.2,
        cacheCreatePerMtok: 2.5,
      }),
    )).toBeCloseTo(12.7);
  });
});

describe('resolveTurnCost', () => {
  it('XD route uses provider-scoped gateway pricing for every model family', () => {
    const pricing = catalog(
      quote('gpt-5.5', 2, 8),
      quote('claude-opus-4-8', 5, 25),
    );
    const gpt = resolveTurnCost({
      rawModel: 'gpt-5.5[1m]',
      tokens: {
        inputTokens: 1_099_022,
        outputTokens: 2_319,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
      },
      sdkCostDelta: 5.553085,
      pricing,
      context: XD_GATEWAY,
    });
    const claude = resolveTurnCost({
      rawModel: 'claude-opus-4-8[1m]',
      tokens: {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
      },
      sdkCostDelta: 99,
      pricing,
      context: XD_GATEWAY,
    });

    expect(gpt.source).toBe('gateway');
    expect(gpt.money?.amount).toBeCloseTo(2.216596, 5);
    expect(claude.source).toBe('gateway');
    expect(claude.money?.amount).toBe(5);
  });

  it('XD missing price falls back to the SDK number instead of dropping the turn', () => {
    const result = resolveTurnCost({
      rawModel: 'unknown-model',
      tokens: {
        inputTokens: 1_000,
        outputTokens: 100,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
      },
      sdkCostDelta: 1.23,
      pricing: {},
      context: XD_GATEWAY,
    });
    expect(result.source).toBe('sdk-fallback');
    expect(result.money).toMatchObject({
      amount: 1.23,
      currency: 'USD',
      kind: 'actual-cost',
    });
  });

  it('XD missing price fallback applies the codex budget multiplier and keeps USD', () => {
    const zeroTokens = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
    };
    const codexFallback = resolveTurnCost({
      rawModel: 'codex/gpt-5.5',
      tokens: zeroTokens,
      sdkCostDelta: 10,
      pricing: null,
      context: XD_GATEWAY,
    });
    expect(codexFallback.source).toBe('sdk-fallback');
    expect(codexFallback.money).toMatchObject({
      amount: 1.5,
      currency: 'USD',
      approximate: false,
      kind: 'actual-cost',
    });
  });

  it('XD missing price with no SDK cost still resolves to null money', () => {
    const result = resolveTurnCost({
      rawModel: 'unknown-model',
      tokens: {
        inputTokens: 1_000,
        outputTokens: 100,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
      },
      pricing: {},
      context: XD_GATEWAY,
    });
    expect(result.source).toBe('sdk-fallback');
    expect(result.money).toBeNull();
  });

  it('provider API route keeps the SDK USD fact exact — no regional conversion', () => {
    const result = resolveTurnCost({
      rawModel: 'claude-opus-4-8',
      tokens: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
      },
      sdkCostDelta: 3,
      pricing: catalog(quote('claude-opus-4-8', 99, 99)),
      context: PROVIDER_API,
    });
    expect(result.source).toBe('sdk');
    expect(result.money).toEqual({
      amount: 3,
      currency: 'USD',
      approximate: false,
      kind: 'actual-cost',
    });
  });

  it('codex provider SDK fallback applies the 15% multiplier once', () => {
    const result = resolveTurnCost({
      rawModel: 'codex/gpt-5.5',
      tokens: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
      },
      sdkCostDelta: 10,
      pricing: null,
      context: PROVIDER_API,
    });
    expect(result.money?.amount).toBe(1.5);
  });

  it('subscription routes and explicit subscription model prefixes never become actual cost', () => {
    const byRoute = resolveTurnCost({
      rawModel: 'claude-opus-4-8',
      tokens: {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
      },
      sdkCostDelta: 5,
      pricing: null,
      context: SUBSCRIPTION,
    });
    const byPrefix = resolveTurnCost({
      rawModel: 'chatgpt/gpt-5.5',
      tokens: {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
      },
      sdkCostDelta: 5,
      pricing: null,
      context: PROVIDER_API,
    });
    expect(byRoute).toMatchObject({ source: 'subscription', money: null });
    expect(byPrefix).toMatchObject({ source: 'subscription', money: null });
  });
});

describe('resolveClaudeTurnCostSinks', () => {
  it('sums structured per-model money using one billing route', () => {
    const pricing = catalog(
      quote('claude-opus-4-8', 5, 25),
      quote('gpt-5.5', 2, 8),
    );
    const result = resolveClaudeTurnCostSinks(
      [
        delta('claude-opus-4-8[1m]', { inputTokensDelta: 1_000_000 }),
        delta('gpt-5.5[1m]', { inputTokensDelta: 1_000_000 }),
      ],
      pricing,
      XD_GATEWAY,
    );
    expect(result.turnMoney?.amount).toBe(7);
    expect(result.perModel.map((item) => item.money?.amount)).toEqual([5, 2]);
    expect(result.perModel.map((item) => item.source)).toEqual(['gateway', 'gateway']);
  });

  it('skips the USD SDK fallback under a non-USD catalog — no reliable price, no money', () => {
    const pricing = catalog(
      quote('claude-opus-4-8', 5, 25, { currency: 'CNY' }),
    );
    const result = resolveClaudeTurnCostSinks(
      [
        delta('claude-opus-4-8', { inputTokensDelta: 1_000_000 }),
        delta('unquoted-model', { costUsdDelta: 2 }),
      ],
      pricing,
      XD_GATEWAY,
    );
    expect(result.turnMoney).toMatchObject({
      amount: 5,
      currency: 'CNY',
      kind: 'actual-cost',
    });
    expect(result.perModel.map((item) => item.money)).toEqual([
      expect.objectContaining({ currency: 'CNY', amount: 5 }),
      null,
    ]);
    expect(result.perModel.map((item) => item.source)).toEqual([
      'gateway',
      'sdk-fallback',
    ]);
  });

  it('returns null total when the route is subscription-only', () => {
    const result = resolveClaudeTurnCostSinks(
      [delta('claude-opus-4-8', { costUsdDelta: 4 })],
      null,
      SUBSCRIPTION,
    );
    expect(result.turnMoney).toBeNull();
    expect(result.perModel[0]).toMatchObject({
      source: 'subscription',
      money: null,
    });
  });
});

describe('subscription value and usage details', () => {
  it('estimates Anthropic subscription value from USD reference pricing', () => {
    const value = estimateClaudeSubscriptionTurnValue([
      resolvedModel('claude-opus-4-8', {
        inputTokens: 1_000_000,
        outputTokens: 200_000,
      }),
    ]);
    expect(value).toMatchObject({
      amount: 10,
      currency: 'USD',
      approximate: true,
      kind: 'value-estimate',
    });
  });

  it('does not estimate non-Anthropic, already-costed, unknown, or zero-token entries', () => {
    expect(estimateClaudeSubscriptionTurnValue([
      resolvedModel('gpt-5.5', { inputTokens: 1_000_000 }),
      resolvedModel(
        'claude-opus-4-8',
        { inputTokens: 1_000_000 },
        usdMoney(1),
      ),
      resolvedModel('claude-unknown-9', { inputTokens: 1_000_000 }),
    ])).toBeNull();
    expect(estimateClaudeSubscriptionTurnValue(
      [resolvedModel('claude-opus-4-8')],
    )).toBeNull();
  });

  it('builds token totals and structured per-model costs from model deltas', () => {
    const deltas = [
      delta('claude-opus-4-8', {
        inputTokensDelta: 100,
        outputTokensDelta: 800,
        cacheReadTokensDelta: 1_000,
      }),
      delta('claude-haiku-4-5', {
        inputTokensDelta: 33,
        outputTokensDelta: 9_099,
        cacheCreateTokensDelta: 250,
      }),
    ];
    const details = buildClaudeTurnUsageDetails(
      { input_tokens: 1, output_tokens: 2 },
      deltas,
      'fallback',
      [
        resolvedModel('claude-opus-4-8', {}, usdMoney(0.94)),
        resolvedModel('claude-haiku-4-5', {}, usdMoney(0.8)),
      ],
    );
    expect(details).toMatchObject({
      inputTokens: 133,
      outputTokens: 9_899,
      cacheReadTokens: 1_000,
      cacheCreateTokens: 250,
      models: ['claude-opus-4-8', 'claude-haiku-4-5'],
    });
    expect(details?.perModelCost).toEqual([
      { model: 'claude-opus-4-8', money: usdMoney(0.94) },
      { model: 'claude-haiku-4-5', money: usdMoney(0.8) },
    ]);
  });
});
