/**
 * UsageStatRow — 用量历史页顶部统计条 (五格)。
 *
 * 未知值统一用 "—" 占位, 不显示误导性的 0 —— 与首页仪表盘同一处理。
 *
 * 缓存命中率**不着色**: DESIGN.md §2 把 --warning-accent 限定给已登记的消费者
 * (运行状态栏、呼吸图标、权限高亮等), 用量页的效率指标不在名单内, 新增消费者要先改规范。
 * 口径说明放表头 tooltip, 数值本身保持中性。
 */

import React from 'react';
import { useTranslation } from 'react-i18next';

import { Tip } from '@/components/ui/tooltip';
import { formatCompactTokens } from '@/lib/usageFormat';
import { type UsageSummary } from './usageHistoryStats';
import { formatUsagePercent } from './formatUsagePercent';

const UNKNOWN_VALUE = '—';

function StatCell({
  value,
  label,
  tip,
}: {
  value: string;
  label: string;
  tip?: string | null;
}): React.JSX.Element {
  const cell = (
    <div className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-lg bg-[var(--surface-chip)] px-3 py-2">
      <span className="truncate text-14 font-semibold leading-[1.429] tabular-nums text-[var(--text-primary)]">
        {value}
      </span>
      <span className="truncate text-11 leading-[1.273] text-[var(--text-tertiary)]">{label}</span>
    </div>
  );
  return tip ? <Tip text={tip}>{cell}</Tip> : cell;
}

export function UsageStatRow({
  summary,
  rangeLabel,
  todayLabel,
  hideToday = false,
}: {
  summary: UsageSummary;
  rangeLabel: string;
  todayLabel?: string;
  /** Exact-day drilldown already has the same value in the range card. */
  hideToday?: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();

  return (
    <div className="flex gap-2">
      {!hideToday ? (
        <StatCell
          value={summary.todayTokens > 0 ? formatCompactTokens(summary.todayTokens) : UNKNOWN_VALUE}
          label={todayLabel ?? t('usageHistory.stats.todayTokens')}
        />
      ) : null}
      <StatCell
        value={
          summary.last30DaysTokens > 0
            ? formatCompactTokens(summary.last30DaysTokens)
            : UNKNOWN_VALUE
        }
        label={t('usageHistory.stats.totalTokensInRange', { range: rangeLabel })}
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
          summary.cacheHitRate === null ? UNKNOWN_VALUE : formatUsagePercent(summary.cacheHitRate)
        }
        label={t('usageHistory.stats.cacheHitRateInRange', { range: rangeLabel })}
        tip={t('usageHistory.cacheHitTooltip')}
      />
      <StatCell value={String(summary.modelCount)} label={t('usageHistory.stats.models')} />
    </div>
  );
}
