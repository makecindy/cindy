/**
 * UsageStatRow — 用量历史页顶部统计条 (五格)。
 *
 * 未知值统一用 "—" 占位, 不显示误导性的 0 —— 与首页仪表盘同一处理。
 * 缓存命中率低于 LOW_CACHE_HIT_RATE 时标 warning 色, 与消息卡片的「缓存命中率偏低」同阈值。
 */

import React from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { Tip } from '@/components/ui/tooltip';
import { formatCompactTokens } from '@/lib/usageFormat';
import { LOW_CACHE_HIT_RATE, type UsageSummary } from './usageHistoryStats';
import { formatUsagePercent } from './formatUsagePercent';

const UNKNOWN_VALUE = '—';

function StatCell({
  value,
  label,
  warning,
  tip,
}: {
  value: string;
  label: string;
  warning?: boolean;
  tip?: string | null;
}): React.JSX.Element {
  const cell = (
    <div className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-lg bg-[var(--surface-chip)] px-3 py-2">
      <span
        className={cn(
          'truncate text-14 font-semibold leading-[1.429] tabular-nums',
          warning ? 'text-[var(--warning-accent)]' : 'text-[var(--text-primary)]',
        )}
      >
        {value}
      </span>
      <span className="truncate text-11 leading-[1.273] text-[var(--text-tertiary)]">{label}</span>
    </div>
  );
  return tip ? <Tip text={tip}>{cell}</Tip> : cell;
}

export function UsageStatRow({ summary }: { summary: UsageSummary }): React.JSX.Element {
  const { t } = useTranslation();
  const lowCache =
    summary.cacheHitRate !== null && summary.cacheHitRate < LOW_CACHE_HIT_RATE;

  return (
    <div className="flex gap-2">
      <StatCell
        value={
          summary.todayTokens > 0 ? formatCompactTokens(summary.todayTokens) : UNKNOWN_VALUE
        }
        label={t('usageHistory.stats.todayTokens')}
      />
      <StatCell
        value={
          summary.last30DaysTokens > 0
            ? formatCompactTokens(summary.last30DaysTokens)
            : UNKNOWN_VALUE
        }
        label={t('usageHistory.stats.totalTokens')}
      />
      <StatCell
        value={t('usageDashboard.streakValue', {
          current: summary.streak.current,
          longest: summary.streak.longest,
        })}
        label={t('usageHistory.stats.streak')}
      />
      <StatCell
        value={
          summary.cacheHitRate === null
            ? UNKNOWN_VALUE
            : formatUsagePercent(summary.cacheHitRate)
        }
        label={t('usageHistory.stats.cacheHitRate')}
        warning={lowCache}
        tip={t('usageHistory.cacheHitTooltip')}
      />
      <StatCell
        value={String(summary.modelCount)}
        label={t('usageHistory.stats.models')}
      />
    </div>
  );
}
