import type { ModelPriceQuote, MoneyCurrency } from '../../shared/regionalMoney';

interface EffectiveModelCost {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

interface CompleteEffectiveModelCost {
  input: number;
  output: number;
  cacheRead: number | undefined;
  cacheWrite: number | undefined;
}

// 各价格维度的缩放比例小于这个阈值时视为浮点噪声,按标准价展示。
const MIN_EFFECTIVE_PRICE_GAP = 0.0005;

export type ModelPricePresentation =
  | { kind: 'free' }
  | {
      kind: 'priced';
      current: ModelPriceQuote;
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

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * effectiveCost 能否直接当展示价:要求已展示的 input / output / 缓存价格
 * 相对标准价都是同一个缩放比例。标准价中的非零缓存维度必须有实际价对应,
 * 避免在同一张明细表中混用实际价与标准价。
 */
function effectiveCostIsConsistent(
  quote: ModelPriceQuote,
  cost: CompleteEffectiveModelCost,
): boolean {
  const gaps: number[] = [];
  for (const [standard, effective] of [
    [quote.inputPerMtok, cost.input],
    [quote.outputPerMtok, cost.output],
    [quote.cacheReadPerMtok, cost.cacheRead],
    [quote.cacheCreatePerMtok, cost.cacheWrite],
  ] as const) {
    if (standard === undefined) continue;
    if (!isNonNegativeFinite(standard)) return false;
    if (effective === undefined && standard === 0) continue;
    if (!isNonNegativeFinite(effective)) return false;
    if (standard === 0) {
      if (effective !== 0) return false;
      continue;
    }
    const gap = 1 - effective / standard;
    if (gap < MIN_EFFECTIVE_PRICE_GAP || gap > 1) return false;
    gaps.push(gap);
  }
  if (gaps.length === 0) return false;
  return gaps.every((gap) => Math.abs(gap - gaps[0]) < 1e-9);
}

/**
 * 构建模型选择器的展示价格。quote 继续保留用量估算所需的标准价；
 * CatalogModel.cost 承载 XD 模型的实际展示价，一致时直接覆盖 input / output。
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
    (quote === null ||
      (quote.inputPerMtok === 0 &&
        quote.outputPerMtok === 0 &&
        (!quote.cacheReadPerMtok || quote.cacheReadPerMtok === 0) &&
        (!quote.cacheCreatePerMtok || quote.cacheCreatePerMtok === 0)))
  ) {
    return { kind: 'free' };
  }
  if (quote === null) return null;
  if (!hasEffectiveCost) return { kind: 'priced', current: quote };

  const cacheRead = effectiveCost?.cacheRead;
  const cacheWrite = effectiveCost?.cacheWrite;
  if (!effectiveCostIsConsistent(quote, { input, output, cacheRead, cacheWrite })) {
    return { kind: 'priced', current: quote };
  }
  return {
    kind: 'priced',
    current: {
      ...quote,
      inputPerMtok: input,
      outputPerMtok: output,
      ...(quote.cacheReadPerMtok !== undefined
        ? { cacheReadPerMtok: cacheRead ?? quote.cacheReadPerMtok }
        : {}),
      ...(quote.cacheCreatePerMtok !== undefined
        ? { cacheCreatePerMtok: cacheWrite ?? quote.cacheCreatePerMtok }
        : {}),
    },
  };
}

export function modelPriceDetailRows(quote: ModelPriceQuote): Array<{
  kind: 'input' | 'output' | 'cacheRead' | 'cacheCreate';
  value: string;
}> {
  return [
    {
      kind: 'input' as const,
      value: formatModelPriceAmount(quote.inputPerMtok, quote.currency),
    },
    {
      kind: 'output' as const,
      value: formatModelPriceAmount(quote.outputPerMtok, quote.currency),
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
