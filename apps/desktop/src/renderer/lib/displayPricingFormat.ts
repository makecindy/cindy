import type { ModelDisplayPricing, SummaryQuote } from '@cindy/model-providers';

/** Unknown categories are ordinary uncategorized quotes, not inferred from their units. */
export function displayPricingComponent(component: string | undefined) {
  return component === 'text' || component === 'image' || component === 'audio' || component === 'video'
    ? component
    : undefined;
}

/** Keep the quoted basis; do not convert mixed units or infer a model-wide starting price. */
export function displayPricingAmount(
  item: Pick<SummaryQuote, 'price' | 'maxPrice'>,
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
  const upper = item.maxPrice ?? item.price;
  const range = (low: number, high: number) => {
    if (low === high) return money(low);
    let lowText = number.format(low);
    let highText = number.format(high);
    // Raise precision only when rounding would hide a distinct upper bound.
    // Seventeen significant digits distinguish all finite JavaScript numbers.
    for (let digits = 9; lowText === highText && digits <= 17; digits++) {
      const precise = new Intl.NumberFormat(locale, {
        maximumSignificantDigits: digits,
        useGrouping: false,
      });
      lowText = precise.format(low);
      highText = precise.format(high);
    }
    return `${symbol}${lowText}–${symbol}${highText}`;
  };
  return {
    current: range(amount, upper * (1 - discount)),
    ...(discount > 0 && upper > 0 ? { original: range(item.price, upper) } : {}),
    free: upper === 0 || discount === 1,
  };
}

/** Quantity is a display denominator, never a conversion of the supplier's price. */
export function displayPricingQuantity(quantity: number, locale: string, million: string): string {
  if (quantity === 1) return '';
  if (quantity === 1_000_000) return million;
  return new Intl.NumberFormat(locale, { maximumSignificantDigits: 12 }).format(quantity);
}

/** Hide only a plain table whose items match distinct summary quotes exactly. */
export function isDisplayPricingTableRedundant(pricing: ModelDisplayPricing): boolean {
  if (!pricing.summary || pricing.notes?.length) return false;
  const unmatched = Object.values(pricing.summary).flat();
  if (pricing.items.length !== unmatched.length) return false;
  for (const item of pricing.items) {
    if (item.tier || (item.priceType && item.priceType !== 'exact')) return false;
    const index = unmatched.findIndex(quote =>
      quote.unit === item.unit && quote.quantity === item.quantity && quote.price === item.price &&
      quote.maxPrice === undefined && !quote.tier,
    );
    if (index === -1) return false;
    unmatched.splice(index, 1);
  }
  return true;
}

/** Chinese/Japanese counters join CJK units; Latin units and other locales keep a space. */
export function displayPricingDenominator(quantity: string, unit: string, locale: string): string {
  if (!quantity) return `/ ${unit}`;
  const join = /^(zh|ja)(-|$)/i.test(locale) && /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(unit);
  return `/ ${quantity}${join ? '' : ' '}${unit}`;
}
