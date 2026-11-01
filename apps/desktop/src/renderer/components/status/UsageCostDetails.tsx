import { useTranslation } from 'react-i18next';
import { usageCostTotals, type UsageCostRow } from '@cindy/maker-shared/usage-cost-details';
import { formatTurnCostMoney } from '@/lib/usageFormat';

export function UsageCostDetails({ rows }: { rows: UsageCostRow[] | null | undefined }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3 text-12 text-[var(--text-primary)]" data-testid="usage-cost-details">
      <div className="font-medium">{t('usageCost.title')}</div>
      {rows == null ? (
        <p className="text-[var(--text-secondary)]">
          {t(rows === undefined ? 'usageCost.loading' : 'usageCost.unavailable')}
        </p>
      ) : (
        ['conversation', 'additional'].map((category) => {
          const group = rows.filter((row) => row.category === category);
          if (!group.length) return null;
          return (
            <section key={category} className="space-y-2">
              <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 font-medium">
                <span>{t(`usageCost.${category}`)}</span>
                <span className="tabular-nums">
                  {usageCostTotals(group).map(formatTurnCostMoney).join(' · ')}
                </span>
              </div>
              {group.map((row, index) => (
                <div key={index} className="space-y-0.5">
                  <div className="flex items-start justify-between gap-4">
                    <span className="min-w-0 break-words">
                      {row.model || t('usageCost.unknownModel')}
                    </span>
                    <span className="shrink-0 tabular-nums">{formatTurnCostMoney(row.money)}</span>
                  </div>
                  <div className="break-words text-[var(--text-secondary)]">
                    {(row.providerName || (row.providerId !== 'xd' ? row.providerId : '')) &&
                    row.providerName !== t(`usageCost.source.${row.billingSource ?? 'unknown'}`)
                      ? `${row.providerName || row.providerId} · `
                      : ''}
                    {t(`usageCost.source.${row.billingSource ?? 'unknown'}`)}
                    {' · '}
                    {t(
                      row.money.kind === 'value-estimate'
                        ? 'usageCost.estimate'
                        : 'usageCost.charged',
                    )}
                  </div>
                </div>
              ))}
            </section>
          );
        })
      )}
      {rows?.length === 0 ? <p>{t('usageCost.unavailable')}</p> : null}
      <p className="text-[var(--text-secondary)]">{t('usageCost.explanation')}</p>
    </div>
  );
}
