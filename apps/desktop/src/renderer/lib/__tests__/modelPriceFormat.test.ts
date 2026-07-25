import { describe, expect, it } from 'vitest';

import type { ModelPriceQuote } from '../../../shared/regionalMoney';
import {
  formatModelPricePair,
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

  it('uses the effective price when it is a uniform scaling of the standard price', () => {
    const standard = quote({ inputPerMtok: 12, outputPerMtok: 36 });
    expect(modelPricePresentation(standard, { input: 6, output: 18 })).toEqual({
      kind: 'priced',
      current: quote({ inputPerMtok: 6, outputPerMtok: 18 }),
    });
    expect(
      modelPriceDetailRows(quote({ inputPerMtok: 6, outputPerMtok: 18, cacheReadPerMtok: 0.3 })),
    ).toEqual([
      { kind: 'input', value: '¥6' },
      { kind: 'output', value: '¥18' },
      { kind: 'cacheRead', value: '¥0.3' },
    ]);
  });

  it('uses the effective Gateway price across Qwen cache dimensions', () => {
    const standard = quote({
      modelId: 'qwen/qwen3.7-max',
      inputPerMtok: 12,
      outputPerMtok: 36,
      cacheReadPerMtok: 2.4,
      cacheCreatePerMtok: 15,
    });
    const presentation = modelPricePresentation(standard, {
      input: 6,
      output: 18,
      cacheRead: 1.2,
      cacheWrite: 7.5,
    });

    expect(presentation).toEqual({
      kind: 'priced',
      current: quote({
        modelId: 'qwen/qwen3.7-max',
        inputPerMtok: 6,
        outputPerMtok: 18,
        cacheReadPerMtok: 1.2,
        cacheCreatePerMtok: 7.5,
      }),
    });
    expect(
      presentation?.kind === 'priced' ? modelPriceDetailRows(presentation.current) : [],
    ).toEqual([
      { kind: 'input', value: '¥6' },
      { kind: 'output', value: '¥18' },
      { kind: 'cacheRead', value: '¥1.2' },
      { kind: 'cacheCreate', value: '¥7.5' },
    ]);
  });

  it('falls back to the standard price when a cache dimension cannot confirm the effective price', () => {
    const standard = quote({
      inputPerMtok: 12,
      outputPerMtok: 36,
      cacheReadPerMtok: 2.4,
      cacheCreatePerMtok: 15,
    });

    expect(
      modelPricePresentation(standard, {
        input: 6,
        output: 18,
        cacheRead: 1.2,
      }),
    ).toEqual({ kind: 'priced', current: standard });
    expect(
      modelPricePresentation(standard, {
        input: 6,
        output: 18,
        cacheRead: 2.4,
        cacheWrite: 7.5,
      }),
    ).toEqual({ kind: 'priced', current: standard });
  });

  it('marks only an explicit double-zero model price with a confirmed missing quote as free', () => {
    expect(modelPricePresentation(null, { input: 0, output: 0 })).toEqual({
      kind: 'free',
    });
    expect(modelPricePresentation(undefined, { input: 0, output: 0 })).toBeNull();
  });

  it('shows double-zero effective prices as zero when the quote is nonzero', () => {
    const standard = quote({ inputPerMtok: 12, outputPerMtok: 36 });
    expect(modelPricePresentation(standard, { input: 0, output: 0 })).toEqual({
      kind: 'priced',
      current: quote({ inputPerMtok: 0, outputPerMtok: 0 }),
    });
  });

  it('preserves the standard price when the effective price matches it', () => {
    const standard = quote({ inputPerMtok: 12, outputPerMtok: 36 });
    expect(modelPricePresentation(standard, { input: 12, output: 36 })).toEqual({
      kind: 'priced',
      current: standard,
    });
  });

  it('ignores sub-threshold floating-point price noise', () => {
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
