import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { ProviderView } from '@cindy/model-providers';
import type { MobileCodexRateLimitsResult } from '@cindy/maker-shared/device-link-contract';
import { matchCodexBucketForModel } from '@cindy/maker-shared/codex-usage-buckets';
import { summarizeCodexRateLimitReset } from '@cindy/maker-shared/session-controls';
import { useAccountUsage, type RateLimitSnapshot } from '@/hooks/useAccountUsage';
import { useCodexRateLimits } from '@/hooks/useCodexRateLimits';
import { useClaudeSubscriptionUsage } from '@/hooks/useClaudeSubscriptionUsage';
import {
  useXaiSubscriptionUsage,
  requestXaiSubscriptionRefresh,
} from '@/hooks/useXaiSubscriptionUsage';
import { isXaiWeeklyUsageCurrent } from '../../../shared/xaiSubscriptionUsage';
import { providerWeeklyQuotaSource } from '../new-chat/useProviderWeeklyQuota';
import {
  buildClaudeUsageCard,
  buildCodexUsageCard,
  buildXaiUsageCard,
  type UsageCardAccount,
} from '../status/usageCardModel';

/** Same account/card semantics as the task card; never use a model-specific bucket
 * as the generic account quota or borrow data from another provider connection. */
export function buildSettingsCodexUsageCard(
  snapshot: MobileCodexRateLimitsResult | null,
  account: RateLimitSnapshot | null,
  t: TFunction,
  nowMs: number,
  locale?: string,
): UsageCardAccount {
  const direct = snapshot
    ? matchCodexBucketForModel(
        snapshot.rateLimitsByLimitId ?? {
          [snapshot.rateLimits.limitId ?? 'codex']: snapshot.rateLimits,
        },
        undefined,
        nowMs,
      )
    : null;
  // A populated bucket table is authoritative, including an empty generic slot.
  const quota =
    snapshot?.rateLimitsByLimitId != null
      ? direct
      : direct?.primary || direct?.secondary
        ? direct
        : account;
  const planType = [snapshot?.account.planType, direct?.planType, account?.planType].find(
    (value) =>
      typeof value === 'string' && value.trim() && value.trim().toLowerCase() !== 'unknown',
  );
  return buildCodexUsageCard(
    quota || planType ? { ...quota, planType, credits: account?.credits } : null,
    summarizeCodexRateLimitReset(snapshot, nowMs),
    t,
    nowMs,
    locale,
  );
}

export function useProviderSubscriptionCard(provider?: ProviderView): UsageCardAccount | null {
  const { t, i18n } = useTranslation();
  // Suspension only disables routing; settings must still show the saved account.
  const source = provider ? providerWeeklyQuotaSource({ ...provider, suspended: false }) : null;
  const providerId = provider?.id ?? 'openai';
  const { snapshot } = useCodexRateLimits(source === 'codex', providerId);
  const account = useAccountUsage(
    undefined,
    source === 'codex' ? 'codex' : undefined,
    'app-server',
    undefined,
    providerId,
  );
  const claude = useClaudeSubscriptionUsage(source === 'claude', providerId);
  const xai = useXaiSubscriptionUsage(source === 'xai', providerId);
  const [nowMs, setNowMs] = useState(Date.now);
  useEffect(() => {
    if (!source) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [source]);
  useEffect(() => {
    if (source === 'xai' && !isXaiWeeklyUsageCurrent(xai, nowMs)) requestXaiSubscriptionRefresh(providerId);
  }, [source, xai, nowMs, providerId]);
  if (source === 'codex' && (snapshot || account))
    return buildSettingsCodexUsageCard(
      snapshot,
      account,
      t,
      nowMs,
      i18n?.resolvedLanguage ?? i18n?.language,
    );
  if (source === 'claude' && claude) return buildClaudeUsageCard(claude, t);
  if (source === 'xai' && xai) return buildXaiUsageCard(xai, null, t, nowMs);
  return null;
}
