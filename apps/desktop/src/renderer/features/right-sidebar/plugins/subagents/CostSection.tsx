import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { SubagentCostSnapshot } from '@cindy/maker-shared/subagent-workspace';

import { formatCompactTokens } from '@/lib/usageFormat';

interface CostSectionProps {
  costSnapshot?: SubagentCostSnapshot;
}

function formatCost(amount: number): string {
  if (amount < 0.01) return '<$0.01';
  if (amount < 1) return `$${amount.toFixed(3)}`;
  return `$${amount.toFixed(2)}`;
}

export function CostSection({ costSnapshot }: CostSectionProps) {
  const { t } = useTranslation();

  if (!costSnapshot || costSnapshot.quality === 'unavailable') {
    return null;
  }

  const { quality, cost, breakdown } = costSnapshot;
  const qualityLabel =
    quality === 'actual'
      ? t('rightSidebar.subagents.costActual')
      : t('rightSidebar.subagents.costEstimated');

  const breakdownRows = useMemo(() => {
    if (!breakdown) return [];
    const rows: { label: string; value: string }[] = [];
    if (typeof breakdown.inputTokens === 'number') {
      rows.push({
        label: t('rightSidebar.subagents.inputTokens'),
        value: formatCompactTokens(breakdown.inputTokens),
      });
    }
    if (typeof breakdown.outputTokens === 'number') {
      rows.push({
        label: t('rightSidebar.subagents.outputTokens'),
        value: formatCompactTokens(breakdown.outputTokens),
      });
    }
    if (typeof breakdown.cacheReadTokens === 'number') {
      rows.push({
        label: t('rightSidebar.subagents.cacheReadTokens'),
        value: formatCompactTokens(breakdown.cacheReadTokens),
      });
    }
    if (typeof breakdown.cacheCreateTokens === 'number') {
      rows.push({
        label: t('rightSidebar.subagents.cacheCreateTokens'),
        value: formatCompactTokens(breakdown.cacheCreateTokens),
      });
    }
    return rows;
  }, [breakdown, t]);

  return (
    <section className="mt-5">
      <h3 className="mb-2 text-11 font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)]">
        {t('rightSidebar.subagents.cost')}
      </h3>

      <div className="flex items-center gap-2">
        {cost ? (
          <span className="text-13 font-medium text-[var(--text-primary)]">
            {formatCost(cost.amount)}
          </span>
        ) : null}
        <span
          className={
            quality === 'actual'
              ? 'rounded px-1.5 py-0.5 text-10 font-medium bg-[var(--success-surface)] text-[var(--success-fg)]'
              : 'rounded px-1.5 py-0.5 text-10 font-medium bg-[var(--warning-surface)] text-[var(--warning-fg)]'
          }
        >
          {qualityLabel}
        </span>
      </div>

      {breakdownRows.length > 0 ? (
        <div className="mt-2">
          <span className="text-11 text-[var(--text-tertiary)]">
            {t('rightSidebar.subagents.tokenBreakdown')}
          </span>
          <dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-11">
            {breakdownRows.map((row) => (
              <div key={row.label} className="contents">
                <dt className="text-[var(--text-tertiary)]">{row.label}</dt>
                <dd className="text-[var(--text-secondary)]">{row.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
    </section>
  );
}
