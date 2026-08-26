import { AlertTriangle, ExternalLink, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { AgentKind } from '@cindy/model-providers';
import type {
  ProviderAccountUsageError,
  ProviderAccountUsageResult,
  ProviderAccountUsageSnapshot,
} from '../../../shared/providerAccountUsage';

import { cn } from '@/lib/utils';
import { QuotaBar } from '@/components/status/QuotaBar';
import { Tip } from '@/components/ui/tooltip';

export interface ProviderAccountUsageRuntimeView {
  agent: AgentKind;
  result: ProviderAccountUsageResult | null;
  refreshing: boolean;
}

const AGENT_LABEL: Record<AgentKind, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  pi: 'Pi',
};

function dashboardUrl(snapshot: ProviderAccountUsageSnapshot): string {
  return snapshot.kind === 'deepseek-balance'
    ? 'https://platform.deepseek.com/usage'
    : 'https://openrouter.ai/activity';
}

function formatCurrency(value: string | number, currency: string, locale: string): string {
  try {
    if (typeof value === 'string') {
      const fractionLength = value.split('.')[1]?.replace(/0+$/, '').length ?? 0;
      const defaultDigits = new Intl.NumberFormat(locale, {
        style: 'currency',
        currency,
      }).resolvedOptions().minimumFractionDigits ?? 0;
      if (fractionLength > 20) return `${value} ${currency}`;
      const formatter = new Intl.NumberFormat(locale, {
        style: 'currency',
        currency,
        maximumFractionDigits: Math.max(defaultDigits, fractionLength),
      });
      // ECMA-402 accepts decimal strings without first rounding them through Number.
      return (formatter.format as unknown as (input: string) => string)(value);
    }
    if (!Number.isFinite(value)) return `${String(value)} ${currency}`;
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      maximumFractionDigits: 4,
    }).format(value);
  } catch {
    return `${String(value)} ${currency}`;
  }
}

function errorKey(error: ProviderAccountUsageError): string {
  return `providerAccountUsage.error.${error}`;
}

function UsageMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-11 text-[var(--text-tertiary)]">{label}</p>
      <p className="mt-0.5 truncate text-13 font-medium tabular-nums text-[var(--text-primary)]">
        {value}
      </p>
    </div>
  );
}

function SnapshotBody({ snapshot, locale }: { snapshot: ProviderAccountUsageSnapshot; locale: string }) {
  const { t } = useTranslation();
  if (snapshot.kind === 'deepseek-balance') {
    if (!snapshot.isAvailable || snapshot.balances.length === 0) {
      return (
        <p className="mt-3 flex items-start gap-2 text-13 text-[var(--text-secondary)]">
          <AlertTriangle
            size={14}
            className="mt-0.5 shrink-0 text-[var(--warning-fg)]"
            aria-hidden
          />
          <span>
            {t(
              snapshot.isAvailable
                ? 'providerAccountUsage.deepSeek.empty'
                : 'providerAccountUsage.deepSeek.unavailable',
            )}
          </span>
        </p>
      );
    }
    return (
      <div className="mt-3 space-y-3">
        {snapshot.balances.map((balance) => (
          <div key={balance.currency} className="rounded-lg bg-[var(--surface-chip)] px-3 py-2.5">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-12 font-medium text-[var(--text-secondary)]">
                {balance.currency}
              </span>
              <span className="text-16 font-medium tabular-nums text-[var(--text-primary)]">
                {formatCurrency(balance.totalBalance, balance.currency, locale)}
              </span>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-3">
              <UsageMetric
                label={t('providerAccountUsage.deepSeek.granted')}
                value={formatCurrency(balance.grantedBalance, balance.currency, locale)}
              />
              <UsageMetric
                label={t('providerAccountUsage.deepSeek.toppedUp')}
                value={formatCurrency(balance.toppedUpBalance, balance.currency, locale)}
              />
            </div>
          </div>
        ))}
      </div>
    );
  }

  const hasQuota = snapshot.limit !== null && snapshot.limitRemaining !== null;
  const usedPercent =
    snapshot.limit !== null && snapshot.limit > 0 && snapshot.limitRemaining !== null
      ? Math.max(
        0,
        Math.min(100, ((snapshot.limit - snapshot.limitRemaining) / snapshot.limit) * 100),
      )
      : null;
  const resetLabel = snapshot.limitReset
    ? t(`providerAccountUsage.reset.${snapshot.limitReset}`, { defaultValue: snapshot.limitReset })
    : t('providerAccountUsage.openRouter.noReset');
  return (
    <div className="mt-3 space-y-3">
      <div className="rounded-lg bg-[var(--surface-chip)] px-3 py-2.5">
        {hasQuota ? (
          <>
            <div className="grid grid-cols-2 gap-3">
              <UsageMetric
                label={t('providerAccountUsage.openRouter.limit')}
                value={formatCurrency(snapshot.limit!, 'USD', locale)}
              />
              <UsageMetric
                label={t('providerAccountUsage.openRouter.remaining')}
                value={formatCurrency(snapshot.limitRemaining!, 'USD', locale)}
              />
            </div>
            {usedPercent !== null && (
              <div className="mt-2.5">
                <QuotaBar
                  usedPercent={usedPercent}
                  ariaLabel={t('providerAccountUsage.openRouter.usedPercent')}
                />
              </div>
            )}
          </>
        ) : (
          <p className="text-13 text-[var(--text-secondary)]">
            {t('providerAccountUsage.openRouter.noKeyQuota')}
          </p>
        )}
        <p className="mt-2 text-11 text-[var(--text-tertiary)]">
          {t('providerAccountUsage.openRouter.reset', { value: resetLabel })}
        </p>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
        <UsageMetric
          label={t('providerAccountUsage.usage.total')}
          value={formatCurrency(snapshot.usage, 'USD', locale)}
        />
        <UsageMetric
          label={t('providerAccountUsage.usage.daily')}
          value={formatCurrency(snapshot.usageDaily, 'USD', locale)}
        />
        <UsageMetric
          label={t('providerAccountUsage.usage.weekly')}
          value={formatCurrency(snapshot.usageWeekly, 'USD', locale)}
        />
        <UsageMetric
          label={t('providerAccountUsage.usage.monthly')}
          value={formatCurrency(snapshot.usageMonthly, 'USD', locale)}
        />
      </div>
    </div>
  );
}

function RuntimeUsage({
  runtime,
  onRefresh,
}: {
  runtime: ProviderAccountUsageRuntimeView;
  onRefresh(agent: AgentKind): void;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const { result } = runtime;
  return (
    <section className="py-4 first:pt-0 last:pb-0">
      <div className="flex items-center justify-between gap-3">
        <span className="text-12 font-medium text-[var(--settings-section-title)]">
          {AGENT_LABEL[runtime.agent]}
        </span>
        <Tip text={t('providerAccountUsage.refresh')} side="top">
          <button
            type="button"
            aria-label={t('providerAccountUsage.refresh')}
            disabled={runtime.refreshing}
            onClick={() => onRefresh(runtime.agent)}
            className="flex h-7 w-7 items-center justify-center rounded-full text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)] disabled:opacity-50"
          >
            <span
              className={cn(
                'inline-flex',
                runtime.refreshing && 'animate-spinner motion-reduce:animate-none',
              )}
            >
              <RefreshCw size={14} aria-hidden />
            </span>
          </button>
        </Tip>
      </div>

      {result === null ? (
        <p className="mt-2 text-13 text-[var(--text-secondary)]">
          {t('providerAccountUsage.updating')}
        </p>
      ) : result.status === 'unavailable' ? (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
          <p className="flex min-w-0 items-center gap-2 text-13 text-[var(--text-secondary)]">
            <AlertTriangle size={14} className="shrink-0 text-[var(--error-fg)]" aria-hidden />
            <span>{t(errorKey(result.error))}</span>
          </p>
          <button
            type="button"
            onClick={() => onRefresh(runtime.agent)}
            className="rounded-full border border-[var(--border-default)] px-3 py-1 text-12 text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]"
          >
            {t('providerAccountUsage.retry')}
          </button>
        </div>
      ) : result.status === 'ready' ? (
        <>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-11 text-[var(--text-tertiary)]">
            <span>
              {t('providerAccountUsage.updatedAt', {
                time: new Intl.DateTimeFormat(locale, {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                }).format(result.snapshot.fetchedAt),
              })}
            </span>
            {result.stale && (
              <span
                data-testid="provider-account-usage-stale"
                className="inline-flex items-center gap-1 text-[var(--warning-fg)]"
              >
                <AlertTriangle size={12} aria-hidden />
                {t('providerAccountUsage.stale')}
              </span>
            )}
            {result.error && (
              <span className="basis-full text-[var(--text-secondary)]">
                {t(errorKey(result.error))}
              </span>
            )}
          </div>
          <SnapshotBody snapshot={result.snapshot} locale={locale} />
          <button
            type="button"
            onClick={() => void window.electronAPI.openExternal(dashboardUrl(result.snapshot))}
            className="mt-3 inline-flex items-center gap-1.5 text-12 text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]"
          >
            {t('providerAccountUsage.openDashboard')}
            <ExternalLink size={12} aria-hidden />
          </button>
        </>
      ) : null}
    </section>
  );
}

export function ProviderAccountUsageModule({
  runtimes,
  onRefresh,
}: {
  runtimes: readonly ProviderAccountUsageRuntimeView[];
  onRefresh(agent: AgentKind): void;
}) {
  const visible = runtimes.filter((runtime) => runtime.result?.status !== 'unsupported');
  if (visible.length === 0) return null;
  return (
    <div className="divide-y divide-[var(--settings-theme-card-border)] border-t border-[var(--settings-theme-card-border)] px-5 py-4">
      {visible.map((runtime) => (
        <RuntimeUsage key={runtime.agent} runtime={runtime} onRefresh={onRefresh} />
      ))}
    </div>
  );
}
