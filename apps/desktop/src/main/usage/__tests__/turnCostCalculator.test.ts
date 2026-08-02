import { describe, expect, it } from 'vitest';

import type { ModelUsageDeltaEntry } from '../modelUsageDelta';
import {
  __resetActiveLedgerCurrencyForTesting,
  setActiveLedgerCurrency,
} from '../ledgerCurrency';
import {
  billingRouteForExplicitProvider,
  buildClaudeTurnUsageDetails,
  computePriceQuoteTurnMoney,
  computeGatewayTurnCost,
  estimateClaudeSubscriptionTurnValue,
  isAnthropicModel,
  normalizeModelIdForPricing,
  resolveClaudeTurnCostSinks,
  resolveTurnCost,
  type ResolvedModelCost,
  type TurnPricingContext,
} from '../turnCostCalculator';
import {
  DEFAULT_USAGE_CURRENCY,
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
    expect(
      computeGatewayTurnCost(
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
        {
          minInputTokens: 0,
          maxInputTokens: 200_000,
          inputPerMtok: 0.2,
          outputPerMtok: 1.5,
        },
      ],
    });

    expect(
      computeGatewayTurnCost(
        {
          inputTokens: 199_999,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheCreateTokens: 0,
        },
        boundedReference,
      ),
    ).not.toBeNull();
    expect(
      computeGatewayTurnCost(
        {
          inputTokens: 200_000,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheCreateTokens: 0,
        },
        boundedReference,
      ),
    ).toBeNull();
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
        quote('subscription-model', 2, 10, {
          source: 'subscription-reference',
          approximate: true,
        }),
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

  it('lets the build default ledger currency decide the SDK fallback when the Gateway quote is missing', () => {
    // 没有活动账本币种(冷启动、目录还没同步下来)时由构建默认币种定夺,断言因此
    // 跟着构建区域走:Global(USD 账本)直接按 SDK 的 USD 兜底记账;中国大陆版
    // (CNY 账本)按 resolveTurnCost 里 sdk-fallback 的币种守卫这一轮不记。
    // 不能写死 USD —— 那样只有 Global 构建下能过,等于把构建默认值当成了常量。
    __resetActiveLedgerCurrencyForTesting();
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
    expect(result.money).toEqual(
      DEFAULT_USAGE_CURRENCY === 'USD'
        ? {
            amount: 1.23,
            currency: 'USD',
            approximate: false,
            kind: 'actual-cost',
          }
        : null,
    );
  });

  it('falls back to the SDK USD amount for a USD-settled account on a CN build', () => {
    // 结算币种由目录里其它 xd 报价声明,不看构建区域、也不按租户判断。
    // 以 USD 结算的账号在某个模型缺报价时同样要记账,不能漏计。
    const result = resolveTurnCost({
      rawModel: 'unquoted-model',
      tokens: {
        inputTokens: 1_000,
        outputTokens: 100,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
      },
      sdkCostDelta: 1.23,
      pricing: catalog(quote('some-other-model', 3, 15)),
      context: XD_GATEWAY_CN,
    });
    expect(result.source).toBe('sdk-fallback');
    expect(result.money).toEqual({
      amount: 1.23,
      currency: 'USD',
      approximate: false,
      kind: 'actual-cost',
    });
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
      tokens: {
        inputTokens: 1_000,
        outputTokens: 100,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
      },
      sdkCostDelta: 1.23,
      pricing: catalog(quote('some-other-model', 3, 15, { currency: 'CNY' })),
      context: XD_GATEWAY_CN,
    });
    expect(result.source).toBe('sdk-fallback');
    expect(result.money).toBeNull();
  });

  it('uses the active ledger currency when the pricing catalog is entirely empty', () => {
    try {
      setActiveLedgerCurrency('USD');
      const result = resolveTurnCost({
        rawModel: 'unquoted-model',
        tokens: { inputTokens: 1_000, outputTokens: 100, cacheReadTokens: 0, cacheCreateTokens: 0 },
        sdkCostDelta: 1.23,
        pricing: {},
        context: XD_GATEWAY_CN,
      });
      expect(result.money).toMatchObject({ amount: 1.23, currency: 'USD' });
    } finally {
      __resetActiveLedgerCurrencyForTesting();
    }
  });

  it('applies an ordinary Gateway model costDiscount exactly once', () => {
    const result = resolveTurnCost({
      rawModel: 'discounted-model',
      tokens: {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
      },
      sdkCostDelta: 99,
      pricing: catalog(
        quote('discounted-model', 2, 8, {
          currency: 'CNY',
          costDiscount: 0.75,
        }),
      ),
      context: XD_GATEWAY_CN,
    });
    expect(result.money).toMatchObject({
      amount: 0.5,
      currency: 'CNY',
      approximate: false,
    });
  });

  it('keeps a USD Gateway quote unconverted on a CN build (XD enterprise settles in USD)', () => {
    // 存在恒以 USD 结算的账号,即便客户端是 CN 构建也不能按
    // USD_TO_CNY_FIXED_RATE 折成人民币:账号配额那条路径(gatewayMoney)保留 USD 原值,
    // turn 若被换算就会在同一行出现 $ / ¥ 混排,且金额差一个汇率倍数、无法与账单核对。
    const result = resolveTurnCost({
      rawModel: 'gpt-5.5',
      tokens: {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
      },
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
      expect(result.money?.amount).toBe(10);
    } finally {
      __resetActiveLedgerCurrencyForTesting();
    }
  });

  it('subscription routes and inferred subscription model prefixes never become actual cost', () => {
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
      context: {
        providerId: 'vercel-ai-gateway',
        billingRoute: 'provider-api',
        region: 'global',
      },
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
    expect(result.turnMoney).toMatchObject({
      amount: 5,
      currency: 'CNY',
      kind: 'actual-cost',
    });
    expect(result.perModel.map((item) => item.money)).toEqual([
      expect.objectContaining({ currency: 'CNY', amount: 5 }),
      null,
    ]);
    expect(result.perModel.map((item) => item.source)).toEqual(['gateway', 'sdk-fallback']);
  });

  it('returns null total when the route is subscription-only', () => {
    const result = resolveClaudeTurnCostSinks(
      [delta('claude-opus-4-8', { costUsdDelta: 4 })],
      null,
      SUBSCRIPTION,
    );
    expect(result.turnMoney).toBeNull();
    expect(result.estimatedTurnMoney).toBeNull();
    expect(result.perModel[0]).toMatchObject({
      source: 'subscription',
      money: null,
    });
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
    expect(result.estimatedTurnMoney).toMatchObject({
      amount: 5,
      kind: 'value-estimate',
    });
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
      [
        resolvedModel('claude-opus-4-8', {
          inputTokens: 1_000_000,
          outputTokens: 200_000,
        }),
      ],
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
      anthropic: {
        [canonical]: reference,
        [`${canonical}\u0000claude-code`]: override,
      },
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
});
