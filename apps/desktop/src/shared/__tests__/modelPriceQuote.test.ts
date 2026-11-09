import { describe, expect, it } from 'vitest';
import { BUNDLED_CATALOG, type ModelRegistry } from '@cindy/model-providers';

import type { ModelAccessGatewayModel } from '../modelAccess.js';
import {
  gatewayPricingCatalog,
  providerReferencePriceQuote,
  registryPricingCatalog,
} from '../modelPriceQuote.js';

function model(
  id: string,
  overrides: Partial<ModelAccessGatewayModel> = {},
): ModelAccessGatewayModel {
  return {
    id,
    inputCostPerToken: 0.000002,
    outputCostPerToken: 0.000008,
    ...overrides,
  };
}

// Regression: direct DeepSeek reference estimates previously used peak rates all day.
// The existing static tariff tests do not exercise intraday boundaries (unit tier).
describe('DeepSeek direct reference time bands', () => {
  it.each([
    ['2026-11-09T00:59:59.999Z', 0.66], ['2026-11-09T01:00:00Z', 1.32],
    ['2026-11-09T03:59:59.999Z', 1.32], ['2026-11-09T04:00:00Z', 0.66],
    ['2026-11-09T05:59:59.999Z', 0.66], ['2026-11-09T06:00:00Z', 1.32],
    ['2026-11-09T09:59:59.999Z', 1.32], ['2026-11-09T10:00:00Z', 0.66],
    ['2026-11-14T02:00:00Z', 0.66], ['2027-01-01T02:00:00Z', 0.66],
    ['2027-02-05T02:00:00Z', 0.66], ['2027-02-14T02:00:00Z', 0.66],
    ['2027-02-15T02:00:00Z', 1.32], ['2027-10-06T02:00:00Z', 0.66],
    ['2026-11-09T12:00:00+08:00', 0.66],
    ['2026-11-09', 1.32], ['2026-11-08T02:00:00Z', 1.32],
    ['2028-01-01T02:00:00Z', 1.32], ['2027-13-01T04:00:00Z', 1.32],
    ['2027-02-30T04:00:00Z', 1.32],
  ])('selects the reference tariff at %s', (at, inputPerMtok) => {
    const quote = providerReferencePriceQuote('deepseek', 'deepseek-v4-pro',
      BUNDLED_CATALOG.modelRegistry, { at });
    expect(quote).toMatchObject({ inputPerMtok, outputPerMtok: inputPerMtok === 1.32 ? 3.96 : 1.98,
      cacheReadPerMtok: inputPerMtok === 1.32 ? 0.044 : 0.022, approximate: true });
    expect(quote?.inputTokenPriceBands?.[0].inputPerMtok).toBe(inputPerMtok);
  });

  it.each(['deepseek-v4-flash', 'deepseek-flash'])('uses Flash off-peak rates for %s', modelId => {
    expect(providerReferencePriceQuote('deepseek', modelId, BUNDLED_CATALOG.modelRegistry,
      { at: '2026-11-09T04:00:00Z' })).toMatchObject({ inputPerMtok: 0.15,
      outputPerMtok: 0.6, cacheReadPerMtok: 0.003 });
  });

  it('does not apply the policy to Gateway or an independently declared route quote', () => {
    const registry = structuredClone(BUNDLED_CATALOG.modelRegistry!);
    const entry = registry.models.find(model => model.modelRef === 'deepseek/deepseek-v4-pro' &&
      model.routes.some(route => route.providerId === 'deepseek'))!;
    const route = entry.routes.find(route => route.providerId === 'deepseek')!;
    const base = registry.baseModels!.find(model => model.id === entry.modelRef)!;
    route.referencePrices = structuredClone(base.referencePriceGroups![0].prices);
    expect(providerReferencePriceQuote('deepseek', 'deepseek-v4-pro', registry,
      { at: '2026-11-09T04:00:00Z' })?.inputPerMtok).toBe(1.32);
    expect(gatewayPricingCatalog([model('deepseek/deepseek-v4-pro', { currency: 'USD',
      inputCostPerToken: 0.00000132, outputCostPerToken: 0.00000396 })], 'USD')
      .xd['deepseek/deepseek-v4-pro'].inputPerMtok).toBeCloseTo(1.32);
  });
});

describe('gatewayPricingCatalog', () => {
  it('rejects the whole catalog when the Gateway declares mixed currencies', () => {
    // 混币目录已被 resolveGatewayAccountCurrency 判定不可信(账本随之回退构建币种)。
    // 若这里继续产出混币 catalog，非账本币种的那部分模型金额会被账本写入守卫选择性
    // 丢弃，形成"按模型漏记账"——比整份没有报价更难发现。
    expect(
      gatewayPricingCatalog(
        [model('a', { currency: 'CNY' }), model('b', { currency: 'USD' }), model('c')],
        'CNY',
      ),
    ).toEqual({});
  });

  it('lets a single declared currency cover the models that omit it', () => {
    // 同一账号的目录币种是统一的:省略 currency 的条目跟随同目录已声明的币种，
    // 而不是各自回落账本币种(那会产出跨币种目录)。
    const catalog = gatewayPricingCatalog(
      [model('a', { currency: 'USD' }), model('b')],
      'CNY',
    );
    expect(Object.keys(catalog.xd ?? {})).toEqual(['a', 'b']);
    expect(Object.values(catalog.xd ?? {}).map((quote) => quote.currency)).toEqual([
      'USD',
      'USD',
    ]);
    // 目录声明了币种,不是猜的 —— 下游金额仍按精确账单记。
    expect(
      Object.values(catalog.xd ?? {}).every((quote) => quote.currencyInferred === undefined),
    ).toBe(true);
  });

  it('falls back to the ledger currency and marks it inferred when no model declares one', () => {
    // 服务端漏发 currency 时只能回落账本币种,但必须留下"这是猜的"的痕迹:报价数值来自
    // 服务端、币种由本地推断,猜错就是把一个口径的数字盖上另一个口径的戳。
    const catalog = gatewayPricingCatalog([model('a'), model('b')], 'USD');
    expect(Object.values(catalog.xd ?? {}).map((quote) => quote.currency)).toEqual([
      'USD',
      'USD',
    ]);
    expect(
      Object.values(catalog.xd ?? {}).every((quote) => quote.currencyInferred === true),
    ).toBe(true);
  });

  it('never guesses the currency by build region', () => {
    // 回归护栏:此前整份目录没声明 currency 时按构建区域猜 CNY,把 USD 口径的报价数值
    // 盖上 CNY 戳,产生 6.7 倍量级的错账。回落值只能来自调用方给的账本币种。
    const catalog = gatewayPricingCatalog([model('a')], 'USD');
    expect(catalog.xd?.a?.currency).toBe('USD');
  });

  it('carries Gateway costDiscount uniformly for ordinary and codex models', () => {
    const catalog = gatewayPricingCatalog(
      [model('a', { costDiscount: 0.4 }), model('codex/gpt-5.5', { costDiscount: 0.4 })],
      'CNY',
    );
    expect(catalog.xd.a).toMatchObject({
      inputPerMtok: 2,
      outputPerMtok: 8,
      costDiscount: 0.4,
    });
    expect(catalog.xd['codex/gpt-5.5']).toMatchObject({
      inputPerMtok: 2,
      outputPerMtok: 8,
      costDiscount: 0.4,
    });
  });

  it('preserves Fast/Priority baseline and long-context prices', () => {
    const catalog = gatewayPricingCatalog(
      [
        model('fast-model', {
          inputCostPerTokenPriority: 0.00001,
          outputCostPerTokenPriority: 0.00006,
          cacheReadInputTokenCostPriority: 0.000001,
          inputCostPerTokenAbove272kTokensPriority: 0.00002,
          outputCostPerTokenAbove272kTokensPriority: 0.00009,
          cacheReadInputTokenCostAbove272kTokensPriority: 0.000002,
        }),
      ],
      'USD',
    );

    expect(catalog.xd['fast-model']?.priority).toMatchObject({
      inputPerMtok: 10,
      outputPerMtok: 60,
      cacheReadPerMtok: 1,
      inputTokenPriceBands: [
        { minInputTokens: 272_001, inputPerMtok: 20, outputPerMtok: 90, cacheReadPerMtok: 2 },
      ],
    });
  });
});

describe('registryPricingCatalog', () => {
  it('projects the audited public tariffs without backfilling Gateway sale prices', () => {
    const registry = BUNDLED_CATALOG.modelRegistry!;
    const luna = providerReferencePriceQuote('openai', 'gpt-5.6-luna', registry, { at: '2026-09-11' });
    expect(luna).toMatchObject({ inputPerMtok: 0.2, cacheCreatePerMtok: 0.25,
      priority: { inputPerMtok: 0.4, cacheCreatePerMtok: 0.5,
        inputTokenPriceBands: expect.arrayContaining([
          expect.objectContaining({ minInputTokens: 272001, inputPerMtok: 0.8, cacheCreatePerMtok: 1 }),
        ]),
      },
    });
    expect(providerReferencePriceQuote('openai', 'gpt-5.4-pro', registry, { at: '2026-09-11', inputTokens: 272001 }))
      .toMatchObject({ inputPerMtok: 60, outputPerMtok: 270 });
    expect(providerReferencePriceQuote('anthropic', 'claude-fable-5-1', registry, { at: '2026-09-11' }))
      .toMatchObject({ inputPerMtok: 10, cacheReadPerMtok: 0.25, cacheCreatePerMtok: 12.5 });
    expect(providerReferencePriceQuote('minimax-cn', 'MiniMax-M2.7', registry, { at: '2026-09-11' }))
      .toMatchObject({ currency: 'CNY', inputPerMtok: 2.1, cacheCreatePerMtok: 2.625 });
    expect(providerReferencePriceQuote('minimax-global', 'MiniMax-M2.7', registry, { at: '2026-09-11' }))
      .toMatchObject({ currency: 'USD', inputPerMtok: 0.3, cacheCreatePerMtok: 0.375 });
    expect(registryPricingCatalog(registry).xd).toBeUndefined();
    const gateway = gatewayPricingCatalog([model('openai/gpt-5.6-luna', {
      currency: 'USD', inputCostPerToken: 0.0000002, outputCostPerToken: 0.0000012,
      cacheReadInputTokenCost: 0.00000002,
    })], 'USD');
    expect(gateway.xd['openai/gpt-5.6-luna'].cacheCreatePerMtok).toBeUndefined();
  });

  it.each(['fast', 'priority'] as const)('projects declared %s prices without inventing unavailable tariffs', (variant) => {
    const entry = structuredClone(BUNDLED_CATALOG.modelRegistry!.models.find((model) => model.id === 'openai/gpt-6-astra')!);
    const prices = structuredClone(BUNDLED_CATALOG.modelRegistry!.baseModels!.find(model => model.id === entry.modelRef)!.referencePriceGroups![0].prices);
    entry.routes[0]!.referencePrices = prices;
    prices.find((price) => price.variant === 'fast')!.variant = variant;
    const registry: ModelRegistry = { schemaVersion: 1, updatedAt: '2026-09-04T00:00:00Z', models: [entry] };
    const getQuote = (at = '2026-09-04') => providerReferencePriceQuote('openai', 'gpt-6-astra', registry, { at });
    expect(getQuote()).toMatchObject({ inputPerMtok: 10, priority: { inputPerMtok: 20, cacheCreatePerMtok: 25 } });

    const fast = prices.find((price) => price.variant === variant)!;
    fast.effectiveFrom = '2026-09-05';
    expect(getQuote()?.priority).toBeUndefined();
    expect(getQuote('2026-09-05')?.priority).toBeDefined();
    fast.currency = 'CNY';
    expect(getQuote('2026-09-05')?.priority).toBeUndefined();
    entry.routes[0]!.referencePrices = prices.filter((price) => price.variant === 'standard');
    expect(getQuote()?.priority).toBeUndefined();
  });

  it('preserves the bounds of a single reference-price interval', () => {
    const registry: ModelRegistry = {
      schemaVersion: 1,
      updatedAt: '2026-07-31T00:00:00.000Z',
      models: [
        {
          id: 'xai/grok-code-fast',
          name: 'Grok Code Fast',
          routes: [
            {
              providerId: 'xai',
              modelId: 'grok-code-fast',
              agents: ['codex'],
              referencePrices: [
                {
                  currency: 'USD',
                  variant: 'standard',
                  maxInputTokens: 200_000,
                  inputPerMtok: 0.2,
                  outputPerMtok: 1.5,
                  effectiveFrom: '2026-01-01',
                  source: {
                    kind: 'provider-official',
                    url: 'https://example.test/pricing',
                    verifiedAt: '2026-07-31',
                  },
                },
              ],
            },
          ],
        },
      ],
    };

    expect(providerReferencePriceQuote('xai', 'grok-code-fast', registry)).toMatchObject({
      inputTokenPriceBands: [
        {
          minInputTokens: 0,
          maxInputTokens: 200_000,
          inputPerMtok: 0.2,
          outputPerMtok: 1.5,
        },
      ],
    });
  });

  it('never treats a public XD reference as the Cindy Gateway sale price', () => {
    const registry: ModelRegistry = {
      schemaVersion: 1,
      updatedAt: '2026-07-31T00:00:00.000Z',
      models: [
        {
          id: 'test/model',
          name: 'Test Model',
          routes: [
            {
              providerId: 'xd',
              modelId: 'test-model',
              agents: ['claude-code'],
              referencePrices: [
                {
                  currency: 'USD',
                  variant: 'standard',
                  inputPerMtok: 1,
                  outputPerMtok: 2,
                  effectiveFrom: '2026-01-01',
                  source: {
                    kind: 'provider-official',
                    url: 'https://example.test/pricing',
                    verifiedAt: '2026-07-31',
                  },
                },
              ],
            },
          ],
        },
      ],
    };

    expect(registryPricingCatalog(registry)).toEqual({});
  });

  it('preserves the currency declared by a provider reference price', () => {
    const registry: ModelRegistry = {
      schemaVersion: 1,
      updatedAt: '2026-07-31T00:00:00.000Z',
      models: [
        {
          id: 'test/cny-model',
          name: 'CNY Model',
          routes: [
            {
              providerId: 'custom-cn',
              modelId: 'cny-model',
              agents: ['codex'],
              referencePrices: [
                {
                  currency: 'CNY',
                  variant: 'standard',
                  inputPerMtok: 7,
                  outputPerMtok: 21,
                  effectiveFrom: '2026-01-01',
                  source: {
                    kind: 'provider-official',
                    url: 'https://example.test/pricing',
                    verifiedAt: '2026-07-31',
                  },
                },
              ],
            },
          ],
        },
      ],
    };

    expect(registryPricingCatalog(registry)['custom-cn']?.['cny-model']).toMatchObject({
      currency: 'CNY',
      inputPerMtok: 7,
      outputPerMtok: 21,
    });
  });
});

// Unit: real Desktop quotes must carry PDF Batch caches and retain unknown legacy
// cache prices without borrowing standard. The prior snapshot had neither behavior.
it('quotes explicit Anthropic Batch caches and preserves the standard tariff', () => {
  const registry = BUNDLED_CATALOG.modelRegistry!;
  const batch = providerReferencePriceQuote('anthropic', 'claude-opus-5-5', registry, {
    at: '2026-11-06', variant: 'batch',
  });
  expect(batch).toMatchObject({ currency: 'USD', inputPerMtok: 2, outputPerMtok: 10,
    cacheReadPerMtok: 0.1, cacheCreatePerMtok: 2.5, cacheCreate1hPerMtok: 4 });
  expect(batch?.priority).toBeUndefined();
  const legacy = providerReferencePriceQuote('anthropic', 'claude-sonnet-4-5', registry, {
    at: '2026-11-06', variant: 'batch', inputTokens: 200000,
  });
  expect(legacy).toMatchObject({ currency: 'USD', inputPerMtok: 1.5, outputPerMtok: 7.5 });
  expect(legacy?.cacheReadPerMtok).toBeUndefined();
  expect(legacy?.cacheCreatePerMtok).toBeUndefined();
  expect(legacy?.cacheCreate1hPerMtok).toBeUndefined();
  expect(providerReferencePriceQuote('anthropic', 'claude-opus-5-5', registry, { at: '2026-11-06' }))
    .toMatchObject({ inputPerMtok: 4, outputPerMtok: 20, cacheReadPerMtok: 0.2,
      priority: { inputPerMtok: 8, outputPerMtok: 40 } });
  expect(providerReferencePriceQuote('anthropic', 'claude-opus-5-5', registry, { at: '2026-10-21', variant: 'batch' }))
    .toBeUndefined();
  expect(providerReferencePriceQuote('anthropic', 'claude-opus-5-5', registry, { at: '2026-10-22', variant: 'batch' }))
    .toMatchObject({ currency: 'USD', inputPerMtok: 2, outputPerMtok: 10 });
});
