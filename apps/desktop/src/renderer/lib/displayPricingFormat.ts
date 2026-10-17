import type { ModelDisplayPricing } from '@cindy/model-providers';

/** Keep the quoted basis; do not convert mixed units or infer a model-wide starting price. */
export function displayPricingAmount(
  item: ModelDisplayPricing['items'][number],
  currency: 'CNY' | 'USD',
  costDiscount: number | undefined,
  locale: string,
): { current: string; original?: string; free: boolean } {
  const discount =
    typeof costDiscount === 'number' &&
    Number.isFinite(costDiscount) &&
    costDiscount >= 0 &&
    costDiscount <= 1
      ? costDiscount
      : 0;
  const amount = item.price * (1 - discount);
  const number = new Intl.NumberFormat(locale, {
    maximumSignificantDigits: 8,
    useGrouping: false,
  });
  // Match existing model prices while preserving small per-unit amounts.
  const symbol = currency === 'CNY' ? '¥' : '$';
  const money = (value: number) => `${symbol}${number.format(value)}`;
  return {
    current: money(amount),
    ...(discount > 0 && item.price > 0 ? { original: money(item.price) } : {}),
    free: item.price === 0 || discount === 1,
  };
}
