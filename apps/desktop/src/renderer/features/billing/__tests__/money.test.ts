// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import { formatBillingAmount, formatBillingMinorAmount } from '../money';

const usd = (value: number) =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(value);
const jpy = (value: number) =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency: 'JPY' }).format(value);

describe('formatBillingAmount', () => {
  it('rounds decimal midpoints half away from zero without IEEE 754 drift', () => {
    expect(formatBillingAmount('1.005', 'usd')).toBe(usd(1.01));
    expect(formatBillingAmount('2.675', 'usd')).toBe(usd(2.68));
  });

  it('rounds negative midpoints symmetrically', () => {
    expect(formatBillingAmount('-1.005', 'usd')).toBe(usd(-1.01));
    expect(formatBillingAmount('-2.675', 'usd')).toBe(usd(-2.68));
  });

  it('never renders negative zero', () => {
    expect(formatBillingAmount('-0.001', 'usd')).toBe(usd(0));
  });

  it('falls back to the raw amount when the value is not numeric', () => {
    expect(formatBillingAmount('not-a-number', 'usd')).toBe('not-a-number USD');
  });
});

describe('formatBillingMinorAmount', () => {
  it('converts minor units through an exact decimal string', () => {
    expect(formatBillingMinorAmount(1105, 'usd')).toBe(usd(11.05));
    expect(formatBillingMinorAmount(1500, 'cny')).toBe(
      new Intl.NumberFormat(undefined, { style: 'currency', currency: 'CNY' }).format(15),
    );
  });

  it('handles zero-decimal currencies', () => {
    expect(formatBillingMinorAmount(120, 'jpy')).toBe(jpy(120));
  });
});
