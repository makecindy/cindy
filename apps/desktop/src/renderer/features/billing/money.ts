/**
 * Currency display helpers shared by the billing surfaces. Amounts arrive as
 * exact decimal strings (or integer minor units) from the server; formatting
 * must not re-introduce binary floating point rounding artifacts.
 */

import { CURRENT_CINDY_REGION } from '../../../shared/brandRegion';

/**
 * 计费面的币种由发行区域决定（服务端下发的金额本身不带币种）。所有展示余额 /
 * 充值金额的界面必须用同一个常量，否则同一笔钱会在两个界面显示成不同货币
 * （见 TodaySpendChip 的「与账单页 BILLING_CURRENCY 同一笔钱、必须同口径」注释）。
 */
export const BILLING_CURRENCY = CURRENT_CINDY_REGION === 'global' ? 'usd' : 'cny';

const DECIMAL_PATTERN = /^([+-]?)(\d+)(?:\.(\d+))?$/;

function billingCurrencyFormatOptions(currency: string): Intl.NumberFormatOptions {
  const normalizedCurrency = currency.toUpperCase();
  return {
    style: 'currency',
    currency: normalizedCurrency,
    ...(normalizedCurrency === 'USD' ? { currencyDisplay: 'narrowSymbol' } : {}),
  };
}

function roundToMinorUnits(amount: string, digits: number): bigint | null {
  const matched = DECIMAL_PATTERN.exec(amount.trim());
  if (!matched) return null;

  const [, sign, whole, fraction = ''] = matched;
  const scale = 10n ** BigInt(digits);
  const keptFraction = fraction.slice(0, digits).padEnd(digits, '0');
  let minor = BigInt(whole) * scale + BigInt(keptFraction || '0');
  if ((fraction[digits] ?? '0') >= '5') minor += 1n;
  return sign === '-' && minor !== 0n ? -minor : minor;
}

function formatMinorUnits(
  minor: bigint,
  formatter: Intl.NumberFormat,
  digits: number,
): string {
  const scale = 10n ** BigInt(digits);
  const negative = minor < 0n;
  const magnitude = negative ? -minor : minor;
  const whole = magnitude / scale;
  const fraction = magnitude % scale;
  // BigInt has no negative zero, so use Number -0 only as a locale-layout
  // sentinel when a negative amount rounds to a magnitude below one unit.
  const formattedWhole = negative ? (whole === 0n ? -0 : -whole) : whole;
  const resolved = formatter.resolvedOptions();
  const localizedFraction =
    digits === 0
      ? ''
      : new Intl.NumberFormat(resolved.locale, {
          numberingSystem: resolved.numberingSystem,
          useGrouping: false,
          minimumIntegerDigits: digits,
          maximumFractionDigits: 0,
        }).format(fraction);

  return formatter
    .formatToParts(formattedWhole)
    .map((part) => (part.type === 'fraction' ? localizedFraction : part.value))
    .join('');
}

export function formatBillingAmount(amount: string, currency: string, locale?: string): string {
  try {
    const fmt = new Intl.NumberFormat(locale, billingCurrencyFormatOptions(currency));
    const digits = fmt.resolvedOptions().maximumFractionDigits ?? 2;
    const minor = roundToMinorUnits(amount, digits);
    return minor === null
      ? `${amount} ${currency.toUpperCase()}`
      : formatMinorUnits(minor, fmt, digits);
  } catch {
    return `${amount} ${currency.toUpperCase()}`;
  }
}

export function formatBillingMinorAmount(
  minor: number,
  currency: string,
  locale?: string,
): string {
  try {
    if (!Number.isSafeInteger(minor)) return `${minor} ${currency.toUpperCase()}`;
    const fmt = new Intl.NumberFormat(locale, billingCurrencyFormatOptions(currency));
    const digits = fmt.resolvedOptions().maximumFractionDigits ?? 2;
    return formatMinorUnits(BigInt(minor), fmt, digits);
  } catch {
    return `${minor} ${currency.toUpperCase()}`;
  }
}
