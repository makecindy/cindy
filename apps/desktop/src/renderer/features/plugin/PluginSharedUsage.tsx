import { Activity, ArrowDownToLine } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Tip } from '@/components/ui/tooltip';
import { parsePluginMarketSortValue, type PluginMarketItem, type PluginMarketMetric } from '../../../shared/pluginMarket';

function formatCompactCount(count: bigint): string {
  const unit = count >= 1_000_000n ? 1_000_000n : count >= 1_000n ? 1_000n : 1n;
  if (unit === 1n) return count.toString();
  const decimal = ((count % unit) * 10n) / unit;
  return `${count / unit}${decimal ? `.${decimal}` : ''}${unit === 1_000n ? 'k' : 'M'}`;
}

function calendarDay(date: Date): number {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
}

export function formatPluginMarketMetric(metric: PluginMarketMetric, value: PluginMarketItem['sortValue'], locale: string) {
  const sortValue = parsePluginMarketSortValue(value, metric.kind);
  if (typeof sortValue === 'number') {
    return {
      text: formatCompactCount(BigInt(sortValue)),
      label: `${metric.label} ${sortValue.toLocaleString(locale, { useGrouping: true })}`,
    };
  }
  if (typeof sortValue !== 'string') return null;
  const date = new Date(sortValue);
  const days = Math.min(0, (calendarDay(date) - calendarDay(new Date())) / 86_400_000);
  return {
    text: days >= -29
      ? new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(days, 'day')
      : new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(date),
    label: `${metric.label} ${new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(date)}`,
  };
}

/** Shared counters from the authorized server catalog; personal/custom sources never grant access. */
export function PluginSharedUsage({
  detail,
  variant = 'detail',
  onClick,
  leadingSeparator = true,
}: {
  detail: PluginMarketItem;
  variant?: 'detail' | 'list';
  /** Forward clicks when metadata sits above a sibling card-detail button. */
  onClick?: () => void;
  leadingSeparator?: boolean;
}) {
  const { t, i18n } = useTranslation();
  if (detail.sourceType !== 'server' || detail.scope === 'personal') return null;
  const metrics = [
    ...(detail.downloadStatistics
      ? [
          {
            key: 'downloadsValue',
            count: detail.downloadStatistics.requestCount,
            explanation: 'downloadExplanation',
            Icon: ArrowDownToLine,
          },
        ]
      : []),
    ...(variant === 'detail' && detail.usageStatistics?.usageCount !== undefined
      ? [
          {
            key: 'usesValue',
            count: detail.usageStatistics.usageCount,
            explanation: 'usesExplanation',
            Icon: Activity,
          },
        ]
      : []),
  ];
  return metrics.map(({ key, count, explanation, Icon }, index) => {
    const numericCount = BigInt(count);
    const label = t(`settings.ghosts.usage.${key}`, {
      value: numericCount.toLocaleString(i18n.language),
    });
    const description = t(`settings.ghosts.usage.${explanation}`);
    return (
      <span key={key} className="inline-flex max-w-full items-center gap-1.5">
        {leadingSeparator || index > 0 ? <span aria-hidden="true">·</span> : null}
        <Tip text={variant === 'list' ? label : description}>
          <span
            role="group"
            aria-label={label}
            aria-description={description}
            onClick={onClick}
            tabIndex={variant === 'detail' ? 0 : undefined}
            className={`inline-flex min-w-0 items-center gap-1 rounded-full tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] ${variant === 'detail' ? '-mx-1 min-h-7 px-1' : 'pointer-events-auto relative z-[1]'}`}
          >
            <Icon size={12} className="shrink-0" aria-hidden="true" />
            <span className="break-words [overflow-wrap:anywhere]">{variant === 'list' ? formatCompactCount(numericCount) : label}</span>
          </span>
        </Tip>
      </span>
    );
  });
}
