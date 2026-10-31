import { useEffect, useMemo } from 'react';
import type { MobileCodexRateLimitsResult } from '@cindy/maker-shared/device-link-contract';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { isProviderShareAgentDeviceId } from '../../shared/providerShare';
import { useDeviceLinkReconnectEpoch } from '../features/device-link/useDeviceLinkReconnectEpoch';
import { CLAUDE_QUOTA_STATE_READ, isClaudeQuotaClear } from '../../shared/claudeQuotaState';
/**
 * useRemoteDeviceUsage — device-link 远程会话各计费形态的被控端用量镜像集。
 *
 * 与 useRemoteClaudeSubscriptionUsage(Claude 订阅,先落地)并列,覆盖其余形态,
 * 装配复用 remoteDeviceUsageMirror(invoke warm-start + push 整帧替换 + owner
 * 栅栏 + CHANNEL_NOT_ALLOWED TTL):
 *   - Codex 账号窗口:invoke 'maker:usage:account'(agentKind='codex')返回权威组合
 *     payload(顶层 app-server 兼容位 + appServerBuckets 桶表 + webSnapshot WHAM 槽),
 *     push 'usage:codex-account-changed' 同形;槽 / 桶选择复用 useAccountUsage 导出的
 *     纯函数,在消费点按会话形态与模型执行(与本机同口径,绝不显示别的桶)。
 *   - Claude 网关配额(LiteLLM daily/monthly):invoke 同 channel(agentKind=
 *     'claude-code'),push 'usage:claude-account-changed'。
 *   - xAI 订阅周用量:invoke 'maker:usage:xai-subscription'(被控端 dispatch 拦截
 *     执行),push 'usage:xai-subscription-changed'。
 *   - xAI 限流头:push-only('usage:xai-rate-limit-changed';独立账号走
 *     'usage:xai-provider-rate-limit-changed' { providerId, snapshot })—— 被控端无拉取端点,
 *     本机 renderer 同样只有推送缓存,远程与本机同语义降级。
 */

import {
  matchCodexBucketForModel,
  splitCodexAccountUsagePayload,
  type CodexQuotaSource,
  type RateLimitSnapshot,
} from '@/hooks/useAccountUsage';
import type { ClaudeAccountUsageSnapshot } from '@/hooks/useClaudeAccountUsage';

import { createRemoteDeviceUsageMirror } from './remoteDeviceUsageMirror';

import type { XaiRateLimitSnapshot } from '../../shared/xaiRateLimit';
import type { XaiSubscriptionUsageSnapshot } from '../../shared/xaiSubscriptionUsage';

/** 被控端 readCodexAccountUsageSnapshot 的组合 payload(与本机 push 同形)。 */
export type RemoteCodexAccountUsagePayload = RateLimitSnapshot & {
  webSnapshot?: RateLimitSnapshot | null;
  appServerBuckets?: Record<string, RateLimitSnapshot> | null;
};

const codexAccountMirror = createRemoteDeviceUsageMirror<RemoteCodexAccountUsagePayload>({
  invokeChannel: 'maker:usage:account',
  invokeArgs: ['codex'],
  pushChannel: 'usage:codex-account-changed',
  defaultProviderId: 'openai',
  providerPushChannel: 'usage:codex-provider-account-changed',
});
const codexNativeRateLimitsMirror = createRemoteDeviceUsageMirror<MobileCodexRateLimitsResult>({
  refreshOnReconnect: true,
  invokeChannel: 'maker:usage:codex-rate-limits',
  pushChannel: 'usage:codex-account-changed',
  defaultProviderId: 'openai',
  providerPushChannel: 'usage:codex-provider-account-changed',
  // A missed identity clear while collapsed/disconnected must not let an old
  // native account override a fresh mirror indefinitely after a failed reread.
  clearOnReadFailure: true,
  decodeRead: (value) => {
    if (value === null) return null;
    if (
      !value ||
      typeof value !== 'object' ||
      !('account' in value) ||
      !('rateLimits' in value) ||
      !value.account ||
      typeof value.account !== 'object' ||
      !value.rateLimits ||
      typeof value.rateLimits !== 'object'
    )
      return undefined;
    return value as MobileCodexRateLimitsResult;
  },
  // Native reads also emit usage pushes. Only identity clears apply to this richer
  // RPC result; refetching on its own non-null push would create a request loop.
  decodePush: (value) => (value === null ? null : undefined),
});

/** Account cards and model lists read app-server directly, just like Mobile. */
const codexRateLimitsMirror = createRemoteDeviceUsageMirror<RemoteCodexAccountUsagePayload>({
  invokeChannel: 'maker:usage:codex-rate-limits',
  pushChannel: null,
  defaultProviderId: 'openai',
  refreshIntervalMs: 60_000,
  async read(deviceId, providerId = 'openai') {
    const owner = getDataOwnerGeneration();
    const matchesProvider = (value: { providerId?: string }) =>
      value.providerId === providerId || (value.providerId === undefined && providerId === 'openai');
    try {
      const result = await window.electronAPI.deviceLink.invoke(
        deviceId, 'maker:usage:codex-rate-limits', [providerId],
      ) as MobileCodexRateLimitsResult | null;
      if (result && matchesProvider(result) && result.rateLimits && result.account) {
        const updatedAt = Date.now();
        const buckets = result.rateLimitsByLimitId ?? {
          [result.rateLimits.limitId ?? 'codex']: result.rateLimits,
        };
        return {
          // An empty authoritative table must not revive the compatibility slot.
          ...(Object.keys(buckets).length ? result.rateLimits : {}),
          providerId,
          webSnapshot: null,
          planType: result.account.planType ?? result.rateLimits.planType,
          updatedAt,
          appServerBuckets: Object.fromEntries(Object.entries(buckets).map(([id, bucket]) => [id, {
            ...bucket, planType: result.account.planType ?? bucket.planType, updatedAt,
          }])),
        };
      }
    } catch {
      // Old hosts or temporary read failures retain the previous snapshot below.
    }
    if (!isDataOwnerGenerationCurrent(owner)) return undefined;
    const fallback = await window.electronAPI.deviceLink.invoke(
      deviceId, 'maker:usage:account', providerId === 'openai' ? ['codex'] : ['codex', providerId],
    ) as (RemoteCodexAccountUsagePayload & { providerId?: string }) | null;
    // A successful empty account read is authoritative (for example after logout).
    if (fallback === null) return null;
    if (!fallback || !matchesProvider(fallback)) return undefined;
    return fallback;
  },
});

const claudeAccountMirror = createRemoteDeviceUsageMirror<ClaudeAccountUsageSnapshot>({
  invokeChannel: 'maker:usage:account',
  invokeArgs: ['claude-code', CLAUDE_QUOTA_STATE_READ],
  decodeRead: (value) => {
    if (isClaudeQuotaClear(value)) return null;
    if (!value || typeof value !== 'object' || !('maxBudget' in value)) return undefined;
    return value as ClaudeAccountUsageSnapshot;
  },
  pushChannel: 'usage:claude-account-changed',
});
const xaiSubscriptionMirror = createRemoteDeviceUsageMirror<XaiSubscriptionUsageSnapshot>({
  invokeChannel: 'maker:usage:xai-subscription',
  pushChannel: 'usage:xai-subscription-changed',
  defaultProviderId: 'xai',
  providerPushChannel: 'usage:subscription-provider-account-changed',
});
const xaiRateLimitMirror = createRemoteDeviceUsageMirror<XaiRateLimitSnapshot>({
  invokeChannel: null,
  pushChannel: 'usage:xai-rate-limit-changed',
  defaultProviderId: 'xai',
  providerPushChannel: 'usage:xai-provider-rate-limit-changed',
});

/** 被控端 Codex 账号组合 payload 镜像(远程 codex / chatgpt-bridge 会话 chip 用)。 */
export function useRemoteCodexAccountUsage(
  deviceId: string | null,
  providerId?: string,
  { live = false, web = false, groupLive = false, refreshEpoch }: { live?: boolean; web?: boolean; groupLive?: boolean; refreshEpoch?: number } = {},
): RemoteCodexAccountUsagePayload | null {
  // The WHAM slot still comes from the existing account reader. Sharing uses a
  // separate permissioned quota reader; session chips retain their push mirror.
  const target = live && isProviderShareAgentDeviceId(deviceId) ? null : deviceId;
  const snapshot = codexAccountMirror.useMirror(live && !web ? null : target, providerId, { live: groupLive, refreshEpoch });
  const realtime = codexRateLimitsMirror.useMirror(live ? target : null, providerId);
  return useMemo(() => {
    if (!live) return snapshot;
    if (!web) return realtime;
    if (!realtime && !snapshot?.webSnapshot) return null;
    return { ...realtime, webSnapshot: snapshot?.webSnapshot };
  }, [live, web, realtime, snapshot]);
}

export function requestRemoteCodexAccountRefresh(
  deviceId: string,
  providerId?: string,
  queueIfPending = false,
  scheduling?: { background?: boolean },
): void {
  codexAccountMirror.request(deviceId, providerId, queueIfPending, scheduling);
}

/** Query the execution computer's native account RPC even when another card has a cached result. */
export function useRemoteCodexRateLimits(
  deviceId: string | null,
  providerId?: string,
): MobileCodexRateLimitsResult | null {
  const snapshot = codexNativeRateLimitsMirror.useMirror(deviceId, providerId);
  useEffect(() => {
    if (deviceId) codexNativeRateLimitsMirror.request(deviceId, providerId);
  }, [deviceId, providerId]);
  return snapshot;
}

export const requestRemoteCodexRateLimitsRefresh = codexNativeRateLimitsMirror.request;

/** 被控端 Claude 网关配额(LiteLLM daily/monthly)镜像(远程网关形态会话 chip 用)。 */
export function useRemoteClaudeAccountUsage(
  deviceId: string | null,
): ClaudeAccountUsageSnapshot | null {
  const epoch = useDeviceLinkReconnectEpoch(deviceId ?? undefined);
  const usage = claudeAccountMirror.useMirror(deviceId);
  useEffect(() => {
    if (deviceId && epoch > 0) claudeAccountMirror.request(deviceId, undefined, true);
  }, [deviceId, epoch]);
  return usage;
}

/** 被控端 xAI 订阅周用量镜像(远程 xai 形态会话 chip 用)。 */
export function useRemoteXaiSubscriptionUsage(
  deviceId: string | null,
  providerId?: string,
  options: { live?: boolean; refreshEpoch?: number } = {},
): XaiSubscriptionUsageSnapshot | null {
  return xaiSubscriptionMirror.useMirror(deviceId, providerId, options);
}

export function requestRemoteXaiSubscriptionRefresh(
  deviceId: string,
  providerId?: string,
  queueIfPending = false,
  scheduling?: { background?: boolean },
): void {
  xaiSubscriptionMirror.request(deviceId, providerId, queueIfPending, scheduling);
}

/** 被控端 xAI 限流头镜像(push-only,tooltip 尽力显示;独立账号订阅各自的 provider 镜像)。 */
export function useRemoteXaiRateLimit(
  deviceId: string | null,
  providerId?: string,
): XaiRateLimitSnapshot | null {
  return xaiRateLimitMirror.useMirror(deviceId, providerId);
}

/**
 * 远程组合 payload → 会话形态对应的单快照(与本机 useAccountUsage 的选槽同口径):
 * chatgpt/ bridge 消耗 WHAM(openai-web)槽;Codex CLI 会话消耗 app-server 槽并按
 * 当前模型匹配限额桶(matchCodexBucketForModel,匹配不到宁可不显示,绝不显示别的
 * 桶);桶表为空(旧被控端 / 无 app 数据)回退顶层兼容位。split 复用本机同一实现
 * (含桶表 sanitize —— 远程 payload 一律按数据对待)。
 */
export function selectRemoteCodexAccountUsage(
  payload: RemoteCodexAccountUsagePayload | null,
  quotaSource: CodexQuotaSource,
  modelId?: string | null,
): RateLimitSnapshot | null {
  if (!payload) return null;
  const parts = splitCodexAccountUsagePayload(payload);
  if (quotaSource === 'openai-web') return parts.web ?? null;
  const buckets = parts.appServerBuckets;
  if (buckets && Object.keys(buckets).length > 0) {
    return matchCodexBucketForModel(buckets, modelId);
  }
  return parts.appServer ?? null;
}

/** 供单测重置全部镜像缓存。 */
export function resetRemoteDeviceUsageMirrorsForTest(): void {
  codexAccountMirror.resetForTest();
  codexRateLimitsMirror.resetForTest();
  codexNativeRateLimitsMirror.resetForTest();
  claudeAccountMirror.resetForTest();
  xaiSubscriptionMirror.resetForTest();
  xaiRateLimitMirror.resetForTest();
}
