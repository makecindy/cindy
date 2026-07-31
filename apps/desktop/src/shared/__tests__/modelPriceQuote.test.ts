import { describe, expect, it } from 'vitest';
import type { ModelRegistry } from '@cindy/model-providers';

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
        'cn',
      ),
    ).toEqual({});
  });

  it('lets a single declared currency cover the models that omit it', () => {
    // 同一账号的目录币种是统一的:省略 currency 的条目跟随同目录已声明的币种，
    // 而不是各自回落构建区域(那会产出跨币种目录)。
    const catalog = gatewayPricingCatalog(
      [model('a', { currency: 'USD' }), model('b')],
      'cn',
    );
    expect(Object.keys(catalog.xd ?? {})).toEqual(['a', 'b']);
    expect(Object.values(catalog.xd ?? {}).map((quote) => quote.currency)).toEqual([
      'USD',
      'USD',
    ]);
  });

  it('falls back to the build region only when no model declares a currency', () => {
    const catalog = gatewayPricingCatalog([model('a'), model('b')], 'cn');
    expect(Object.values(catalog.xd ?? {}).map((quote) => quote.currency)).toEqual([
      'CNY',
      'CNY',
    ]);
  });

  it('carries Gateway costDiscount uniformly for ordinary and codex models', () => {
    const catalog = gatewayPricingCatalog(
      [model('a', { costDiscount: 0.4 }), model('codex/gpt-5.5', { costDiscount: 0.4 })],
      'cn',
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
});

describe('registryPricingCatalog', () => {
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
