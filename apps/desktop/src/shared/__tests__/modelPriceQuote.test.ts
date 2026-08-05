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
  it('keeps every priced CN Gateway model in the native CNY catalog', () => {
    const catalog = gatewayPricingCatalog(
      [model('a', { currency: 'CNY' }), model('b', { currency: 'USD' }), model('c')],
      'cn',
    );
    expect(Object.keys(catalog.xd)).toEqual(['a', 'b', 'c']);
    expect(Object.values(catalog.xd).map((quote) => quote.currency)).toEqual(['CNY', 'CNY', 'CNY']);
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
