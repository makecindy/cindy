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
  return `${input} / ${output}`;
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

/**
 * effectiveCost 能否直接当展示价,以及折价幅度是多少:要求已展示的 input / output /
 * 缓存价格相对标准价都是同一个缩放比例。标准价中的非零缓存维度必须有实际价对应,
 * 避免在同一张明细表中混用实际价与标准价。比例不一致时返回 undefined —— 展示层
 * 退回标准价,不挂折价徽标也不做原价对比。
 */
function inferDiscount(
  quote: ModelPriceQuote,
  cost: CompleteEffectiveModelCost,
): number | undefined {
  const gaps: number[] = [];
  for (const [standard, effective] of [
    [quote.inputPerMtok, cost.input],
    [quote.outputPerMtok, cost.output],
    [quote.cacheReadPerMtok, cost.cacheRead],
    [quote.cacheCreatePerMtok, cost.cacheWrite],
  ] as const) {
    if (standard === undefined) continue;
    if (!isNonNegativeFinite(standard)) return undefined;
    if (effective === undefined && standard === 0) continue;
    if (!isNonNegativeFinite(effective)) return undefined;
    if (standard === 0) {
      if (effective !== 0) return undefined;
      continue;
    }
    const gap = 1 - effective / standard;
    if (gap < MIN_EFFECTIVE_PRICE_GAP || gap > 1) return undefined;
    gaps.push(gap);
  }
  if (gaps.length === 0) return undefined;
  return gaps.every((gap) => Math.abs(gap - gaps[0]) < 1e-9) ? gaps[0] : undefined;
}

/**
 * 构建模型选择器的展示价格。quote 继续保留用量估算所需的标准价；
 * CatalogModel.cost 承载 XD 模型的折后展示价，比例一致时覆盖 input / output /
 * 缓存价，并把标准价留在 original 供原价对比与折价徽标使用。
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
  const discount = inferDiscount(quote, { input, output, cacheRead, cacheWrite });
  if (discount === undefined) return { kind: 'priced', current: quote };
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
  // 折后价与标准价相同的维度(例如两边都是 0)不划线,避免出现「¥0 划掉 ¥0」。
  const originalOf = (value: string, original: number | undefined) => {
    if (!originalQuote || original === undefined) return {};
    const originalValue = formatModelPriceAmount(original, originalQuote.currency);
    return originalValue === value ? {} : { originalValue };
  };
  const inputValue = formatModelPriceAmount(quote.inputPerMtok, quote.currency);
  const outputValue = formatModelPriceAmount(quote.outputPerMtok, quote.currency);
  return [
    {
      kind: 'input' as const,
      value: inputValue,
      ...originalOf(inputValue, originalQuote?.inputPerMtok),
    },
    {
      kind: 'output' as const,
      value: outputValue,
      ...originalOf(outputValue, originalQuote?.outputPerMtok),
    },
    ...(quote.cacheReadPerMtok === undefined
      ? []
      : [
          {
            kind: 'cacheRead' as const,
            value: formatModelPriceAmount(quote.cacheReadPerMtok, quote.currency),
            ...originalOf(
              formatModelPriceAmount(quote.cacheReadPerMtok, quote.currency),
              originalQuote?.cacheReadPerMtok,
            ),
          },
        ]),
    ...(quote.cacheCreatePerMtok === undefined
      ? []
      : [
          {
            kind: 'cacheCreate' as const,
            value: formatModelPriceAmount(quote.cacheCreatePerMtok, quote.currency),
            ...originalOf(
              formatModelPriceAmount(quote.cacheCreatePerMtok, quote.currency),
              originalQuote?.cacheCreatePerMtok,
            ),
          },
        ]),
  ];
}
