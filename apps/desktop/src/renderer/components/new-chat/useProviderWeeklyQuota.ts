import { useProviderAccountUsage } from '@/hooks/useProviderAccountUsage';
import type { KimiCodingUsageSnapshot } from '../../../shared/kimiCodingUsage';
import { useEffect, useMemo, useState } from 'react';
import { useOptionalAuthDeviceId } from '@/contexts/AuthContext';
import type { ProviderView } from '@cindy/model-providers';
import { providerWeeklyQuotaSource } from '../../../shared/providerQuotaSource';
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

/**
 * 供应商组那一项的用量读谁(provider-groups.md §10「模型列表」)：组那一项代表组里的几台电脑，
 * 不拿组所在电脑自己的账号当整个组的用量。
 */
export type ProviderGroupUsage =
  /** 任务还没经这个组分到电脑(新任务、还没运行过、用的不是这个组)：不显示某一台的配额。 */
  | { kind: 'unassigned' }
  /**
   * 任务正经这个组在这台电脑上运行：读那台的账号，与输入框下方的用量同一份。
   * usage 为 null = 读不到那台的账号(别人分享的电脑、那台的目录还没读到)。
   */
  | {
      kind: 'running';
      /** 那台电脑的名字;null = 就是这台电脑。 */
      deviceName: string | null;
      usage: { provider: ProviderView; scope: ProviderUsageScope } | null;
    };

/**
 * 某个目录里的某个供应商是不是供应商组、用量读谁；不是组返回 null。
 * directoryDeviceId:目录所在的电脑,null = 任务所在电脑的目录。
 */
export type ProviderGroupUsageOf = (
  directoryDeviceId: string | null,
  providerId: string,
) => ProviderGroupUsage | null;

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

export { providerWeeklyQuotaSource };

export interface ProviderUsageSnapshots {
  source: 'codex' | 'claude' | 'xai' | 'kimi' | null;
  kimi?: KimiCodingUsageSnapshot | null;
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
  // A can be an explicit source in B's catalog. Reading A's own quota is local,
  // even though its catalog remains routed through B for visibility checks.
  // Normalize here so rail rows, model details and group members agree.
  const selfDeviceId = useOptionalAuthDeviceId();
  const local = scope.deviceId === null || scope.deviceId === selfDeviceId;
  const remoteDeviceId = local ? null : scope.deviceId;
  const { snapshot: localCodex } = useCodexRateLimits(local && source === 'codex', provider.id);
  const localWeb = useAccountUsage(
    undefined,
    local && web && source === 'codex' ? 'codex' : undefined,
    'openai-web',
    undefined,
    provider.id,
  );
  const kimi = useProviderAccountUsage(source === 'kimi' ? provider : undefined, undefined, remoteDeviceId);
  const localClaude = useClaudeSubscriptionUsage(local && source === 'claude', provider.id);
  const localXai = useXaiSubscriptionUsage(local && source === 'xai', provider.id);
  const remoteCodex = useRemoteCodexAccountUsage(
    source === 'codex' ? remoteDeviceId : null,
    provider.id,
    { live: true, web },
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
    kimi: kimi.result?.status === 'ready' && !kimi.result.stale && kimi.result.snapshot.kind === 'kimi-coding-quota' ? kimi.result.snapshot : null,
    codex,
    claude: source === 'claude' ? (local ? localClaude : remoteClaude) : null,
    xai: source === 'xai' ? (local ? localXai : remoteXai) : null,
  };
}

export function useProviderWeeklyQuota(
  provider: ProviderView,
  scope: ProviderUsageScope,
): ProviderWeeklyQuota | null {
  const { source, codex, claude, xai, kimi } = useProviderUsageSnapshots(provider, scope);
  const [nowMs, setNowMs] = useState(Date.now);
  // Local display clock only; fetching and cached-first updates remain in the
  // existing hooks. Hide expired windows even when the panel is left open.
  useEffect(() => {
    if (!source) return;
    const timer = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [source]);
  if (source === 'kimi') {
    const window = kimi?.windows.find(w => w.id === 'limit_7d');
    return weeklyQuota(window?.usedPercent, window?.resetsAt ? window.resetsAt / 1000 : null, nowMs);
  }
  if (source === 'codex') return codexWeeklyQuota(codex, nowMs);
  if (source === 'claude')
    return weeklyQuota(claude?.sevenDay?.utilization, claude?.sevenDay?.resetsAt, nowMs);
  if (source === 'xai' && isXaiWeeklyUsageCurrent(xai, nowMs))
    return weeklyQuota(xai?.creditUsagePercent, xai?.resetsAt, nowMs);
  return null;
}
