import { modelAccountQuotaStatus, modelQuotaWarning } from './modelAccountQuotaStatus';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { subscriptionQuotaOverview } from '@cindy/maker-shared/subscription-selection';
import { Tip } from '@/components/ui/tooltip';
import { useModelPickerAccount } from './ModelPickerAccount';
import { useModelSourceNow, useModelSourceUsage } from './ModelSourceDetails';
import type { SubscriptionAccountUsage } from '../../../shared/subscriptionAccounts';
import { pickerAccountWeeklyQuota, type ProviderUsageSnapshots } from './useProviderWeeklyQuota';
import { formatQuotaResetCountdown, formatQuotaResetDuration } from '../status/usageCardModel';

export function useModelPoolQuota(providerId: string, deviceId?: string | null, fallback?: ProviderUsageSnapshots) {
  const { t } = useTranslation();
  const account = useModelPickerAccount(providerId, deviceId);
  const now = useModelSourceNow() || Date.now();
  const directoryUsage = useModelSourceUsage(providerId);
  // Explicit rail devices must never borrow the open directory's snapshots.
  const legacy = !account ? (deviceId === undefined ? directoryUsage : fallback) : null;
  const legacyUsage: SubscriptionAccountUsage | null = legacy?.source === 'claude' && legacy.claude
    ? { claude: legacy.claude }
    : legacy?.source === 'codex' && legacy.codex?.buckets ? { codex: { credits: null,
        buckets: Object.fromEntries(Object.entries(legacy.codex.buckets).map(([key, bucket]) => {
          const window = (w: typeof bucket.primary) => w ? { usedPercent: w.usedPercent, windowMinutes: w.windowMinutes ?? null, resetsAt: w.resetsAt ?? null } : null;
          return [key, { limitId: bucket.limitId ?? null, limitName: bucket.limitName ?? null, updatedAt: null,
            primary: window(bucket.primary), secondary: window(bucket.secondary) }];
        })),
      } } : null;
  const accounts = account?.members ?? (account?.usage ? [account] : legacyUsage ? [{ usage: legacyUsage, identity: providerId }] : []);
  const quotaProviderId = legacy?.source === 'codex' ? 'openai' : legacy?.source === 'claude' ? 'anthropic' : providerId;
  const members = accounts.map((member, index) => {
    const quota = pickerAccountWeeklyQuota(quotaProviderId, member, now);
    const status = modelAccountQuotaStatus(quotaProviderId, member.usage, now);
    const recovery = status.pending ? t('quotaCard.resetPending')
      : status.reset ? t('subscriptionAccounts.quotaRecoverIn', { duration: formatQuotaResetDuration(status.reset, now, t) })
      : t('subscriptionAccounts.quotaExhausted');
    return {
      status,
      recovery: status.limited ? recovery : null,
      fiveHourLabel: status.fiveHourExhausted ? t('subscriptionAccounts.quotaFiveHourExhausted')
        : status.fiveHourRemaining !== null ? t('subscriptionAccounts.quotaFiveHourRemaining', { percent: status.fiveHourRemaining }) : null,
      identity: member.identity ?? t('providerGroup.member.accountFallback', { index: index + 1 }),
      remaining: quota ? Math.round(100 - quota.usedPercent) : null,
      resetsAt: quota?.resetsAt,
      reset: formatQuotaResetCountdown(quota?.resetsAt, now, t),
    };
  });
  if (!members?.length) return null;
  const overview = subscriptionQuotaOverview(members, now);
  const warning = modelQuotaWarning(members.map(m => m.status));
  const warningLabel = !warning ? null : warning.kind === 'low'
    ? t('subscriptionAccounts.quotaFiveHourRemaining', { percent: warning.remaining })
    : warning.pending ? t('quotaCard.resetPending')
    : warning.reset ? t('subscriptionAccounts.quotaRecoverIn', { duration: formatQuotaResetDuration(warning.reset, now, t) })
    : t('subscriptionAccounts.quotaExhausted');
  const nextReset = overview.nextResetIndex === null ? null : members[overview.nextResetIndex];
  return {
    ...overview,
    isPool: members.length > 1,
    hasAccountDetails: !!account,
    warning,
    warningLabel,
    resetParts: t('quotaCard.resetIn', { duration: '{time}' }).split('{time}'),
    resetDescription: nextReset
      ? [nextReset.reset, t('quotaCard.remainingPercent', { percent: overview.members[overview.nextResetIndex!].remaining })].join(' · ')
      : null,
    label:
      overview.average === null
        ? t('subscriptionAccounts.quotaUpdating')
        : t(members.length > 1 ? 'subscriptionAccounts.quotaAverage' : 'quotaCard.remainingPercent', { percent: overview.average }),
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
          {pool.hasAccountDetails && <div>
            {member.identity} ·{' '}
            {member.remaining === null
              ? '—'
              : t('quotaCard.remainingPercent', { percent: member.remaining })}
          </div>}
          {member.fiveHourLabel && <div className={member.status.limited ? 'text-[var(--quota-bar-crit)]' : member.status.low ? 'text-[var(--quota-bar-warn)]' : undefined}>{member.fiveHourLabel}</div>}
          {member.recovery && <div className="text-[var(--quota-bar-crit)]">{member.recovery}</div>}
          {member.reset && (
            <div className={member.resetLevel === 'crit' ? 'text-[var(--quota-bar-crit)]' : member.resetLevel === 'warn' ? 'text-[var(--quota-bar-warn)]' : undefined}>
              {member.resetSoon && <>{t('subscriptionAccounts.quotaResetSoon')} · </>}
              {member.reset}
            </div>
          )}
        </div>
      ))}
      {pool.isPool && <div className="text-11">{t('subscriptionAccounts.quotaAverageHint')}</div>}
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
        aria-label={[pool.label, pool.warningLabel, warning, pool.resetDescription].filter(Boolean).join(' · ')}
        onClick={() => setOpen((value) => !value)}
        className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-x-1.5 gap-y-1 rounded-full text-12 font-normal text-[var(--text-secondary)]"
      >
        <span className="tabular-nums">{pool.average === null ? pool.label : `${pool.average}%`}</span>
        {pool.warningLabel && <span data-quota-warning className={pool.warning?.kind === 'limited' ? 'text-[var(--quota-bar-crit)]' : 'text-[var(--quota-bar-warn)]'}>· {pool.warningLabel}</span>}
        {!pool.warningLabel && pool.reset && (
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
