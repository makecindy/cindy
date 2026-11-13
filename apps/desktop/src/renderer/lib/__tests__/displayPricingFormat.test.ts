import { describe, expect, it } from 'vitest';
import type { ModelDisplayPricing } from '@cindy/model-providers';
import { displayPricingAmount, displayPricingDenominator, displayPricingQuantity, isDisplayPricingTableRedundant } from '../displayPricingFormat';
const row = { label: 'Output', price: 0.5, unit: 'second', quantity: 1 };
describe('display pricing amounts', () => {
  it('applies the provider discount once while retaining the quoted basis', () => {
    const result = displayPricingAmount(row, 'USD', 0.2, 'en');
    expect(result.current).toContain('0.4');
    expect(result.original).toContain('0.5');
    expect(result.current).toBe('$0.4');
    expect(result.original).toBe('$0.5');
    expect(row.price).toBe(0.5);
  });
  it('uses the existing yuan symbol without a currency code', () => {
    expect(displayPricingAmount(row, 'CNY', 0, 'zh-CN').current).toBe('¥0.5');
  });
  it('retains small nonzero amounts', () => {
    const result = displayPricingAmount({ ...row, price: 0.000000001 }, 'CNY', 0, 'en');
    expect(result.current).toBe('¥0.000000001');
    expect(result.free).toBe(false);
    expect(result.original).toBeUndefined();
  });
  it('keeps zero valid and distinguishes fully discounted prices', () => {
    expect(displayPricingAmount({ ...row, price: 0 }, 'USD', undefined, 'en').free).toBe(true);
    expect(displayPricingAmount(row, 'USD', 1, 'en')).toMatchObject({ free: true });
    expect(displayPricingAmount(row, 'USD', 1, 'en').original).toContain('0.5');
  });
});

// Unit contract: ranges must discount both endpoints once, including zero-to-paid ranges.
// Previous coverage only checked single amounts; minimum regression is { price: 6, maxPrice: 10 }.
it('discounts both range endpoints without marking a zero lower bound as free', () => {
  expect(displayPricingAmount({ price: 6, maxPrice: 10 }, 'CNY', 0.2, 'en'))
    .toEqual({ current: '¥4.8–¥8', original: '¥6–¥10', free: false });
  expect(displayPricingAmount({ price: 0, maxPrice: 10 }, 'USD', 0, 'en'))
    .toEqual({ current: '$0–$10', free: false });
  expect(displayPricingAmount({ price: 0, maxPrice: 10 }, 'USD', 1, 'en'))
    .toEqual({ current: '$0', original: '$0–$10', free: true });
});
// Unit regression: distinct range endpoints rounded to the same visible amount ($1–$1).
// Existing ranges differed within eight significant digits; exercise close and adjacent doubles
// through displayPricingAmount, for both discounted and original prices.
it.each([
  [1.000000002, '$0.5–$0.500000001', '$1–$1.000000002'],
  [1 + Number.EPSILON, '$0.5–$0.5000000000000001', '$1–$1.0000000000000002'],
])('keeps the upper bound %s distinguishable after rounding', (maxPrice, current, original) => {
  expect(displayPricingAmount({ price: 1, maxPrice: maxPrice as number }, 'USD', 0.5, 'en'))
    .toEqual({ current, original, free: false });
});

// Unit contract: quantity 1 is omitted; million is localized; arbitrary values retain their basis.
it.each([
  [1, 'en', '1M', ''], [1000000, 'zh-CN', '百万', '百万'],
  [1000000, 'en', '1M', '1M'], [1234.5, 'en', '1M', '1,234.5'],
])('formats quantity %s in %s', (quantity, locale, million, expected) => {
  expect(displayPricingQuantity(quantity as number, locale as string, million as string)).toBe(expected);
});

// Unit: a redundant table hid role distinctions or repeated the summary. Existing tests covered only amounts.
// Minimum input: two identical items must consume two distinct quotes, not reuse a single match.
describe('supplementary price table deduplication', () => {
  const quote = { price: 0.5, unit: 'image', quantity: 1 };
  const item = { ...quote, label: 'Supplier label' };
  it('matches across roles regardless of order, without mutating the summary', () => {
    const pricing: ModelDisplayPricing = {
      items: [{ ...item, price: 2, priceType: 'exact' }, item], notes: [],
      summary: { input: [quote], output: [{ ...quote, price: 2, priceType: 'exact' }] },
    };
    expect(isDisplayPricingTableRedundant(pricing)).toBe(true);
    expect(pricing.summary!.input).toEqual([quote]);
    expect(pricing.summary!.output).toHaveLength(1);
    expect(isDisplayPricingTableRedundant({ items: [item, item], summary: { input: [quote], output: [quote] } })).toBe(true);
  });
  it.each([
    { items: [item] },
    { items: [item], notes: ['Billing condition'], summary: { input: [quote] } },
    { items: [{ ...item, tier: 'HD' }], summary: { input: [quote] } },
    { items: [{ ...item, priceType: 'estimated' as const }], summary: { input: [quote] } },
    { items: [{ ...item, priceType: 'starting_at' as const }], summary: { input: [quote] } },
    { items: [item], summary: { input: [quote], output: [quote] } },
    { items: [item, item], summary: { input: [quote] } },
    { items: [item, item], summary: { input: [quote], output: [{ ...quote, price: 2 }] } },
    { items: [item], summary: { input: [{ ...quote, unit: 'second' }] } },
    { items: [item], summary: { input: [{ ...quote, quantity: 2 }] } },
    { items: [item], summary: { input: [{ ...quote, maxPrice: 2 }] } },
    { items: [item], summary: { input: [{ ...quote, tier: 'HD' }] } },
  ])('keeps a table with additional or different information: %j', pricing => {
    expect(isDisplayPricingTableRedundant(pricing)).toBe(false);
  });
});

// Unit: the previous unconditional separator produced “百万 字符”; Latin/custom units must keep spacing.
it.each([
  ['百万', '字符', 'zh-CN', '/ 百万字符'],
  ['百萬', '字元', 'zh-TW', '/ 百萬字元'],
  ['100万', '文字', 'ja', '/ 100万文字'],
  ['100万', 'リクエスト', 'ja', '/ 100万リクエスト'],
  ['100만', '자', 'ko', '/ 100만 자'],
  ['1M', 'characters', 'en', '/ 1M characters'],
  ['百万', 'tokens', 'zh-CN', '/ 百万 tokens'],
  ['1,234.5', '次', 'zh-CN', '/ 1,234.5次'],
  ['', '张', 'zh-CN', '/ 张'],
])('joins %s and %s in %s', (quantity, unit, locale, expected) => {
  expect(displayPricingDenominator(quantity, unit, locale)).toBe(expected);
});
