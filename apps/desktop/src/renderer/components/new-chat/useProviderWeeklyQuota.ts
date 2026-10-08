import { useEffect, useMemo, useState } from 'react';
import type { ProviderView } from '@cindy/model-providers';
import type { MobileCodexRateLimitsResult } from '@cindy/maker-shared/device-link-contract';
import { matchCodexBucketForModel } from '@cindy/maker-shared/codex-usage-buckets';
import { useCodexRateLimits } from '@/hooks/useCodexRateLimits';
import {
  splitCodexAccountUsagePayload,
  useAccountUsage,
  type RateLimitSnapshot,
} from '@/hooks/useAccountUsage';
import { useClaudeSubscriptionUsage } from '@/hooks/useClaudeSubscriptionUsage';
import { useXaiSubscriptionUsage } from '@/hooks/useXaiSubscriptionUsage';
import { useRemoteClaudeSubscriptionUsage } from '@/hooks/useRemoteClaudeSubscriptionUsage';
import {
  useRemoteCodexAccountUsage,
  useRemoteXaiSubscriptionUsage,
  type RemoteCodexAccountUsagePayload,
} from '@/hooks/useRemoteDeviceUsage';
import type { ClaudeSubscriptionUsageSnapshot } from '../../../shared/claudeSubscriptionUsage';
import {
  isXaiWeeklyUsageCurrent,
  type XaiSubscriptionUsageSnapshot,
} from '../../../shared/xaiSubscriptionUsage';

export interface ProviderWeeklyQuota {
  usedPercent: number;
  resetsAt?: number | null;
}

/**
 * Whose subscription accounts a model directory may show: this desktop (`deviceId: null`)
 * or the linked device that owns the directory. Remote reads share the session usage chip's
 * device mirrors, so the picker never borrows this desktop's quota and reuses their snapshots.
 */
export interface ProviderUsageScope {
  deviceId: string | null;
}

type CodexBucket = MobileCodexRateLimitsResult['rateLimits'];

/** Codex account usage in one shape, whether it came from local app-server reads or a device. */
export interface CodexQuotaView {
  /** app-server limit buckets keyed by limitId; model matching never crosses buckets. */
  buckets: Record<string, CodexBucket> | null;
  planType: string | null;
  /** WHAM (openai-web) slot consumed by chatgpt/ bridge models. */
  web: RateLimitSnapshot | null;
}

export function localCodexQuotaView(
  snapshot: MobileCodexRateLimitsResult | null,
  web: RateLimitSnapshot | null = null,
): CodexQuotaView | null {
  if (!snapshot) return web ? { buckets: null, planType: null, web } : null;
  return {
    buckets: snapshot.rateLimitsByLimitId ?? {
      [snapshot.rateLimits.limitId ?? 'codex']: snapshot.rateLimits,
    },
    planType: snapshot.account.planType,
    web,
  };
}

/** Same slot and bucket split as the remote usage chip (selectRemoteCodexAccountUsage). */
export function remoteCodexQuotaView(
  payload: RemoteCodexAccountUsagePayload | null,
): CodexQuotaView | null {
  if (!payload) return null;
  const parts = splitCodexAccountUsagePayload(payload);
  const appServer = parts.appServer ?? null;
  const buckets =
    parts.appServerBuckets && Object.keys(parts.appServerBuckets).length > 0
      ? parts.appServerBuckets
      : appServer
        ? { [appServer.limitId ?? 'codex']: appServer }
        : null;
  return { buckets, planType: appServer?.planType ?? null, web: parts.web ?? null };
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
  view: CodexQuotaView | null,
  nowMs: number,
): ProviderWeeklyQuota | null {
  // Only the account's generic bucket belongs on the provider icon. Model-specific
  // promotions cannot stand in for the account's quota, even when they arrived last.
  const bucket = matchCodexBucketForModel(view?.buckets, undefined, nowMs);
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

export interface ProviderUsageSnapshots {
  source: 'codex' | 'claude' | 'xai' | null;
  codex: CodexQuotaView | null;
  claude: ClaudeSubscriptionUsageSnapshot | null;
  xai: XaiSubscriptionUsageSnapshot | null;
}

/**
 * One connection's subscription usage from the scope's owner. Local and remote readers are
 * mutually exclusive; each existing hook keeps owning its cache, fetching and invalidation.
 */
export function useProviderUsageSnapshots(
  provider: ProviderView,
  scope: ProviderUsageScope,
  { web = false }: { web?: boolean } = {},
): ProviderUsageSnapshots {
  const source = providerWeeklyQuotaSource(provider);
  const local = scope.deviceId === null;
  const remoteDeviceId = scope.deviceId;
  const { snapshot: localCodex } = useCodexRateLimits(local && source === 'codex', provider.id);
  const localWeb = useAccountUsage(
    undefined,
    local && web && source === 'codex' ? 'codex' : undefined,
    'openai-web',
    undefined,
    provider.id,
  );
  const localClaude = useClaudeSubscriptionUsage(local && source === 'claude', provider.id);
  const localXai = useXaiSubscriptionUsage(local && source === 'xai', provider.id);
  const remoteCodex = useRemoteCodexAccountUsage(
    source === 'codex' ? remoteDeviceId : null,
    provider.id,
  );
  const remoteClaude = useRemoteClaudeSubscriptionUsage(
    source === 'claude' ? remoteDeviceId : null,
    provider.id,
  );
  const remoteXai = useRemoteXaiSubscriptionUsage(
    source === 'xai' ? remoteDeviceId : null,
    provider.id,
  );
  const codex = useMemo(
    () =>
      source !== 'codex'
        ? null
        : local
          ? localCodexQuotaView(localCodex, localWeb)
          : remoteCodexQuotaView(remoteCodex),
    [source, local, localCodex, localWeb, remoteCodex],
  );
  return {
    source,
    codex,
    claude: source === 'claude' ? (local ? localClaude : remoteClaude) : null,
    xai: source === 'xai' ? (local ? localXai : remoteXai) : null,
  };
}

export function useProviderWeeklyQuota(
  provider: ProviderView,
  scope: ProviderUsageScope,
): ProviderWeeklyQuota | null {
  const { source, codex, claude, xai } = useProviderUsageSnapshots(provider, scope);
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
