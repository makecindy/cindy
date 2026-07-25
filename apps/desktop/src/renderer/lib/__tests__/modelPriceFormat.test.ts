import { describe, expect, it } from 'vitest';

import type { ModelPriceQuote } from '../../../shared/regionalMoney';
import {
  formatModelPricePair,
  modelPriceDiscountLabelValues,
  modelPriceDetailRows,
  modelPricePresentation,
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
      modelPriceDetailRows(quote({ cacheReadPerMtok: 0.3, cacheCreatePerMtok: 3.75 })),
    ).toEqual([
      { kind: 'input', value: '¥3' },
      { kind: 'output', value: '¥15' },
      { kind: 'cacheRead', value: '¥0.3' },
      { kind: 'cacheCreate', value: '¥3.75' },
    ]);
  });

  it('uses the effective price while retaining the original for a 50% discount', () => {
    const original = quote({ inputPerMtok: 12, outputPerMtok: 36 });
    expect(modelPricePresentation(original, { input: 6, output: 18 })).toEqual({
      kind: 'priced',
      current: quote({ inputPerMtok: 6, outputPerMtok: 18 }),
      original,
      discount: 0.5,
    });
    expect(modelPriceDiscountLabelValues(0.5)).toEqual({
      percent: '50',
      rate: '5',
    });
    expect(modelPriceDiscountLabelValues(0.2)).toEqual({
      percent: '20',
      rate: '8',
    });
    expect(
      modelPriceDetailRows(
        quote({ inputPerMtok: 6, outputPerMtok: 18, cacheReadPerMtok: 0.3 }),
        original,
      ),
    ).toEqual([
      { kind: 'input', value: '¥6', originalValue: '¥12' },
      { kind: 'output', value: '¥18', originalValue: '¥36' },
      { kind: 'cacheRead', value: '¥0.3' },
    ]);
  });

  it('marks only an explicit double-zero model price with a confirmed missing quote as free', () => {
    expect(modelPricePresentation(null, { input: 0, output: 0 })).toEqual({
      kind: 'free',
    });
    expect(modelPricePresentation(undefined, { input: 0, output: 0 })).toBeNull();
  });

  it('keeps double-zero effective prices as a 100% discount when the quote is nonzero', () => {
    const original = quote({ inputPerMtok: 12, outputPerMtok: 36 });
    expect(modelPricePresentation(original, { input: 0, output: 0 })).toEqual({
      kind: 'priced',
      current: quote({ inputPerMtok: 0, outputPerMtok: 0 }),
      original,
      discount: 1,
    });
  });

  it('preserves the standard price when there is no discount', () => {
    const standard = quote({ inputPerMtok: 12, outputPerMtok: 36 });
    expect(modelPricePresentation(standard, { input: 12, output: 36 })).toEqual({
      kind: 'priced',
      current: standard,
    });
  });

  it('ignores sub-threshold floating-point discount noise', () => {
    const standard = quote({ inputPerMtok: 12, outputPerMtok: 36 });
    expect(
      modelPricePresentation(standard, {
        input: 12 * (1 - 1e-12),
        output: 36 * (1 - 1e-12),
      }),
    ).toEqual({
      kind: 'priced',
      current: standard,
    });
  });

  it('keeps missing or inconsistent display costs on the existing fallback path', () => {
    const standard = quote({ inputPerMtok: 12, outputPerMtok: 36 });
    expect(modelPricePresentation(standard, { input: 6 })).toEqual({
      kind: 'priced',
      current: standard,
    });
    expect(modelPricePresentation(undefined, { input: 0 })).toBeNull();
    expect(modelPricePresentation(standard, { input: 6, output: 30 })).toEqual({
      kind: 'priced',
      current: standard,
    });
  });
});
