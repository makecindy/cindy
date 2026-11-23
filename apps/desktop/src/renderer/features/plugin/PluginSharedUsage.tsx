import { Activity, ArrowDownToLine } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Tip } from '@/components/ui/tooltip';
import type { PluginMarketItem } from '../../../shared/pluginMarket';

function formatDownloadCount(count: bigint): string {
  const unit = count >= 1_000_000n ? 1_000_000n : count >= 1_000n ? 1_000n : 1n;
  if (unit === 1n) return count.toString();
  const decimal = ((count % unit) * 10n) / unit;
  return `${count / unit}${decimal ? `.${decimal}` : ''}${unit === 1_000n ? 'k' : 'M'}`;
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
  if (detail.sourceType !== 'server' || detail.scope === 'personal') return null;
  return (
    <PluginUsageCounters
      downloadCount={detail.downloadStatistics?.requestCount}
      usageCount={detail.usageStatistics?.usageCount}
      variant={variant}
      onClick={onClick}
      leadingSeparator={leadingSeparator}
    />
  );
}

/**
 * Download / use counters with their shared explanations. Counts are decimal strings from the
 * server; a missing count is unavailable and is not shown as zero.
 */
export function PluginUsageCounters({
  downloadCount,
  usageCount,
  variant = 'detail',
  onClick,
  leadingSeparator = true,
}: {
  downloadCount?: string;
  usageCount?: string;
  variant?: 'detail' | 'list';
  onClick?: () => void;
  /** False when the counters start a line: no dot before the first one. */
  leadingSeparator?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const metrics = [
    ...(downloadCount !== undefined
      ? [
          {
            key: 'downloadsValue',
            count: downloadCount,
            explanation: 'downloadExplanation',
            Icon: ArrowDownToLine,
          },
        ]
      : []),
    ...(variant === 'detail' && usageCount !== undefined
      ? [
          {
            key: 'usesValue',
            count: usageCount,
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
            <span className="break-words [overflow-wrap:anywhere]">{variant === 'list' ? formatDownloadCount(numericCount) : label}</span>
          </span>
        </Tip>
      </span>
    );
  });
}
