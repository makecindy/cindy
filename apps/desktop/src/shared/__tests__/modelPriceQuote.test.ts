import { describe, expect, it } from 'vitest';

import type { ModelAccessGatewayModel } from '../modelAccess.js';
import { gatewayPricingCatalog } from '../modelPriceQuote.js';

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
