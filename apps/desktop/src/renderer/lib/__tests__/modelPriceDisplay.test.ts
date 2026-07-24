import { describe, expect, it } from 'vitest';

import { formatModelPricePair, resolveModelDisplayPrice } from '../modelPriceDisplay';

describe('modelPriceDisplay', () => {
  it('CN 的 XD Gateway 价格只换单位和币种符号，不做汇率换算', () => {
    const price = resolveModelDisplayPrice({
      providerId: 'xd',
      gatewayCost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      referenceUsdCost: { input: 99, output: 99 },
      region: 'cn',
    });

    expect(price).toEqual({
      currency: 'CNY',
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 3.75,
    });
    expect(formatModelPricePair(price!)).toBe('¥3 / ¥15');
  });

  it('CN 的其它来源按固定汇率从 USD 换算为 CNY', () => {
    const price = resolveModelDisplayPrice({
      providerId: 'anthropic',
      referenceUsdCost: { input: 3, output: 15 },
      region: 'cn',
    });

    expect(price).toMatchObject({ currency: 'CNY', input: 20.1, output: 100.5 });
    expect(formatModelPricePair(price!)).toBe('¥20.1 / ¥100.5');
  });

  it('Global 的其它来源保持 USD 原值', () => {
    const price = resolveModelDisplayPrice({
      providerId: 'anthropic',
      referenceUsdCost: { input: 3, output: 15 },
      region: 'global',
    });

    expect(price).toEqual({ currency: 'USD', input: 3, output: 15 });
    expect(formatModelPricePair(price!)).toBe('$3 / $15');
  });

  it('XD Gateway 没有公开价格时不回退其它来源价格', () => {
    expect(
      resolveModelDisplayPrice({
        providerId: 'xd',
        referenceUsdCost: { input: 3, output: 15 },
        region: 'cn',
      }),
    ).toBeNull();
  });
});
