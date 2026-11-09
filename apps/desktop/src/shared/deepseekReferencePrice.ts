import type { ModelReferencePrice } from '@cindy/model-providers';

// DeepSeek explicitly publishes off-peak = peak / 2 (USD pricing, verified 2026-11-09):
// https://api-docs.deepseek.com/quick_start/pricing/
// This is a client reference-estimate policy, NOT a supplier billing timestamp rule.
// Adoption is prospective; date-only history and earlier usage keep the static baseline.
const ADOPTED_AT = Date.parse('2026-11-09T00:00:00Z');
const HOLIDAYS: Record<number, readonly (readonly [string, string])[]> = {
  // https://www.beijing.gov.cn/zhengce/zhengcefagui/202511/t20251104_4258873.html
  2026: [['01-01', '01-03'], ['02-15', '02-23'], ['04-04', '04-06'],
    ['05-01', '05-05'], ['06-19', '06-21'], ['09-25', '09-27'], ['10-01', '10-07']],
  // https://www.forestry.gov.cn/lyj/1/szxx/20261105/695102.html (verified 2026-11-05)
  2027: [['01-01', '01-03'], ['02-05', '02-13'], ['04-03', '04-05'],
    ['05-01', '05-05'], ['06-09', '06-09'], ['09-15', '09-15'], ['10-01', '10-07']],
};

/** Unknown/expired calendars conservatively retain the existing peak estimate. */
export function isDeepseekOffPeak(at: Date): boolean {
  const time = at.getTime();
  if (!Number.isFinite(time) || time < ADOPTED_AT) return false;
  const shanghaiDay = new Date(time + 8 * 60 * 60_000).toISOString();
  const holidays = HOLIDAYS[Number(shanghaiDay.slice(0, 4))];
  if (!holidays) return false;
  const day = at.getUTCDay();
  if (day === 0 || day === 6) return true;
  const localDay = shanghaiDay.slice(5, 10);
  if (holidays.some(([start, end]) => localDay >= start && localDay <= end)) return true;
  const minute = at.getUTCHours() * 60 + at.getUTCMinutes();
  return !(minute >= 60 && minute < 240 || minute >= 360 && minute < 600);
}

/** Next actual band boundary, including midnight/calendar expiry; no polling/network. */
export function nextDeepseekPriceChange(at = new Date()): number | undefined {
  const current = isDeepseekOffPeak(at);
  const midnight = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
  for (let day = 0; day < 16; day += 1) {
    // 16:00 UTC is Shanghai midnight, where calendar coverage may expire.
    for (const hour of [0, 1, 4, 6, 10, 16]) {
      const next = midnight + (day * 24 + hour) * 60 * 60_000;
      if (next > at.getTime() && isDeepseekOffPeak(new Date(next)) !== current) return next;
    }
  }
  return undefined;
}

/** Only the verified direct USD standard tariffs qualify; never halve reseller/unknown rates. */
export function deepseekReferencePriceAt(
  price: ModelReferencePrice,
  baseModelId: string | undefined,
  at?: string | Date,
): ModelReferencePrice {
  const expected = baseModelId === 'deepseek/deepseek-v4-pro'
    ? [1.32, 3.96, 0.044]
    : baseModelId === 'deepseek/deepseek-v4-flash' || baseModelId === 'deepseek/deepseek-v4.1-flash'
      ? [0.30, 1.20, 0.006] : undefined;
  if (!expected || price.currency !== 'USD' || price.variant !== 'standard' ||
      price.minInputTokens !== undefined || price.maxInputTokens !== undefined ||
      price.inputPerMtok !== expected[0] || price.outputPerMtok !== expected[1] ||
      price.cacheReadPerMtok !== expected[2]) return price;
  // A day aggregate does not identify a time band. Never use today's clock for it.
  if (typeof at === 'string') {
    if (!/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(at)) return price;
    const day = new Date(`${at.slice(0, 10)}T00:00:00Z`);
    if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== at.slice(0, 10)) return price;
  }
  const date = at === undefined ? new Date() : at instanceof Date ? at : new Date(at);
  if (!isDeepseekOffPeak(date)) return price;
  return { ...price, inputPerMtok: price.inputPerMtok / 2,
    outputPerMtok: price.outputPerMtok / 2, cacheReadPerMtok: price.cacheReadPerMtok! / 2 };
}
