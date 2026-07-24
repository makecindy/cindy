import { describe, expect, it } from 'vitest';

import {
  addCompatibleRegionalMoney,
  addRegionalMoney,
  asValueEstimateMoney,
  gatewayMoney,
  regionalizeLegacyUsd,
  regionalizeUsd,
} from '../regionalMoney.js';

describe('regional money', () => {
  it('keeps Gateway values exact and assigns the build-region currency', () => {
    expect(gatewayMoney(3, 'cn')).toEqual({
      amount: 3,
      currency: 'CNY',
      approximate: false,
      kind: 'actual-cost',
    });
    expect(gatewayMoney(3, 'global')).toEqual({
      amount: 3,
      currency: 'USD',
      approximate: false,
      kind: 'actual-cost',
    });
  });

  it('converts non-Gateway USD to CN at the fixed 6.7 rate and marks it approximate', () => {
    expect(regionalizeUsd(3, 'cn', 'fixed-fx')).toEqual({
      amount: 20.1,
      currency: 'CNY',
      approximate: true,
      kind: 'actual-cost',
      estimateReasons: ['fixed-fx'],
    });
  });

  it('keeps actual zero exact while preserving value-estimate semantics', () => {
    expect(regionalizeLegacyUsd(0, 'cn')).toEqual({
      amount: 0,
      currency: 'CNY',
      approximate: false,
      kind: 'actual-cost',
    });
    expect(regionalizeUsd(0, 'cn', 'subscription-value', 'value-estimate')).toEqual({
      amount: 0,
      currency: 'CNY',
      approximate: true,
      kind: 'value-estimate',
      estimateReasons: ['subscription-value'],
    });
  });

  it('keeps global USD facts exact but marks subscription values as estimates', () => {
    expect(regionalizeUsd(3, 'global', 'reference-price')).toEqual({
      amount: 3,
      currency: 'USD',
      approximate: false,
      kind: 'actual-cost',
    });
    expect(regionalizeUsd(3, 'global', 'subscription-value', 'value-estimate')).toEqual({
      amount: 3,
      currency: 'USD',
      approximate: true,
      kind: 'value-estimate',
      estimateReasons: ['subscription-value'],
    });
  });

  it('preserves legacy USD as a fact and only marks CN conversion approximate', () => {
    expect(regionalizeLegacyUsd(1, 'global')).toMatchObject({
      amount: 1,
      currency: 'USD',
      approximate: false,
    });
    expect(regionalizeLegacyUsd(1, 'cn')).toMatchObject({
      amount: 6.7,
      currency: 'CNY',
      approximate: true,
      estimateReasons: expect.arrayContaining(['fixed-fx', 'legacy-usd']),
    });
  });

  it('propagates approximation and reasons while adding same-currency values', () => {
    const total = addRegionalMoney([gatewayMoney(3, 'cn'), regionalizeLegacyUsd(1, 'cn')]);
    expect(total).toMatchObject({
      amount: 9.7,
      currency: 'CNY',
      approximate: true,
      kind: 'actual-cost',
      estimateReasons: expect.arrayContaining(['fixed-fx', 'legacy-usd']),
    });
  });

  it('rejects mixed currencies instead of silently combining them', () => {
    expect(() => addRegionalMoney([gatewayMoney(1, 'cn'), gatewayMoney(1, 'global')])).toThrow(
      /different currencies/,
    );
  });

  it('keeps actual cost when an incompatible estimate is present on read', () => {
    const total = addCompatibleRegionalMoney(
      [
        gatewayMoney(3, 'cn'),
        regionalizeUsd(2, 'global', 'subscription-value', 'value-estimate'),
      ],
      'USD',
    );

    expect(total).toEqual(gatewayMoney(3, 'cn'));
  });

  it('prefers the current regional currency for mixed historical actual costs', () => {
    const total = addCompatibleRegionalMoney(
      [gatewayMoney(3, 'cn'), gatewayMoney(2, 'global')],
      'USD',
    );

    expect(total).toEqual(gatewayMoney(2, 'global'));
  });

  it('marks subscription value without changing amount or currency', () => {
    expect(asValueEstimateMoney(regionalizeLegacyUsd(1, 'cn'))).toEqual({
      amount: 6.7,
      currency: 'CNY',
      approximate: true,
      kind: 'value-estimate',
      estimateReasons: ['fixed-fx', 'legacy-usd', 'subscription-value'],
    });
  });
});
