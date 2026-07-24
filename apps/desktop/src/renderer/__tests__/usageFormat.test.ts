import { describe, expect, it } from 'vitest';

import {
  formatCompactTokens,
  formatTurnCostMoney,
} from '@/lib/usageFormat';

describe('formatCompactTokens', () => {
  it('uses B for billion-scale token counts', () => {
    expect(formatCompactTokens(491_400_000)).toBe('491.4M');
    expect(formatCompactTokens(10_166_600_000)).toBe('10.2B');
  });

  it('keeps smaller values in k/M buckets', () => {
    expect(formatCompactTokens(999)).toBe('999');
    expect(formatCompactTokens(1_500)).toBe('1.5k');
    expect(formatCompactTokens(2_000_000)).toBe('2.0M');
  });
});

describe('formatTurnCostMoney', () => {
  it('renders a true zero without a less-than label', () => {
    expect(
      formatTurnCostMoney({
        amount: 0,
        currency: 'CNY',
        approximate: false,
        kind: 'actual-cost',
      }),
    ).toBe('¥0.00');
    expect(
      formatTurnCostMoney({
        amount: 0,
        currency: 'USD',
        approximate: true,
        kind: 'value-estimate',
      }),
    ).toBe('≈$0.00');
  });
});
