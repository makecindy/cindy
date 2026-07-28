import { describe, expect, it } from 'vitest';

import type { ModelAccessGatewayModel } from '../modelAccess.js';
import {
  gatewayPricingCatalog,
  resolveGatewayCatalogCurrency,
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

describe('resolveGatewayCatalogCurrency', () => {
  it('defaults to gateway-native USD when nothing is declared', () => {
    expect(resolveGatewayCatalogCurrency([model('a'), model('b')])).toBe('USD');
    expect(resolveGatewayCatalogCurrency([])).toBe('USD');
  });

  it('switches only when every entry explicitly declares the same non-USD currency', () => {
    expect(
      resolveGatewayCatalogCurrency([
        model('a', { currency: 'CNY' }),
        model('b', { currency: 'CNY' }),
      ]),
    ).toBe('CNY');
  });

  it('keeps undeclared entries USD — a partial CNY declaration never flips the catalog', () => {
    expect(
      resolveGatewayCatalogCurrency([
        model('a', { currency: 'CNY' }),
        model('b'),
      ]),
    ).toBe('USD');
  });

  it('treats mixed declarations as USD — local ledgers are single-currency', () => {
    expect(
      resolveGatewayCatalogCurrency([
        model('a', { currency: 'CNY' }),
        model('b', { currency: 'USD' }),
      ]),
    ).toBe('USD');
  });

  it('ignores invalid declaration values', () => {
    expect(
      resolveGatewayCatalogCurrency([
        model('a', { currency: 'EUR' as unknown as 'USD' }),
      ]),
    ).toBe('USD');
  });

  it('excludes price-less entries from the vote — a metadata-only sibling cannot pin CNY catalogs to USD', () => {
    expect(
      resolveGatewayCatalogCurrency([
        model('a', { currency: 'CNY' }),
        model('doc', {
          inputCostPerToken: undefined,
          outputCostPerToken: undefined,
        }),
      ]),
    ).toBe('CNY');
  });

  it('excludes zero-priced (free) entries from the vote', () => {
    expect(
      resolveGatewayCatalogCurrency([
        model('a', { currency: 'CNY' }),
        model('free', { inputCostPerToken: 0, outputCostPerToken: 0 }),
      ]),
    ).toBe('CNY');
  });

  it('still keeps the catalog USD when a priced entry lacks the declaration', () => {
    expect(
      resolveGatewayCatalogCurrency([
        model('a', { currency: 'CNY' }),
        model('b'),
        model('doc', {
          inputCostPerToken: undefined,
          outputCostPerToken: undefined,
        }),
      ]),
    ).toBe('USD');
  });
});

describe('gatewayPricingCatalog currency', () => {
  it('drops conflicting declared entries instead of relabeling their prices', () => {
    const catalog = gatewayPricingCatalog([
      model('a', { currency: 'CNY' }),
      model('b', { currency: 'USD' }),
      model('c'),
    ]);
    expect(Object.keys(catalog.xd)).toEqual(['b', 'c']);
    expect(Object.values(catalog.xd).map((quote) => quote.currency)).toEqual([
      'USD',
      'USD',
    ]);
  });

  it('labels every quote with the catalog currency when all entries declare it', () => {
    const catalog = gatewayPricingCatalog([
      model('a', { currency: 'CNY' }),
      model('b', { currency: 'CNY' }),
    ]);
    expect(Object.values(catalog.xd).map((quote) => quote.currency)).toEqual([
      'CNY',
      'CNY',
    ]);
  });

  it('never relabels undeclared entries when a sibling declares CNY', () => {
    const catalog = gatewayPricingCatalog([
      model('a', { currency: 'CNY' }),
      model('b'),
    ]);
    expect(Object.keys(catalog.xd)).toEqual(['b']);
    expect(catalog.xd.b.currency).toBe('USD');
  });

  it('keeps every CNY quote when the only undeclared sibling is price-less (#587 regression)', () => {
    const catalog = gatewayPricingCatalog([
      model('a', { currency: 'CNY' }),
      model('b', { currency: 'CNY' }),
      model('doc', {
        inputCostPerToken: undefined,
        outputCostPerToken: undefined,
      }),
      model('free', { inputCostPerToken: 0, outputCostPerToken: 0 }),
    ]);
    expect(Object.keys(catalog.xd)).toEqual(['a', 'b']);
    expect(Object.values(catalog.xd).map((quote) => quote.currency)).toEqual([
      'CNY',
      'CNY',
    ]);
  });
});
