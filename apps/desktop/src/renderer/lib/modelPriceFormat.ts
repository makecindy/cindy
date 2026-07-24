import type {
  ModelPriceQuote,
  MoneyCurrency,
} from '../../shared/regionalMoney';

function compactNumber(value: number): string {
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: value > 0 && value < 0.01 ? 4 : 2,
    useGrouping: false,
  }).format(value);
}

export function formatModelPriceAmount(
  amount: number,
  currency: MoneyCurrency,
): string {
  return `${currency === 'CNY' ? '¥' : '$'}${compactNumber(amount)}`;
}

export function formatModelPricePair(quote: ModelPriceQuote): string {
  const input = formatModelPriceAmount(quote.inputPerMtok, quote.currency);
  const output = formatModelPriceAmount(quote.outputPerMtok, quote.currency);
  return `${quote.approximate ? '≈' : ''}${input} / ${output}`;
}

export function modelPriceDetailRows(
  quote: ModelPriceQuote,
): Array<{
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
            value: formatModelPriceAmount(
              quote.cacheReadPerMtok,
              quote.currency,
            ),
          },
        ]),
    ...(quote.cacheCreatePerMtok === undefined
      ? []
      : [
          {
            kind: 'cacheCreate' as const,
            value: formatModelPriceAmount(
              quote.cacheCreatePerMtok,
              quote.currency,
            ),
          },
        ]),
  ];
}
