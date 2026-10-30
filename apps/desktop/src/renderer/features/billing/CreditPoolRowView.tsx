import { useTranslation } from 'react-i18next';
import { QuotaBar } from '@/components/status/QuotaBar';

/** 计费页和分享详情共用的只读余额行；未知总额不显示百分比。 */
export function CreditPoolRowView({
  label,
  remaining,
  detail,
  percent,
  progressLayout = 'inline',
}: {
  label: string;
  remaining: string;
  detail: string;
  percent: number | null;
  progressLayout?: 'inline' | 'full-width';
}) {
  const { t } = useTranslation();
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(160px,30%)] items-baseline gap-x-6 gap-y-1 px-5 py-3.5">
      <p className="min-w-0 text-13 font-medium text-[var(--text-primary)]">{label}</p>
      <p className="flex items-baseline justify-end gap-1.5 whitespace-nowrap text-11 text-[var(--text-tertiary)]">
        {t('billing.usage.remaining')}
        <span className="text-13 font-medium tabular-nums text-[var(--text-primary)]">
          {remaining}
        </span>
      </p>
      <p
        className={`min-w-0 text-11 leading-4 text-[var(--text-tertiary)] ${progressLayout === 'full-width' ? 'col-span-2' : ''}`}
      >
        {detail}
      </p>
      {progressLayout === 'full-width' && percent !== null ? (
        <QuotaBar
          usedPercent={100 - percent}
          showRemaining
          ariaLabel={t('billing.usage.progressLabel', { label })}
          aria-valuetext={t('quotaCard.remainingPercent', { percent: Math.round(percent) })}
          className="col-span-2 self-center"
        />
      ) : (
        <div
          className={`h-1 w-full self-center overflow-hidden rounded-full bg-[var(--surface-chip)] ${progressLayout === 'full-width' ? 'col-span-2' : ''}`}
          role={percent === null ? undefined : 'progressbar'}
          aria-label={t('billing.usage.progressLabel', { label })}
          aria-valuemin={percent === null ? undefined : 0}
          aria-valuemax={percent === null ? undefined : 100}
          aria-valuenow={percent ?? undefined}
        >
          {percent !== null && (
            <div
              className="ml-auto h-full rounded-full bg-[var(--text-primary)]"
              style={{ width: `${percent}%` }}
            />
          )}
        </div>
      )}
    </div>
  );
}
