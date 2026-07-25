import type { ModelPriceQuote, MoneyCurrency } from '../../shared/regionalMoney';

interface EffectiveModelCost {
  input?: number;
  output?: number;
}

const MIN_DISPLAY_DISCOUNT = 0.0005;

export type ModelPricePresentation =
  | { kind: 'free' }
  | {
      kind: 'priced';
      current: ModelPriceQuote;
      original?: ModelPriceQuote;
      discount?: number;
    };

function compactNumber(value: number): string {
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: value > 0 && value < 0.01 ? 4 : 2,
    useGrouping: false,
  }).format(value);
}

export function formatModelPriceAmount(amount: number, currency: MoneyCurrency): string {
  return `${currency === 'CNY' ? '¥' : '$'}${compactNumber(amount)}`;
}

export function formatModelPricePair(quote: ModelPriceQuote): string {
  const input = formatModelPriceAmount(quote.inputPerMtok, quote.currency);
  const output = formatModelPriceAmount(quote.outputPerMtok, quote.currency);
  return `${quote.approximate ? '≈' : ''}${input} / ${output}`;
}

export function modelPriceDiscountLabelValues(discount: number): {
  percent: string;
  rate: string;
} {
  return {
    percent: compactNumber(discount * 100),
    rate: compactNumber((1 - discount) * 10),
  };
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function inferDiscount(
  quote: ModelPriceQuote,
  cost: Required<EffectiveModelCost>,
): number | undefined {
  const candidates: number[] = [];
  for (const [original, current] of [
    [quote.inputPerMtok, cost.input],
    [quote.outputPerMtok, cost.output],
  ] as const) {
    if (original === 0) {
      if (current !== 0) return undefined;
      continue;
    }
    const candidate = 1 - current / original;
    if (candidate < MIN_DISPLAY_DISCOUNT || candidate > 1) return undefined;
    candidates.push(candidate);
  }
  if (candidates.length === 0) return undefined;
  const discount = candidates[0];
  return candidates.every((candidate) => Math.abs(candidate - discount) < 1e-9)
    ? discount
    : undefined;
}

/**
 * 构建模型选择器的展示价格。quote 继续保留用量估算所需的标准价；
 * CatalogModel.cost 只承载 XD 模型的折后展示价。
 */
export function modelPricePresentation(
  quote: ModelPriceQuote | null | undefined,
  effectiveCost: EffectiveModelCost | null | undefined,
): ModelPricePresentation | null {
  if (quote === undefined) return null;

  const input = effectiveCost?.input;
  const output = effectiveCost?.output;
  const hasEffectiveCost = isNonNegativeFinite(input) && isNonNegativeFinite(output);

  if (
    hasEffectiveCost &&
    input === 0 &&
    output === 0 &&
    (quote === null || (quote.inputPerMtok === 0 && quote.outputPerMtok === 0))
  ) {
    return { kind: 'free' };
  }
  if (quote === null) return null;
  if (!hasEffectiveCost) return { kind: 'priced', current: quote };

  const discount = inferDiscount(quote, { input, output });
  if (discount === undefined) return { kind: 'priced', current: quote };
  return {
    kind: 'priced',
    current: {
      ...quote,
      inputPerMtok: input,
      outputPerMtok: output,
    },
    original: quote,
    discount,
  };
}

export function modelPriceDetailRows(
  quote: ModelPriceQuote,
  originalQuote?: ModelPriceQuote,
): Array<{
  kind: 'input' | 'output' | 'cacheRead' | 'cacheCreate';
  value: string;
  originalValue?: string;
}> {
  return [
    {
      kind: 'input' as const,
      value: formatModelPriceAmount(quote.inputPerMtok, quote.currency),
      ...(originalQuote
        ? {
            originalValue: formatModelPriceAmount(
              originalQuote.inputPerMtok,
              originalQuote.currency,
            ),
          }
        : {}),
    },
    {
      kind: 'output' as const,
      value: formatModelPriceAmount(quote.outputPerMtok, quote.currency),
      ...(originalQuote
        ? {
            originalValue: formatModelPriceAmount(
              originalQuote.outputPerMtok,
              originalQuote.currency,
            ),
          }
        : {}),
    },
    ...(quote.cacheReadPerMtok === undefined
      ? []
      : [
          {
            kind: 'cacheRead' as const,
            value: formatModelPriceAmount(quote.cacheReadPerMtok, quote.currency),
          },
        ]),
    ...(quote.cacheCreatePerMtok === undefined
      ? []
      : [
          {
            kind: 'cacheCreate' as const,
            value: formatModelPriceAmount(quote.cacheCreatePerMtok, quote.currency),
          },
        ]),
  ];
}
