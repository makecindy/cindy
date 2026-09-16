import { useEffect, useState } from 'react';
import type { ProviderView } from '@cindy/model-providers';
import type { MobileCodexRateLimitsResult } from '@cindy/maker-shared/device-link-contract';
import { matchCodexBucketForModel } from '@cindy/maker-shared/codex-usage-buckets';
import { useCodexRateLimits } from '@/hooks/useCodexRateLimits';
import { useClaudeSubscriptionUsage } from '@/hooks/useClaudeSubscriptionUsage';
import { useXaiSubscriptionUsage } from '@/hooks/useXaiSubscriptionUsage';
import { isXaiWeeklyUsageCurrent } from '../../../shared/xaiSubscriptionUsage';

export interface ProviderWeeklyQuota {
  usedPercent: number;
  resetsAt?: number | null;
}

export function weeklyQuota(
  used: unknown,
  resetsAt: number | null | undefined,
  nowMs: number,
): ProviderWeeklyQuota | null {
  if (typeof used !== 'number' || !Number.isFinite(used)) return null;
  // A completed window is unknown until refreshed, never an inferred 100%.
  if (typeof resetsAt === 'number' && resetsAt > 0 && resetsAt * 1000 <= nowMs) return null;
  return { usedPercent: Math.max(0, Math.min(100, used)), resetsAt };
}

export function codexWeeklyQuota(
  snapshot: MobileCodexRateLimitsResult | null,
  nowMs: number,
): ProviderWeeklyQuota | null {
  if (!snapshot) return null;
  // Only the account's generic bucket belongs on the provider icon. Model-specific
  // promotions cannot stand in for the account's quota, even when they arrived last.
  const bucket = snapshot.rateLimitsByLimitId
    ? matchCodexBucketForModel(snapshot.rateLimitsByLimitId, undefined, nowMs)
    : matchCodexBucketForModel(
        { [snapshot.rateLimits.limitId ?? 'codex']: snapshot.rateLimits },
        undefined,
        nowMs,
      );
  for (const window of [bucket?.primary, bucket?.secondary]) {
    if (window?.windowMinutes !== 10_080) continue;
    const quota = weeklyQuota(window.usedPercent, window.resetsAt, nowMs);
    if (quota) return quota;
  }
  return null;
}

export function providerWeeklyQuotaSource(
  provider: ProviderView,
): 'codex' | 'claude' | 'xai' | null {
  if (
    !provider.connected ||
    provider.suspended ||
    provider.openAiAccount?.reconnectRequired ||
    provider.auth.method !== 'oauth' ||
    (provider.access && provider.access.kind !== 'subscription')
  )
    return null;
  if (provider.id === 'openai' || provider.auth.native === 'codex') return 'codex';
  if (provider.auth.native === 'claude') return 'claude';
  if (provider.auth.native === 'xai') return 'xai';
  // These APIs currently describe only the built-in native account, not any
  // arbitrary same-brand API/OAuth connection a user may add.
  if (provider.source !== 'builtin') return null;
  if (provider.id === 'anthropic') return 'claude';
  if (provider.id === 'xai') return 'xai';
  return null;
}

export function useProviderWeeklyQuota(provider: ProviderView): ProviderWeeklyQuota | null {
  const source = providerWeeklyQuotaSource(provider);
  const { snapshot: codex } = useCodexRateLimits(source === 'codex', provider.id);
  const claude = useClaudeSubscriptionUsage(source === 'claude', provider.id);
  const xai = useXaiSubscriptionUsage(source === 'xai', provider.id);
  const [nowMs, setNowMs] = useState(Date.now);
  // Local display clock only; fetching and cached-first updates remain in the
  // existing hooks. Hide expired windows even when the panel is left open.
  useEffect(() => {
    if (!source) return;
    const timer = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [source]);
  if (source === 'codex') return codexWeeklyQuota(codex, nowMs);
  if (source === 'claude')
    return weeklyQuota(claude?.sevenDay?.utilization, claude?.sevenDay?.resetsAt, nowMs);
  if (source === 'xai' && isXaiWeeklyUsageCurrent(xai, nowMs))
    return weeklyQuota(xai?.creditUsagePercent, xai?.resetsAt, nowMs);
  return null;
}
