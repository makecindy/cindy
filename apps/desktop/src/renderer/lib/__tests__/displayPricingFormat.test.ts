import { describe, expect, it } from 'vitest';
import { displayPricingAmount } from '../displayPricingFormat';
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
