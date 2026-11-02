/**
 * How full a quota is, for every surface that colors one: the macOS menu bar panel, the
 * iPhone widgets, the Desktop usage card, chip and model picker, and the mobile model picker
 * and session menu. One rule, so a window never reads yellow in one place and red in another.
 *
 * Judged on what is left in the window a surface shows: 30% or less is `warn` (yellow), 10% or
 * less is `crit` (red). A provider's own verdict can only raise the level: a warning is at least
 * `warn`, an exceeded or rejected limit is `crit`.
 */

export type QuotaLevel = 'normal' | 'warn' | 'crit';

export const QUOTA_WARN_REMAINING_PERCENT = 30;
export const QUOTA_CRIT_REMAINING_PERCENT = 10;

const RANK: Record<QuotaLevel, number> = { normal: 0, warn: 1, crit: 2 };

export function quotaLevelFromRemaining(remainingPercent: number): QuotaLevel {
  if (!Number.isFinite(remainingPercent)) return 'normal';
  if (remainingPercent <= QUOTA_CRIT_REMAINING_PERCENT) return 'crit';
  if (remainingPercent <= QUOTA_WARN_REMAINING_PERCENT) return 'warn';
  return 'normal';
}

export function quotaLevelFromUsed(usedPercent: number): QuotaLevel {
  return Number.isFinite(usedPercent) ? quotaLevelFromRemaining(100 - usedPercent) : 'normal';
}

/**
 * A provider's severity string ("warning", "allowed_warning", "exceeded", "rejected",
 * "critical"…) as a level. Anything other than empty or "normal" is at least a warning, so a
 * new upstream value is never shown as normal.
 */
export function quotaLevelFromSeverity(severity: string | null | undefined): QuotaLevel {
  const value = severity?.trim().toLowerCase() ?? '';
  if (!value || value === 'normal') return 'normal';
  if (/exceed|critical|reject|blocked|limit_reached/.test(value)) return 'crit';
  return 'warn';
}

export function strongerQuotaLevel(...levels: QuotaLevel[]): QuotaLevel {
  return levels.reduce<QuotaLevel>((max, level) => (RANK[level] > RANK[max] ? level : max), 'normal');
}

/**
 * Reset-time color on the tube surfaces (Mac panel, iPhone widgets): a window longer than a day
 * that will not be used up at the current pace, so what is left goes to waste at the reset. It is
 * independent of the liquid color: a yellow tube can still reset with a quarter unused.
 * A day or less to go is yellow, six hours or less is red (owner decision 2026-10-31).
 */
export const QUOTA_RESET_WARN_MS = 24 * 60 * 60_000;
export const QUOTA_RESET_CRIT_MS = 6 * 60 * 60_000;
/** Shorter windows (the 5-hour session) always reset within the warning span, so they never color. */
export const QUOTA_RESET_MIN_WINDOW_MS = 24 * 60 * 60_000;

export function resetTimeLevel(leftMs: number, unusedAtReset: boolean): QuotaLevel {
  if (!unusedAtReset || !Number.isFinite(leftMs) || leftMs <= 0) return 'normal';
  if (leftMs <= QUOTA_RESET_CRIT_MS) return 'crit';
  if (leftMs <= QUOTA_RESET_WARN_MS) return 'warn';
  return 'normal';
}

/**
 * Whether a window will still have quota left at its reset at the current pace: what was used
 * over the elapsed part, extended to the reset, stays under 100%.
 */
export function willLeaveQuotaUnused(window: {
  usedPercent: number;
  windowMs: number;
  leftMs: number;
}): boolean {
  const { usedPercent, windowMs, leftMs } = window;
  if (!(windowMs > QUOTA_RESET_MIN_WINDOW_MS) || !(leftMs > 0) || leftMs >= windowMs) return false;
  if (usedPercent >= 100) return false;
  if (usedPercent <= 0) return true;
  const elapsedMs = windowMs - leftMs;
  return usedPercent + (usedPercent / elapsedMs) * leftMs < 100;
}
