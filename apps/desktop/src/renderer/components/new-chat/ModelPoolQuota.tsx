import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { subscriptionQuotaOverview } from '@cindy/maker-shared/subscription-selection';
import { Tip } from '@/components/ui/tooltip';
import { useModelPickerAccount } from './ModelPickerAccount';
import { useModelSourceNow } from './ModelSourceDetails';
import { pickerAccountWeeklyQuota } from './useProviderWeeklyQuota';
import { formatQuotaResetCountdown } from '../status/usageCardModel';

export function useModelPoolQuota(providerId: string, deviceId?: string | null) {
  const { t } = useTranslation();
  const account = useModelPickerAccount(providerId, deviceId);
  const now = useModelSourceNow();
  const members = account?.members?.map((member, index) => {
    const quota = pickerAccountWeeklyQuota(providerId, member, now);
    return {
      identity: member.identity ?? t('providerGroup.member.accountFallback', { index: index + 1 }),
      remaining: quota ? Math.round(100 - quota.usedPercent) : null,
      resetsAt: quota?.resetsAt,
      reset: formatQuotaResetCountdown(quota?.resetsAt, now, t),
    };
  });
  if (!members?.length) return null;
  const overview = subscriptionQuotaOverview(members, now);
  const nextReset = overview.nextResetIndex === null ? null : members[overview.nextResetIndex];
  return {
    ...overview,
    resetParts: t('quotaCard.resetIn', { duration: '{time}' }).split('{time}'),
    resetDescription: nextReset
      ? [nextReset.reset, t('quotaCard.remainingPercent', { percent: overview.members[overview.nextResetIndex!].remaining })].join(' · ')
      : null,
    label:
      overview.average === null
        ? t('subscriptionAccounts.quotaUpdating')
        : t('subscriptionAccounts.quotaAverage', { percent: overview.average }),
    members: members.map((member, index) => ({ ...member, ...overview.members[index] })),
  };
}
export type ModelPoolQuota = NonNullable<ReturnType<typeof useModelPoolQuota>>;

export function ModelPoolQuotaDetails({ pool }: { pool: ModelPoolQuota }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2">
      <div>
        {pool.label} · {t('quotaCard.weeklyLabel')}
      </div>
      {pool.members.map((member, index) => (
        <div key={index}>
          <div>
            {member.identity} ·{' '}
            {member.remaining === null
              ? '—'
              : t('quotaCard.remainingPercent', { percent: member.remaining })}
          </div>
          {member.reset && (
            <div className={member.resetLevel === 'crit' ? 'text-[var(--quota-bar-crit)]' : member.resetLevel === 'warn' ? 'text-[var(--quota-bar-warn)]' : undefined}>
              {member.resetSoon && <>{t('subscriptionAccounts.quotaResetSoon')} · </>}
              {member.reset}
            </div>
          )}
        </div>
      ))}
      <div className="text-11">{t('subscriptionAccounts.quotaAverageHint')}</div>
      {!!pool.resetSoonCount && (
        <div className="text-11">{t('subscriptionAccounts.quotaResetHint')}</div>
      )}
    </div>
  );
}

/** One overview per provider section. Opening details never changes the model or account. */
export function ModelPoolQuotaSummary({ providerId }: { providerId: string }) {
  const { t } = useTranslation();
  const pool = useModelPoolQuota(providerId);
  const [open, setOpen] = useState(false);
  if (!pool) return null;
  const warning = pool.resetSoonCount ? t('subscriptionAccounts.quotaResetSoon') : null;
  return (
    <Tip
      text={<ModelPoolQuotaDetails pool={pool} />}
      side="bottom"
      controlledOpen={open || undefined}
      onOpenChange={setOpen}
      contentClassName="max-w-[320px] break-words"
    >
      <button
        type="button"
        data-pool-quota-summary
        aria-expanded={open}
        aria-label={[pool.label, warning, pool.resetDescription].filter(Boolean).join(' · ')}
        onClick={() => setOpen((value) => !value)}
        className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-x-1.5 gap-y-1 rounded-full text-12 font-normal text-[var(--text-secondary)]"
      >
        <span className="tabular-nums">{pool.average === null ? pool.label : `${pool.average}%`}</span>
        {pool.reset && (
          <span className="inline-flex min-w-0 flex-wrap items-center gap-1 text-left tabular-nums">
            <span aria-hidden>·</span>
            <span>{pool.reset.remaining}%</span>
            {pool.resetParts[0] && <span>{pool.resetParts[0]}</span>}
            <span data-pool-reset-time className={pool.reset.level === 'crit' ? 'text-[var(--quota-bar-crit)]' : pool.reset.level === 'warn' ? 'text-[var(--quota-bar-warn)]' : undefined}>{pool.reset.time}</span>
            {pool.resetParts[1] && <span>{pool.resetParts[1]}</span>}
          </span>
        )}
      </button>
    </Tip>
  );
}
