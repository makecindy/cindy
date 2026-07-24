import { describe, expect, it } from 'vitest';

import type { ModelPriceQuote } from '../../../shared/regionalMoney';
import {
  formatModelPricePair,
  modelPriceDetailRows,
} from '../modelPriceFormat';

function quote(overrides: Partial<ModelPriceQuote> = {}): ModelPriceQuote {
  return {
    providerId: 'xd',
    modelId: 'claude-sonnet-4',
    currency: 'CNY',
    source: 'gateway',
    approximate: false,
    inputPerMtok: 3,
    outputPerMtok: 15,
    ...overrides,
  };
}

describe('modelPriceFormat', () => {
  it('formats gateway CNY input/output as a compact pair', () => {
    expect(formatModelPricePair(quote())).toBe('¥3 / ¥15');
  });

  it('adds the approximate marker only once', () => {
    expect(
      formatModelPricePair(
        quote({
          source: 'subscription-reference',
          approximate: true,
          inputPerMtok: 20.1,
          outputPerMtok: 100.5,
        }),
      ),
    ).toBe('≈¥20.1 / ¥100.5');
  });

  it('includes configured cache prices in details', () => {
    expect(
      modelPriceDetailRows(
        quote({ cacheReadPerMtok: 0.3, cacheCreatePerMtok: 3.75 }),
      ),
    ).toEqual([
      { kind: 'input', value: '¥3' },
      { kind: 'output', value: '¥15' },
      { kind: 'cacheRead', value: '¥0.3' },
      { kind: 'cacheCreate', value: '¥3.75' },
    ]);
  });
});
