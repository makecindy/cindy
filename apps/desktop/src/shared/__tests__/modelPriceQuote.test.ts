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
  it.each(['fast', 'priority'] as const)('projects declared %s prices without inventing unavailable tariffs', (variant) => {
    const entry = structuredClone(BUNDLED_CATALOG.modelRegistry!.models.find((model) => model.id === 'openai/gpt-6-astra')!);
    const prices = entry.routes[0]!.referencePrices!;
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
