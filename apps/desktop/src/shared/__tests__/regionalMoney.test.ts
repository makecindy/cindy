import { describe, expect, it } from 'vitest';

import {
  addCompatibleRegionalMoney,
  addRegionalMoney,
  asValueEstimateMoney,
  DEFAULT_USAGE_CURRENCY,
  gatewayCurrency,
  gatewayMoney,
  legacyUsdMoney,
  regionalizeUsd,
  usdMoney,
  type RegionalMoney,
} from '../regionalMoney.js';

const cnyActual = (amount: number): RegionalMoney => ({
  amount,
  currency: 'CNY',
  approximate: false,
  kind: 'actual-cost',
});

describe('regional money', () => {
  it('keeps current-client Gateway values exact in the local ledger currency', () => {
    expect(gatewayMoney(3).currency).toBe(DEFAULT_USAGE_CURRENCY);
  });

  it('maps an explicitly supplied region to the Gateway currency contract', () => {
    expect(gatewayCurrency('global')).toBe('USD');
    expect(gatewayCurrency('cn')).toBe('CNY');
  });

  it('converts non-Gateway USD into the CN ledger at the exact fixed rate', () => {
    expect(usdMoney(3)).toEqual({
      amount: 3,
      currency: 'USD',
      approximate: false,
      kind: 'actual-cost',
    });
    expect(regionalizeUsd(3, 'cn')).toEqual({
      amount: 20.1,
      currency: 'CNY',
      approximate: false,
      kind: 'actual-cost',
    });
    expect(legacyUsdMoney(1)).toEqual({
      amount: 1,
      currency: 'USD',
      approximate: false,
      kind: 'actual-cost',
    });
  });

  it('keeps actual zero exact while preserving value-estimate semantics', () => {
    expect(legacyUsdMoney(0)).toEqual({
      amount: 0,
      currency: 'USD',
      approximate: false,
      kind: 'actual-cost',
    });
    expect(usdMoney(0, 'value-estimate', 'subscription-value')).toEqual({
      amount: 0,
      currency: 'USD',
      approximate: true,
      kind: 'value-estimate',
      estimateReasons: ['subscription-value'],
    });
  });

  it('marks subscription values as estimates and records the reason chain', () => {
    expect(usdMoney(3, 'value-estimate', 'legacy-usd')).toEqual({
      amount: 3,
      currency: 'USD',
      approximate: true,
      kind: 'value-estimate',
      estimateReasons: ['legacy-usd', 'subscription-value'],
    });
  });

  it('propagates approximation and reasons while adding same-currency values', () => {
    const total = addRegionalMoney([
      usdMoney(3),
      usdMoney(1, 'value-estimate', 'legacy-usd'),
    ]);
    expect(total).toMatchObject({
      amount: 4,
      currency: 'USD',
      approximate: true,
      kind: 'actual-cost',
      estimateReasons: expect.arrayContaining(['legacy-usd', 'subscription-value']),
    });
  });

  it('rejects mixed currencies instead of silently combining them', () => {
    expect(() => addRegionalMoney([cnyActual(1), usdMoney(1)])).toThrow(
      /different currencies/,
    );
  });

  it('keeps actual cost when an incompatible estimate is present on read', () => {
    const staleCnyEstimate: RegionalMoney = {
      amount: 2,
      currency: 'CNY',
      approximate: true,
      kind: 'value-estimate',
      estimateReasons: ['subscription-value'],
    };
    const total = addCompatibleRegionalMoney([usdMoney(3), staleCnyEstimate]);

    expect(total).toEqual(usdMoney(3));
  });

  it('prefers an explicit ledger currency for mixed historical actual costs', () => {
    const total = addCompatibleRegionalMoney(
      [cnyActual(3), usdMoney(2)],
      'USD',
    );

    expect(total).toEqual(usdMoney(2));
  });

  it('falls back to the first actual currency when nothing matches the preference', () => {
    const total = addCompatibleRegionalMoney([cnyActual(3), cnyActual(2)]);

    expect(total).toEqual(cnyActual(5));
  });

  it('marks subscription value without changing amount or currency', () => {
    expect(asValueEstimateMoney(legacyUsdMoney(1))).toEqual({
      amount: 1,
      currency: 'USD',
      approximate: true,
      kind: 'value-estimate',
      estimateReasons: ['subscription-value'],
    });
  });
});
