import type { TFunction } from 'i18next';
import { formatDuration } from '@cindy/maker-shared/message-render';

/** Localize promoted units while retaining each caller's existing short-time precision. */
export function formatSessionDuration(
  ms: number,
  t?: TFunction,
  options: Parameters<typeof formatDuration>[1] = {},
): string {
  return formatDuration(ms, {
    ...options,
    formatLongDuration: t
      ? ({ days, hours, minutes }) => days > 0
        ? t('usageDetails.durationDaysHoursMinutes', { days, hours, minutes })
        : t('usageDetails.durationHoursMinutes', { hours, minutes })
      : undefined,
  });
}

export function formatShellDuration(ms: number, t: TFunction): string {
  return ms >= 3_600_000 ? formatSessionDuration(ms, t) : `${ms}ms`;
}

export function formatCompactionDuration(ms: number, t: TFunction): string {
  return ms >= 3_600_000 ? formatSessionDuration(ms, t) : `${(ms / 1000).toFixed(1)}s`;
}
