import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { formatCompactTokens } from '@/lib/usageFormat';
import type { HourlyTokenUsageRow } from '../../../../shared/hourlyTokenUsage';

/** A read-only distribution; the existing page date input selects its day. */
export function UsageHourlyTokens({
  rows,
  day,
  incomplete,
}: {
  rows?: HourlyTokenUsageRow[];
  day: string;
  incomplete?: boolean;
}): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const hours = useMemo(() => {
    const totals = Array<number>(24).fill(0);
    for (const row of rows ?? []) {
      if (row.day === day && Number.isInteger(row.hour) && row.hour >= 0 && row.hour < 24) {
        totals[row.hour] += row.tokens;
      }
    }
    return totals;
  }, [rows, day]);
  const total = hours.reduce((sum, tokens) => sum + tokens, 0);
  const max = Math.max(...hours);
  const percent = new Intl.NumberFormat(i18n.language, {
    style: 'percent',
    maximumFractionDigits: 1,
  });
  const hourLabel = (hour: number): string => `${String(hour).padStart(2, '0')}:00`;
  const path = hours
    .map(
      (tokens, hour) =>
        `${hour === 0 ? 'M' : 'L'} ${12 + hour * 30} ${100 - (tokens / Math.max(max, 1)) * 88}`,
    )
    .join(' ');
  return (
    <div>
      <p className="mb-3 text-12 leading-normal text-[var(--text-secondary)]">
        {t('usageHistory.hourly.description')}
      </p>
      {incomplete || rows === undefined ? (
        <p className="mb-3 text-12 text-[var(--text-secondary)]" role="status">
          {t('usageHistory.hourly.partial')}
        </p>
      ) : null}
      {total > 0 ? (
        <>
          <p className="mb-2 text-13 text-[var(--text-primary)]">
            {t('usageHistory.hourly.peak', {
              hours: hours
                .flatMap((tokens, hour) =>
                  tokens === max ? [`${hourLabel(hour)}–${hourLabel(hour + 1)}`] : [],
                )
                .join(', '),
              tokens: formatCompactTokens(max),
              share: percent.format(max / total),
            })}
          </p>
          <svg
            viewBox="0 0 714 112"
            preserveAspectRatio="none"
            className="h-28 w-full"
            role="img"
            aria-label={t('usageHistory.hourly.chartLabel', { day })}
          >
            <path d="M 12 100 H 702" fill="none" stroke="var(--border-default)" />
            <path
              d={path}
              fill="none"
              stroke="var(--text-secondary)"
              strokeWidth="2"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          <div
            className="relative h-4 text-11 tabular-nums text-[var(--text-tertiary)]"
            aria-hidden="true"
          >
            {[0, 6, 12, 18, 23].map((hour) => (
              <span
                key={hour}
                className="absolute"
                style={
                  hour === 0
                    ? { left: 0 }
                    : hour === 23
                      ? { right: 0 }
                      : {
                          left: `${((12 + hour * 30) / 714) * 100}%`,
                          transform: 'translateX(-50%)',
                        }
                }
              >
                {hourLabel(hour)}
              </span>
            ))}
          </div>
          <details className="mt-3">
            <summary className="inline-flex min-h-9 cursor-pointer items-center rounded-full border border-[var(--border-default)] px-3 text-13 text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]">
              {t('usageHistory.hourly.details')}
            </summary>
            <table className="mt-3 w-full text-13 tabular-nums text-[var(--text-primary)]">
              <thead className="text-12 text-[var(--text-secondary)]">
                <tr>
                  <th scope="col" className="py-2 text-left font-medium">
                    {t('usageHistory.hourly.hour')}
                  </th>
                  <th scope="col" className="py-2 text-right font-medium">
                    {t('usageHistory.hourly.tokens')}
                  </th>
                  <th scope="col" className="py-2 text-right font-medium">
                    {t('usageHistory.hourly.share')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {hours.map((tokens, hour) => (
                  <tr key={hour} className="border-t border-[var(--border-default)]">
                    <th scope="row" className="py-2 text-left font-normal">
                      {hourLabel(hour)}–{hourLabel(hour + 1)}
                    </th>
                    <td className="py-2 text-right">{tokens.toLocaleString(i18n.language)}</td>
                    <td className="py-2 text-right">{percent.format(tokens / total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </>
      ) : (
        <p className="py-4 text-13 text-[var(--text-secondary)]">
          {t('usageHistory.hourly.empty')}
        </p>
      )}
    </div>
  );
}
