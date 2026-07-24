/**
 * Currency display helpers shared by the billing surfaces. Amounts arrive as
 * exact decimal strings (or integer minor units) from the server; formatting
 * must not re-introduce binary floating point rounding artifacts.
 */

export function formatBillingAmount(amount: string, currency: string): string {
  const numeric = Number(amount);
  if (!Number.isFinite(numeric)) return `${amount} ${currency.toUpperCase()}`;
  try {
    const fmt = new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: currency.toUpperCase(),
    });
    const digits = fmt.resolvedOptions().maximumFractionDigits ?? 2;
    // Shift the decimal string by the currency exponent before rounding so
    // midpoints stay exact: Number('1.005e2') is exactly 100.5, while
    // 1.005 * 100 drifts to 100.49999…. Round the magnitude and reapply the
    // sign so negative midpoints also round half away from zero
    // (-1.005 → -1.01; a bare Math.round would yield -1.00).
    const unsigned = amount.trim().replace(/^-/, '');
    const magnitude = Number(Math.round(Number(unsigned + 'e' + digits)) + 'e-' + digits);
    const rounded = numeric < 0 && magnitude !== 0 ? -magnitude : magnitude;
    return fmt.format(Number.isFinite(rounded) ? rounded : numeric);
  } catch {
    return `${amount} ${currency.toUpperCase()}`;
  }
}

export function formatBillingMinorAmount(minor: number, currency: string): string {
  try {
    const digits =
      new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: currency.toUpperCase(),
      }).resolvedOptions().maximumFractionDigits ?? 2;
    // Rebuild the exact decimal string instead of dividing, so the value never
    // passes through an inexact binary intermediate.
    const scale = 10 ** digits;
    const abs = Math.abs(minor);
    const whole = Math.floor(abs / scale);
    const fraction = digits > 0 ? `.${String(abs % scale).padStart(digits, '0')}` : '';
    return formatBillingAmount(`${minor < 0 ? '-' : ''}${whole}${fraction}`, currency);
  } catch {
    return `${minor} ${currency.toUpperCase()}`;
  }
}
