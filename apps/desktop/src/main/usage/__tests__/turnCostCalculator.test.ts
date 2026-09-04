import { describe, expect, it } from 'vitest';
import { BUNDLED_CATALOG } from '@cindy/model-providers';
import { subscriptionDirectPriceQuote } from '../../../shared/modelPriceQuote';

import type { ModelUsageDeltaEntry } from '../modelUsageDelta';
import { __resetActiveLedgerCurrencyForTesting, setActiveLedgerCurrency } from '../ledgerCurrency';
import {
  billingRouteForExplicitProvider,
  buildClaudeTurnUsageDetails,
  computePriceQuoteTurnMoney,
  computeGatewaySegmentedTurnCost,
  computeGatewayTurnCost,
  estimateClaudeSubscriptionTurnValue,
  isAnthropicModel,
  normalizeModelIdForPricing,
  normalizeTurnUsageSegments,
  resolveClaudeTurnCostSinks,
  resolveTurnCost,
  type ResolvedModelCost,
  type TurnPricingContext,
} from '../turnCostCalculator';
import {
  type ModelPriceQuote,
  type ModelPricingCatalog,
  type RegionalMoney,
} from '../../../shared/regionalMoney';

const XD_GATEWAY: TurnPricingContext = {
  providerId: 'xd',
  billingRoute: 'xd-gateway',
  region: 'global',
};
const XD_GATEWAY_CN: TurnPricingContext = {
  providerId: 'xd',
  billingRoute: 'xd-gateway',
  region: 'cn',
};
const PROVIDER_API: TurnPricingContext = {
  providerId: 'anthropic',
  billingRoute: 'provider-api',
  region: 'global',
};
const SUBSCRIPTION: TurnPricingContext = {
  providerId: 'anthropic',
  billingRoute: 'subscription',
  region: 'global',
};

describe('Astra subscription reference estimates', () => {
  const astra = subscriptionDirectPriceQuote(
    'chatgpt/gpt-6-astra', BUNDLED_CATALOG.modelRegistry, 'codex', '2026-09-04',
  );
  const tokens = { inputTokens: 50_000, outputTokens: 100, cacheReadTokens: 200_000, cacheCreateTokens: 22_000 };

  it('uses the declared Fast tariff for native priority segments, including cache writes', () => {
    expect(astra?.source).toBe('subscription-reference');
    expect(computeGatewayTurnCost(tokens, astra)).toBeCloseTo(0.98);
    expect(computeGatewayTurnCost(tokens, astra, 'priority')).toBeCloseTo(1.96);
    expect(computeGatewayTurnCost(tokens, astra, 'fast')).toBeCloseTo(1.96);
    expect(computeGatewaySegmentedTurnCost([
      { ...tokens, priceVariant: 'standard' },
      { ...tokens, priceVariant: 'priority' },
    ], astra)).toBeCloseTo(2.94);
  });

  it('keeps the subscription reference window bound for both tariffs', () => {
    const expanded = { ...tokens, inputTokens: tokens.inputTokens + 1 };
    expect(computeGatewayTurnCost(expanded, astra)).toBeNull();
    expect(computeGatewayTurnCost(expanded, astra, 'priority')).toBeNull();
  });

  it('does not borrow standard cache-write prices for an incomplete reference Fast tariff', () => {
    expect(astra?.priority).toBeDefined();
    const incomplete = { ...astra!, priority: { ...astra!.priority, cacheCreatePerMtok: undefined, inputTokenPriceBands: undefined } };
    expect(computeGatewayTurnCost(tokens, incomplete, 'priority')).toBeNull();
  });
});

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

function usdMoney(amount: number, kind: RegionalMoney['kind'] = 'actual-cost'): RegionalMoney {
  return {
    amount,
    currency: 'USD',
    approximate: kind === 'value-estimate',
    kind,
    ...(kind === 'value-estimate' ? { estimateReasons: ['subscription-value'] } : {}),
  };
}

function delta(model: string, values: Partial<ModelUsageDeltaEntry> = {}): ModelUsageDeltaEntry {
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
  it('uses provider access semantics for explicit billing routes', () => {
    expect(billingRouteForExplicitProvider('openai', 'subscription')).toBe('subscription');
    expect(billingRouteForExplicitProvider('xai', 'subscription')).toBe('subscription');
    expect(billingRouteForExplicitProvider('anthropic', undefined)).toBe('subscription');
    expect(billingRouteForExplicitProvider('xd', 'managed')).toBe('xd-gateway');
    expect(billingRouteForExplicitProvider('custom-api', 'api')).toBe('provider-api');
    expect(billingRouteForExplicitProvider('custom-api', undefined)).toBe('provider-api');
    expect(billingRouteForExplicitProvider(null, null)).toBeNull();
  });

  it('normalizes model suffixes without dropping provider prefixes', () => {
    expect(normalizeModelIdForPricing('gpt-5.5[1m]')).toBe('gpt-5.5');
    expect(normalizeModelIdForPricing('codex/gpt-5.5[1m]')).toBe('codex/gpt-5.5');
    expect(normalizeModelIdForPricing('  claude-opus-4-8  ')).toBe('claude-opus-4-8');
    expect(normalizeModelIdForPricing('')).toBe('unknown');
    expect(normalizeModelIdForPricing(null)).toBe('unknown');
  });

  it('recognizes Anthropic families', () => {
    expect(isAnthropicModel('claude-sonnet-4-6')).toBe(true);
    expect(isAnthropicModel('sonnet')).toBe(true);
    expect(isAnthropicModel('gpt-5.5')).toBe(false);
  });

  it('keeps provider-reported cost-only segments', () => {
    expect(
      normalizeTurnUsageSegments([
        {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreateTokens: 0,
          costUsd: 0.25,
        },
      ]),
    ).toEqual([
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, costUsd: 0.25 },
    ]);
  });
});

describe('computeGatewayTurnCost', () => {
  it('returns null without a quote or a price for every used token bucket', () => {
    const tokens = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheCreateTokens: 1_000_000,
    };
    expect(computeGatewayTurnCost(tokens, undefined)).toBeNull();
    expect(computeGatewayTurnCost(tokens, quote('m', 2, 8))).toBeNull();
  });

  it('uses explicit cache read/write prices when present', () => {
    expect(
      computeGatewayTurnCost(
        {
          inputTokens: 1_000_000,
          outputTokens: 1_000_000,
          cacheReadTokens: 1_000_000,
          cacheCreateTokens: 1_000_000,
        },
        quote('m', 2, 8, { cacheReadPerMtok: 0.2, cacheCreatePerMtok: 2.5 }),
      ),
    ).toBeCloseTo(12.7);
  });

  it('uses the matching context-length band for all token classes', () => {
    expect(
      computeGatewayTurnCost(
        {
          inputTokens: 210_000,
          outputTokens: 10_000,
          cacheReadTokens: 20_000,
          cacheCreateTokens: 10_000,
        },
        quote('m', 2, 8, {
          cacheReadPerMtok: 0.2,
          cacheCreatePerMtok: 2.5,
          inputTokenPriceBands: [
            {
              minInputTokens: 200_001,
              inputPerMtok: 4,
              outputPerMtok: 12,
              cacheReadPerMtok: 0.4,
              cacheCreatePerMtok: 5,
            },
          ],
        }),
      ),
    ).toBeCloseTo(1.018);
  });

  it('does not extend a bounded provider reference beyond its published interval', () => {
    const boundedReference = quote('grok-code-fast', 0.2, 1.5, {
      providerId: 'xai',
      source: 'provider-reference',
      approximate: true,
      inputTokenPriceBands: [
        { minInputTokens: 0, maxInputTokens: 200_000, inputPerMtok: 0.2, outputPerMtok: 1.5 },
      ],
    });

    expect(
      computeGatewayTurnCost(
        { inputTokens: 199_999, outputTokens: 1, cacheReadTokens: 0, cacheCreateTokens: 0 },
        boundedReference,
      ),
    ).not.toBeNull();
    expect(
      computeGatewayTurnCost(
        { inputTokens: 200_000, outputTokens: 1, cacheReadTokens: 0, cacheCreateTokens: 0 },
        boundedReference,
      ),
    ).toBeNull();
  });

  it('selects long-context bands per request instead of from the turn aggregate', () => {
    const price = quote('m', 5, 30, {
      cacheReadPerMtok: 0.5,
      inputTokenPriceBands: [
        { minInputTokens: 272_001, inputPerMtok: 10, outputPerMtok: 45, cacheReadPerMtok: 1 },
      ],
    });
    const tenRequests = Array.from({ length: 10 }, (_, index) => ({
      id: `request-${index}`,
      inputTokens: 50_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
    }));
    expect(computeGatewaySegmentedTurnCost(tenRequests, price)).toBe(2.5);
    expect(
      computeGatewaySegmentedTurnCost(
        [{ inputTokens: 500_000, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 }],
        price,
      ),
    ).toBe(5);
  });

  it('replays the audited Codex turn as 92 baseline requests for $1.3124601', () => {
    const price = quote('codex/gpt-5.6-sol', 5, 30, {
      cacheReadPerMtok: 0.5,
      costDiscount: 0.85,
      inputTokenPriceBands: [
        { minInputTokens: 272_001, inputPerMtok: 10, outputPerMtok: 45, cacheReadPerMtok: 1 },
      ],
    });
    const segments = Array.from({ length: 92 }, (_, index) => ({
      inputTokens: 7_987 + (index < 68 ? 1 : 0),
      cacheReadTokens: 86_234 + (index < 40 ? 1 : 0),
      outputTokens: 401 + (index < 61 ? 1 : 0),
      cacheCreateTokens: 0,
    }));
    const money = computePriceQuoteTurnMoney(
      {
        inputTokens: 734_872,
        cacheReadTokens: 7_933_568,
        outputTokens: 36_953,
        cacheCreateTokens: 0,
      },
      price,
      'USD',
      segments,
    );
    expect(money?.amount).toBeCloseTo(1.3124601, 9);
  });

  it('uses priority prices for Fast requests and refuses unsupported batch pricing', () => {
    const price = quote('m', 5, 30, {
      cacheReadPerMtok: 0.5,
      cacheCreatePerMtok: 6.25,
      priority: { inputPerMtok: 10, outputPerMtok: 60, cacheReadPerMtok: 1 },
    });
    const tokens = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheCreateTokens: 1_000_000,
    };
    expect(computeGatewayTurnCost(tokens, price, 'priority')).toBe(77.25);
    expect(computeGatewayTurnCost(tokens, price, 'fast')).toBe(77.25);
    expect(computeGatewayTurnCost(tokens, price, 'batch')).toBeNull();
  });
});

describe('computePriceQuoteTurnMoney', () => {
  const tokens = {
    inputTokens: 1_000_000,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
  };

  it('only marks subscription estimates with the subscription-value reason', () => {
    expect(
      computePriceQuoteTurnMoney(
        tokens,
        quote('subscription-model', 2, 10, { source: 'subscription-reference', approximate: true }),
        'USD',
      )?.estimateReasons,
    ).toEqual(['subscription-value', 'reference-price']);
    for (const source of ['provider-reference', 'user-override'] as const) {
      expect(
        computePriceQuoteTurnMoney(
          tokens,
          quote('reference-model', 2, 10, { source, approximate: true }),
          'USD',
        )?.estimateReasons,
      ).toEqual(['reference-price']);
    }
  });

  it('estimates SuperGrok token value from xAI reference prices including cache reads', () => {
    const money = computePriceQuoteTurnMoney(
      {
        inputTokens: 179_300,
        outputTokens: 9_300,
        cacheReadTokens: 1_600_000,
        cacheCreateTokens: 0,
      },
      quote('grok-4.6', 2, 6, {
        providerId: 'xai',
        source: 'subscription-reference',
        approximate: true,
        cacheReadPerMtok: 0.5,
      }),
      'USD',
    );
    // 179.3k * $2 + 9.3k * $6 + 1.6M * $0.50 = $0.3586 + $0.0558 + $0.80
    expect(money).toMatchObject({
      amount: 1.2144,
      currency: 'USD',
      approximate: true,
      kind: 'value-estimate',
    });
    expect(money?.estimateReasons).toEqual(['subscription-value', 'reference-price']);
  });
});

describe('resolveTurnCost', () => {
  it('XD route uses provider-scoped gateway pricing for every model family', () => {
    const pricing = catalog(quote('gpt-5.5', 2, 8), quote('claude-opus-4-8', 5, 25));
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
      tokens: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 },
      sdkCostDelta: 99,
      pricing,
      context: XD_GATEWAY,
    });

    expect(gpt.source).toBe('gateway');
    expect(gpt.money?.amount).toBeCloseTo(2.216596, 5);
    expect(claude.source).toBe('gateway');
    expect(claude.money?.amount).toBe(5);
  });

  it('does not fall back from a missing codex budget SKU to the bare model price', () => {
    const result = resolveTurnCost({
      rawModel: 'codex/gpt-5.6-sol',
      tokens: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 },
      pricing: catalog(quote('gpt-5.6-sol', 5, 30, { costDiscount: 0.4 })),
      context: XD_GATEWAY,
    });
    expect(result.source).toBe('sdk-fallback');
    expect(result.money).toBeNull();
  });

  it('does not present an unquoted Gateway SDK estimate as actual spend', () => {
    __resetActiveLedgerCurrencyForTesting();
    const result = resolveTurnCost({
      rawModel: 'unknown-model',
      tokens: { inputTokens: 1_000, outputTokens: 100, cacheReadTokens: 0, cacheCreateTokens: 0 },
      sdkCostDelta: 1.23,
      pricing: {},
      context: XD_GATEWAY,
    });
    expect(result.source).toBe('sdk-fallback');
    expect(result.money).toBeNull();
  });

  it('does not present SDK cost from an unknown route as local actual spend', () => {
    const result = resolveTurnCost({
      rawModel: 'unknown-model',
      tokens: { inputTokens: 1_000, outputTokens: 100, cacheReadTokens: 0, cacheCreateTokens: 0 },
      sdkCostDelta: 1.23,
      pricing: null,
      context: { providerId: null, billingRoute: 'unknown', region: 'global' },
    });
    expect(result).toMatchObject({ source: 'sdk-fallback', money: null });
  });

  it('keeps an unquoted Gateway model unavailable even on a USD ledger', () => {
    const result = resolveTurnCost({
      rawModel: 'unquoted-model',
      tokens: { inputTokens: 1_000, outputTokens: 100, cacheReadTokens: 0, cacheCreateTokens: 0 },
      sdkCostDelta: 1.23,
      pricing: catalog(quote('some-other-model', 3, 15)),
      context: XD_GATEWAY_CN,
    });
    expect(result.source).toBe('sdk-fallback');
    expect(result.money).toBeNull();
  });

  it('projects non-gateway costs to the ledger currency, not the build region', () => {
    // 账本是单币种的,写入侧只接受账本币种。以 USD 结算的账号在 CN 构建上,若把第三方
    // 供应商 / 订阅估值按区域折成 CNY,这些金额会被账本守卫整批丢弃 —— 那些渠道的花费
    // 就再也记不进日账本、按模型统计与「本对话」累计。
    const providerApiOnUsdLedger = resolveTurnCost({
      rawModel: 'gpt-4o',
      tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 },
      sdkCostDelta: 2,
      pricing: catalog(quote('some-other-model', 3, 15)),
      context: { providerId: 'openai', billingRoute: 'provider-api', region: 'cn' },
    });
    expect(providerApiOnUsdLedger.money).toMatchObject({ amount: 2, currency: 'USD' });

    // CNY 账本仍按固定汇率投影(原有行为)。
    const providerApiOnCnyLedger = resolveTurnCost({
      rawModel: 'gpt-4o',
      tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 },
      sdkCostDelta: 2,
      pricing: catalog(quote('some-other-model', 3, 15, { currency: 'CNY' })),
      context: { providerId: 'openai', billingRoute: 'provider-api', region: 'cn' },
    });
    expect(providerApiOnCnyLedger.money).toMatchObject({ currency: 'CNY' });
    expect(providerApiOnCnyLedger.money?.amount).toBeCloseTo(2 * 6.7, 6);
  });

  it('omits the SDK USD fallback for a CNY-settled account (wrong currency, no discount)', () => {
    // CNY 账本下 SDK 的 USD 既不是该账号的报价口径、也不含 costDiscount，
    // 折算进去只会误记，这一轮宁可不记。
    const result = resolveTurnCost({
      rawModel: 'unquoted-model',
      tokens: { inputTokens: 1_000, outputTokens: 100, cacheReadTokens: 0, cacheCreateTokens: 0 },
      sdkCostDelta: 1.23,
      pricing: catalog(quote('some-other-model', 3, 15, { currency: 'CNY' })),
      context: XD_GATEWAY_CN,
    });
    expect(result.source).toBe('sdk-fallback');
    expect(result.money).toBeNull();
  });

  it('does not use the active ledger currency to legitimize a missing Gateway quote', () => {
    try {
      setActiveLedgerCurrency('USD');
      const result = resolveTurnCost({
        rawModel: 'unquoted-model',
        tokens: { inputTokens: 1_000, outputTokens: 100, cacheReadTokens: 0, cacheCreateTokens: 0 },
        sdkCostDelta: 1.23,
        pricing: {},
        context: XD_GATEWAY_CN,
      });
      expect(result.money).toBeNull();
    } finally {
      __resetActiveLedgerCurrencyForTesting();
    }
  });

  it('applies an ordinary Gateway model costDiscount exactly once', () => {
    const result = resolveTurnCost({
      rawModel: 'discounted-model',
      tokens: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 },
      sdkCostDelta: 99,
      pricing: catalog(quote('discounted-model', 2, 8, { currency: 'CNY', costDiscount: 0.75 })),
      context: XD_GATEWAY_CN,
    });
    expect(result.money).toMatchObject({ amount: 0.5, currency: 'CNY', approximate: false });
  });

  it('keeps a USD Gateway quote unconverted on a CN build (XD enterprise settles in USD)', () => {
    // 存在恒以 USD 结算的账号,即便客户端是 CN 构建也不能按
    // USD_TO_CNY_FIXED_RATE 折成人民币:账号配额那条路径(gatewayMoney)保留 USD 原值,
    // turn 若被换算就会在同一行出现 $ / ¥ 混排,且金额差一个汇率倍数、无法与账单核对。
    const result = resolveTurnCost({
      rawModel: 'gpt-5.5',
      tokens: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 },
      pricing: catalog(quote('gpt-5.5', 3, 15)),
      context: XD_GATEWAY_CN,
    });
    expect(result.source).toBe('gateway');
    expect(result.money).toMatchObject({
      amount: 3,
      currency: 'USD',
      approximate: false,
      kind: 'actual-cost',
    });
  });

  it('XD missing price with no SDK cost still resolves to null money', () => {
    const result = resolveTurnCost({
      rawModel: 'unknown-model',
      tokens: { inputTokens: 1_000, outputTokens: 100, cacheReadTokens: 0, cacheCreateTokens: 0 },
      pricing: {},
      context: XD_GATEWAY,
    });
    expect(result.source).toBe('sdk-fallback');
    expect(result.money).toBeNull();
  });

  it('provider API route keeps the SDK USD fact exact — no regional conversion', () => {
    const result = resolveTurnCost({
      rawModel: 'claude-opus-4-8',
      tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 },
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

  it('recomputes DeepSeek BYOK cost from cache-aware official pricing instead of SDK estimates', () => {
    const result = resolveTurnCost({
      rawModel: 'deepseek-v4-pro[1m]',
      tokens: {
        inputTokens: 2_000,
        outputTokens: 500,
        cacheReadTokens: 118_000,
        cacheCreateTokens: 0,
      },
      // 模拟 SDK 把 12 万输入 token 全按 cache miss 估出的高值。
      sdkCostDelta: 0.052635,
      pricing: catalog(
        quote('deepseek-v4-pro', 0.435, 0.87, {
          providerId: 'deepseek',
          cacheReadPerMtok: 0.003625,
          source: 'provider-reference',
          approximate: true,
        }),
      ),
      context: { providerId: 'deepseek', billingRoute: 'provider-api', region: 'global' },
    });

    expect(result).toMatchObject({
      model: 'deepseek-v4-pro',
      source: 'reference',
      money: { currency: 'USD', approximate: true, kind: 'value-estimate' },
    });
    expect(result.money?.amount).toBeCloseTo(0.00173275, 10);
  });

  it('keeps the DeepSeek SDK cost when token deltas are unavailable', () => {
    const result = resolveTurnCost({
      rawModel: 'deepseek-v4-pro',
      tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 },
      sdkCostDelta: 0.052635,
      pricing: catalog(
        quote('deepseek-v4-pro', 0.435, 0.87, {
          providerId: 'deepseek',
          cacheReadPerMtok: 0.003625,
          source: 'provider-reference',
          approximate: true,
        }),
      ),
      context: { providerId: 'deepseek', billingRoute: 'provider-api', region: 'global' },
    });

    expect(result).toEqual({
      model: 'deepseek-v4-pro',
      source: 'sdk',
      money: { amount: 0.052635, currency: 'USD', approximate: false, kind: 'actual-cost' },
    });
  });

  it('does not fall back to the DeepSeek SDK estimate when request segments are incomplete', () => {
    const result = resolveTurnCost({
      rawModel: 'deepseek-v4-pro',
      tokens: {
        inputTokens: 2_000,
        outputTokens: 500,
        cacheReadTokens: 118_000,
        cacheCreateTokens: 0,
      },
      sdkCostDelta: 0.052635,
      pricing: catalog(
        quote('deepseek-v4-pro', 0.435, 0.87, {
          providerId: 'deepseek',
          cacheReadPerMtok: 0.003625,
          source: 'provider-reference',
          approximate: true,
        }),
      ),
      context: { providerId: 'deepseek', billingRoute: 'provider-api', region: 'global' },
      segments: [],
    });
    expect(result).toEqual({ model: 'deepseek-v4-pro', source: 'reference', money: null });
  });

  it('uses a provider reference or user override estimate when the SDK reports no cost', () => {
    const result = resolveTurnCost({
      rawModel: 'custom-model',
      tokens: {
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
      },
      sdkCostDelta: 0,
      pricing: catalog(
        quote('custom-model', 2, 10, {
          providerId: 'anthropic',
          source: 'user-override',
          approximate: true,
        }),
      ),
      context: PROVIDER_API,
    });
    expect(result.source).toBe('reference');
    expect(result.money).toMatchObject({
      amount: 3,
      currency: 'USD',
      approximate: true,
      kind: 'value-estimate',
    });
  });

  it('does not apply a Gateway discount to provider SDK cost facts', () => {
    // 本例只验"折扣不落到第三方 SDK 实报值上",所以把账号币种显式钉成 USD:
    // 否则 CNY 账本会按固定汇率投影,金额不再等于 SDK 原值,验的就不是折扣了。
    try {
      setActiveLedgerCurrency('USD');
      const result = resolveTurnCost({
        rawModel: 'codex/gpt-5.5',
        tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 },
        sdkCostDelta: 10,
        pricing: null,
        context: PROVIDER_API,
      });
      expect(result.money?.amount).toBe(10);
    } finally {
      __resetActiveLedgerCurrencyForTesting();
    }
  });

  it('subscription routes and inferred subscription model prefixes never become actual cost', () => {
    const byRoute = resolveTurnCost({
      rawModel: 'claude-opus-4-8',
      tokens: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 },
      sdkCostDelta: 5,
      pricing: null,
      context: SUBSCRIPTION,
    });
    const byPrefix = resolveTurnCost({
      rawModel: 'chatgpt/gpt-5.5',
      tokens: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 },
      sdkCostDelta: 5,
      pricing: null,
      context: { providerId: null, billingRoute: 'unknown', region: 'global' },
    });
    expect(byRoute).toMatchObject({ source: 'subscription', money: null });
    expect(byPrefix).toMatchObject({ source: 'subscription', money: null });
  });

  it('keeps explicit built-in OpenAI and xAI subscription sources out of actual spend', () => {
    for (const [providerId, rawModel] of [
      ['openai', 'chatgpt/gpt-5.5'],
      ['xai', 'xai/grok-4.5'],
    ] as const) {
      const result = resolveTurnCost({
        rawModel,
        tokens: {
          inputTokens: 1_000_000,
          outputTokens: 100_000,
          cacheReadTokens: 0,
          cacheCreateTokens: 0,
        },
        sdkCostDelta: 5,
        pricing: null,
        context: {
          providerId,
          billingRoute: billingRouteForExplicitProvider(providerId, 'subscription')!,
          region: 'global',
        },
      });
      expect(result).toMatchObject({ source: 'subscription', money: null });
    }
  });

  it('lets an explicit provider API route price a custom xAI-prefixed model', () => {
    const result = resolveTurnCost({
      rawModel: 'xai/grok-4.5',
      tokens: {
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
      },
      sdkCostDelta: 0,
      pricing: catalog(
        quote('xai/grok-4.5', 2, 10, {
          providerId: 'vercel-ai-gateway',
          source: 'user-override',
          approximate: true,
        }),
      ),
      context: { providerId: 'vercel-ai-gateway', billingRoute: 'provider-api', region: 'global' },
    });

    expect(result.source).toBe('reference');
    expect(result.money).toMatchObject({
      amount: 3,
      currency: 'USD',
      approximate: true,
      kind: 'value-estimate',
    });
  });
});

describe('resolveClaudeTurnCostSinks', () => {
  it('sums structured per-model money using one billing route', () => {
    const pricing = catalog(quote('claude-opus-4-8', 5, 25), quote('gpt-5.5', 2, 8));
    const result = resolveClaudeTurnCostSinks(
      [
        delta('claude-opus-4-8[1m]', { inputTokensDelta: 1_000_000 }),
        delta('gpt-5.5[1m]', { inputTokensDelta: 1_000_000 }),
      ],
      pricing,
      XD_GATEWAY,
    );
    expect(result.turnMoney?.amount).toBe(7);
    expect(result.estimatedTurnMoney).toBeNull();
    expect(result.perModel.map((item) => item.money?.amount)).toEqual([5, 2]);
    expect(result.perModel.map((item) => item.source)).toEqual(['gateway', 'gateway']);
  });

  it('keeps quoted CN Gateway segments and omits unquoted SDK USD amounts', () => {
    const pricing = catalog(quote('claude-opus-4-8', 5, 25, { currency: 'CNY' }));
    const result = resolveClaudeTurnCostSinks(
      [
        delta('claude-opus-4-8', { inputTokensDelta: 1_000_000 }),
        delta('unquoted-model', { costUsdDelta: 2 }),
      ],
      pricing,
      XD_GATEWAY_CN,
    );
    expect(result.turnMoney).toMatchObject({ amount: 5, currency: 'CNY', kind: 'actual-cost' });
    expect(result.perModel.map((item) => item.money)).toEqual([
      expect.objectContaining({ currency: 'CNY', amount: 5 }),
      null,
    ]);
    expect(result.perModel.map((item) => item.source)).toEqual(['gateway', 'sdk-fallback']);
  });

  it('does not price a Claude turn whose request segment payload is incomplete', () => {
    const pricing = catalog(
      quote('gpt-5.5', 5, 30, {
        cacheReadPerMtok: 0.5,
        inputTokenPriceBands: [{ minInputTokens: 272_001, inputPerMtok: 10 }],
      }),
    );
    const result = resolveClaudeTurnCostSinks(
      [delta('gpt-5.5', { inputTokensDelta: 500_000 })],
      pricing,
      XD_GATEWAY,
      [],
      false,
    );
    expect(result.turnMoney).toBeNull();
    expect(result.perModel[0]?.segments).toEqual([]);
  });

  it('keeps observed Claude tokens when the first cumulative snapshot is unpriceable', () => {
    const result = resolveClaudeTurnCostSinks(
      [],
      catalog(quote('gpt-5.5', 5, 30, { cacheReadPerMtok: 0.5 })),
      XD_GATEWAY,
      [
        {
          model: 'gpt-5.5',
          inputTokens: 100,
          outputTokens: 25,
          cacheReadTokens: 0,
          cacheCreateTokens: 0,
        },
      ],
      false,
    );
    expect(result.turnMoney).toBeNull();
    expect(result.perModel).toMatchObject([
      {
        model: 'gpt-5.5',
        money: null,
        deltas: { inputTokens: 100, outputTokens: 25, cacheReadTokens: 0, cacheCreateTokens: 0 },
        segments: [],
      },
    ]);
  });

  it('prices completed Claude request segments while leaving only the residual unpriced', () => {
    const pricing = catalog(
      quote('gpt-5.5', 5, 30, {
        cacheReadPerMtok: 0.5,
        inputTokenPriceBands: [{ minInputTokens: 272_001, inputPerMtok: 10 }],
      }),
    );
    const result = resolveClaudeTurnCostSinks(
      [
        delta('gpt-5.5', {
          inputTokensDelta: 600_000,
          outputTokensDelta: 20_000,
        }),
      ],
      pricing,
      XD_GATEWAY,
      [
        {
          id: 'completed-request',
          model: 'gpt-5.5',
          inputTokens: 100_000,
          outputTokens: 10_000,
          cacheReadTokens: 0,
          cacheCreateTokens: 0,
          complete: true,
        },
        {
          id: 'unfinished-request',
          model: 'gpt-5.5',
          inputTokens: 500_000,
          outputTokens: 10_000,
          cacheReadTokens: 0,
          cacheCreateTokens: 0,
          complete: false,
        },
      ],
      false,
    );

    expect(result.turnMoney).toMatchObject({ amount: 0.8, kind: 'actual-cost' });
    expect(result.perModel).toHaveLength(2);
    expect(result.perModel[0]).toMatchObject({
      money: { amount: 0.8, kind: 'actual-cost' },
      deltas: { inputTokens: 100_000, outputTokens: 10_000 },
      segments: [{ id: 'completed-request', complete: true }],
    });
    expect(result.perModel[1]).toMatchObject({
      money: null,
      deltas: { inputTokens: 500_000, outputTokens: 10_000 },
      segments: [],
    });
  });

  it('returns null total when the route is subscription-only', () => {
    const result = resolveClaudeTurnCostSinks(
      [delta('claude-opus-4-8', { costUsdDelta: 4 })],
      null,
      SUBSCRIPTION,
    );
    expect(result.turnMoney).toBeNull();
    expect(result.estimatedTurnMoney).toBeNull();
    expect(result.perModel[0]).toMatchObject({ source: 'subscription', money: null });
  });

  it('keeps provider reference estimates out of actual spend', () => {
    const reference = quote('claude-opus-4-8', 5, 25, {
      providerId: 'anthropic',
      source: 'provider-reference',
      approximate: true,
    });
    const result = resolveClaudeTurnCostSinks(
      [delta('claude-opus-4-8', { inputTokensDelta: 1_000_000 })],
      catalog(reference),
      PROVIDER_API,
    );
    expect(result.turnMoney).toBeNull();
    expect(result.estimatedTurnMoney).toMatchObject({ amount: 5, kind: 'value-estimate' });
  });

  it('does not mix a reference estimate into an actual SDK cost total', () => {
    const pricing = catalog(
      quote('claude-opus-4-8', 5, 25, {
        providerId: 'anthropic',
        source: 'provider-reference',
        approximate: true,
      }),
    );
    const result = resolveClaudeTurnCostSinks(
      [
        delta('claude-opus-4-8', { inputTokensDelta: 1_000_000 }),
        delta('other-model', { costUsdDelta: 2 }),
      ],
      pricing,
      PROVIDER_API,
    );
    expect(result.turnMoney).toMatchObject({ amount: 2, kind: 'actual-cost' });
    expect(result.estimatedTurnMoney).toMatchObject({ amount: 5, kind: 'value-estimate' });
  });
});

describe('subscription value and usage details', () => {
  it('estimates Anthropic subscription value from USD reference pricing', () => {
    const pricing = catalog(
      quote('claude-opus-4-8', 5, 25, {
        providerId: 'anthropic',
        source: 'provider-reference',
        approximate: true,
        cacheReadPerMtok: 0.5,
        cacheCreatePerMtok: 6.25,
      }),
    );
    const value = estimateClaudeSubscriptionTurnValue(
      [resolvedModel('claude-opus-4-8', { inputTokens: 1_000_000, outputTokens: 200_000 })],
      'USD',
      pricing,
    );
    expect(value).toMatchObject({
      amount: 10,
      currency: 'USD',
      approximate: true,
      kind: 'value-estimate',
    });
  });

  it('keeps estimates for Claude family aliases and dated wire ids', () => {
    const pricing = catalog(
      quote('claude-opus-4-8', 5, 25, {
        providerId: 'anthropic',
        source: 'provider-reference',
        approximate: true,
      }),
      quote('claude-sonnet-4-6', 3, 15, {
        providerId: 'anthropic',
        source: 'provider-reference',
        approximate: true,
      }),
    );
    expect(
      estimateClaudeSubscriptionTurnValue(
        [resolvedModel('opus', { inputTokens: 1_000_000 })],
        'USD',
        pricing,
      ),
    ).toMatchObject({ amount: 5, kind: 'value-estimate' });
    expect(
      estimateClaudeSubscriptionTurnValue(
        [resolvedModel('claude-sonnet-4-6-20260701', { inputTokens: 1_000_000 })],
        'USD',
        pricing,
      ),
    ).toMatchObject({ amount: 3, kind: 'value-estimate' });
  });

  it('prefers an agent-specific user override for a bare Claude family alias', () => {
    const canonical = 'claude-sonnet-4-6';
    const reference = quote(canonical, 3, 15, {
      providerId: 'anthropic',
      source: 'provider-reference',
      approximate: true,
    });
    const override = quote(canonical, 9, 45, {
      providerId: 'anthropic',
      source: 'user-override',
      approximate: true,
    });
    const pricing = {
      anthropic: { [canonical]: reference, [`${canonical}\u0000claude-code`]: override },
    };

    expect(
      estimateClaudeSubscriptionTurnValue(
        [resolvedModel('sonnet', { inputTokens: 1_000_000 })],
        'USD',
        pricing,
      ),
    ).toMatchObject({ amount: 9, kind: 'value-estimate' });
  });

  it('does not estimate non-Anthropic, already-costed, unknown, or zero-token entries', () => {
    expect(
      estimateClaudeSubscriptionTurnValue(
        [
          resolvedModel('gpt-5.5', { inputTokens: 1_000_000 }),
          resolvedModel('claude-opus-4-8', { inputTokens: 1_000_000 }, usdMoney(1)),
          resolvedModel('claude-unknown-9', { inputTokens: 1_000_000 }),
        ],
        'USD',
        {},
      ),
    ).toBeNull();
    expect(
      estimateClaudeSubscriptionTurnValue([resolvedModel('claude-opus-4-8')], 'USD', {}),
    ).toBeNull();
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

  it('keeps generation and full-turn durations separate', () => {
    const details = buildClaudeTurnUsageDetails(
      { input_tokens: 10, output_tokens: 25 },
      undefined,
      'claude-opus-4-8',
      undefined,
      1_250,
      8_500,
    );
    expect(details).toMatchObject({ durationMs: 1_250, turnDurationMs: 8_500 });
  });
});
