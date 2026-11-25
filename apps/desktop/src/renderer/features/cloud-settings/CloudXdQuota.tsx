import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { resolveXdAssetModuleState } from '@/components/settings/providerAssetModule';
import type { ClaudeAccountUsageSnapshot } from '@/hooks/useClaudeAccountUsage';
import { formatBillingAmount } from '@/features/billing/money';
import { CLAUDE_QUOTA_STATE_READ, isClaudeQuotaClear } from '../../../shared/claudeQuotaState';

function isSnapshot(value: unknown): value is ClaudeAccountUsageSnapshot {
  const usage = value as Partial<ClaudeAccountUsageSnapshot> | null;
  return (
    !!usage &&
    typeof usage.spend === 'number' &&
    typeof usage.maxBudget === 'number' &&
    usage.maxBudget > 0 &&
    (usage.currency === 'CNY' || usage.currency === 'USD') &&
    (typeof usage.todaySpend === 'number' || usage.todaySpend === null)
  );
}

/**
 * The Cindy AI period quota of the instance: the local header's module, read from the
 * instance's own Gateway account over the same-account `maker:usage:account` call.
 */
export function CloudXdQuota({ deviceId, online }: { deviceId: string; online: boolean }) {
  const { t, i18n } = useTranslation();
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{
    loading: boolean;
    usage: ClaudeAccountUsageSnapshot | null;
    unlimited: boolean;
  }>({ loading: true, usage: null, unlimited: false });
  useEffect(() => {
    if (!online) return;
    let cancelled = false;
    setState((previous) => ({ ...previous, loading: true }));
    void window.electronAPI.deviceLink
      .invoke(deviceId, 'maker:usage:account', ['claude-code', CLAUDE_QUOTA_STATE_READ])
      .then((result) => {
        if (cancelled) return;
        if (isClaudeQuotaClear(result))
          setState({ loading: false, usage: null, unlimited: result.quotaState === 'unlimited' });
        else
          setState({ loading: false, usage: isSnapshot(result) ? result : null, unlimited: false });
      })
      .catch(() => {
        if (!cancelled) setState((previous) => ({ ...previous, loading: false }));
      });
    return () => {
      cancelled = true;
    };
  }, [deviceId, online, revision]);
  const asset = resolveXdAssetModuleState({
    billingAccessible: false,
    syncState: 'ok',
    available: null,
    quotaAccessible: true,
    quota: state.usage,
    quotaUnlimited: state.unlimited,
    loading: state.loading,
  });
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const refresh = () => setRevision((value) => value + 1);
  if (
    asset.kind !== 'quota' &&
    asset.kind !== 'loading' &&
    asset.kind !== 'unavailable' &&
    asset.kind !== 'unlimited'
  )
    return null;
  return (
    <div
      data-testid="cindy-ai-asset-module"
      className="flex min-h-[112px] flex-wrap items-center justify-between gap-x-6 gap-y-4 border-t px-5 py-4"
      style={{ borderColor: 'var(--settings-theme-card-border)' }}
    >
      {asset.kind === 'quota' ? (
        <>
          <div>
            <p className="text-12 text-[var(--text-secondary)]">
              {t('settings.providers.xd.asset.quotaTitle')}
            </p>
            <p className="mt-1.5 text-20 font-medium tabular-nums text-[var(--text-primary)]">
              {formatBillingAmount(
                String(Math.max(0, asset.quota.maxBudget - asset.quota.spend)),
                asset.quota.currency,
                locale,
              )}
            </p>
            <p className="mt-1 text-11 text-[var(--text-tertiary)]">
              {t('settings.providers.xd.asset.quotaUsed', {
                used: formatBillingAmount(String(asset.quota.spend), asset.quota.currency, locale),
                total: formatBillingAmount(
                  String(asset.quota.maxBudget),
                  asset.quota.currency,
                  locale,
                ),
              })}
            </p>
          </div>
          <Button variant="secondary" size="md" disabled={!online} onClick={refresh}>
            {t('settings.providers.xd.asset.refresh')}
          </Button>
        </>
      ) : (
        <>
          <div>
            <p className="text-12 text-[var(--text-secondary)]">
              {t('settings.providers.xd.asset.quotaTitle')}
            </p>
            <p className="mt-1 text-13 text-[var(--text-tertiary)]" role="status">
              {t(
                asset.kind === 'loading'
                  ? 'settings.providers.xd.asset.loading'
                  : asset.kind === 'unlimited'
                    ? 'settings.providers.xd.asset.noPersonalLimit'
                    : 'settings.providers.xd.asset.unavailable',
              )}
            </p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            tone="quiet"
            compact
            loading={asset.kind === 'loading'}
            type="button"
            disabled={asset.kind === 'loading' || !online}
            onClick={refresh}
          >
            {t('settings.providers.xd.asset.refresh')}
          </Button>
        </>
      )}
    </div>
  );
}
