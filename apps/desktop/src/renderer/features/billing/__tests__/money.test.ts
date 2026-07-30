// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import { formatBillingAmount, formatBillingMinorAmount } from '../money';

// USD 走窄符号(见 money.ts 的 billingCurrencyFormatOptions),否则 zh-CN 等宿主
// locale 下 Intl 默认会给出 US$,期望值必须带上同一选项才跟实现同源;这里仍不写死
// 符号,以免绑定具体 ICU 版本的分组符与小数点。
const USD_FORMAT_OPTIONS: Intl.NumberFormatOptions = {
  style: 'currency',
  currency: 'USD',
  currencyDisplay: 'narrowSymbol',
};
const usd = (value: number) => new Intl.NumberFormat(undefined, USD_FORMAT_OPTIONS).format(value);
const jpy = (value: number) =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency: 'JPY' }).format(value);
const exactUsd = (whole: bigint, fraction: bigint) => {
  const formatter = new Intl.NumberFormat(undefined, USD_FORMAT_OPTIONS);
  const resolved = formatter.resolvedOptions();
  const localizedFraction = new Intl.NumberFormat(resolved.locale, {
    numberingSystem: resolved.numberingSystem,
    useGrouping: false,
    minimumIntegerDigits: 2,
    maximumFractionDigits: 0,
  }).format(fraction);
  return formatter
    .formatToParts(whole)
    .map((part) => (part.type === 'fraction' ? localizedFraction : part.value))
    .join('');
};

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

  it('preserves cents when the currency-scaled value exceeds Number.MAX_SAFE_INTEGER', () => {
    const amount = '999999999999999.94';
    expect(formatBillingAmount(amount, 'usd')).toBe(exactUsd(999999999999999n, 94n));
    expect(formatBillingAmount(amount, 'usd')).not.toBe(usd(Number(amount)));
  });

  it('falls back to the raw amount when the value is not numeric', () => {
    expect(formatBillingAmount('not-a-number', 'usd')).toBe('not-a-number USD');
  });

  it('uses the dollar symbol for USD in Chinese', () => {
    expect(formatBillingAmount('3', 'usd', 'zh-CN')).toBe('$3.00');
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

  it('preserves every minor unit up to Number.MAX_SAFE_INTEGER', () => {
    expect(formatBillingMinorAmount(Number.MAX_SAFE_INTEGER, 'usd')).toBe(
      exactUsd(90071992547409n, 91n),
    );
  });
});
