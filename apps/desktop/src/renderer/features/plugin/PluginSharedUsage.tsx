import { Activity, ArrowDownToLine } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Tip } from '@/components/ui/tooltip';
import type { PluginMarketItem } from '../../../shared/pluginMarket';

/** Shared counters from the authorized server catalog; personal/custom sources never grant access. */
export function PluginSharedUsage({
  detail,
  variant = 'detail',
}: {
  detail: PluginMarketItem;
  variant?: 'detail' | 'list';
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
  return metrics.map(({ key, count, explanation, Icon }) => {
    const label = t(`settings.ghosts.usage.${key}`, {
      value: BigInt(count).toLocaleString(i18n.language),
    });
    const description = t(`settings.ghosts.usage.${explanation}`);
    return (
      <span key={key} className="inline-flex max-w-full items-center gap-1.5">
        <span aria-hidden="true">·</span>
        <Tip text={description}>
          <span
            role="group"
            aria-label={label}
            aria-description={description}
            tabIndex={variant === 'detail' ? 0 : undefined}
            className={`inline-flex min-w-0 items-center gap-1 rounded-full tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] ${variant === 'detail' ? '-mx-1 min-h-7 px-1' : ''}`}
          >
            <Icon size={12} className="shrink-0" aria-hidden="true" />
            <span className="break-words [overflow-wrap:anywhere]">{label}</span>
          </span>
        </Tip>
      </span>
    );
  });
}
