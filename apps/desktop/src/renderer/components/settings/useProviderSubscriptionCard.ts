import { useProviderAccountUsage } from '@/hooks/useProviderAccountUsage';
import { isKimiCodingProviderView } from '../../../shared/kimiCodingUsage';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { ProviderView } from '@cindy/model-providers';
import type { MobileCodexRateLimitsResult } from '@cindy/maker-shared/device-link-contract';
import { matchCodexBucketForModel } from '@cindy/maker-shared/codex-usage-buckets';
import {
  useAccountUsage,
  requestCodexAccountRefresh,
  type RateLimitSnapshot,
} from '@/hooks/useAccountUsage';
import { useCodexRateLimits, requestCodexRateLimitsRefresh } from '@/hooks/useCodexRateLimits';
import {
  useClaudeSubscriptionUsage,
  requestClaudeSubscriptionRefresh,
} from '@/hooks/useClaudeSubscriptionUsage';
import {
  useRemoteClaudeSubscriptionUsage,
  requestRemoteClaudeSubscriptionRefresh,
} from '@/hooks/useRemoteClaudeSubscriptionUsage';
import { useDocumentVisible } from '@/hooks/useWindowVisible';
import { HIDDEN_ANIMATION_ATTR } from '@/lib/hiddenAnimationGate';
import { useDeviceLinkReconnectEpoch } from '@/features/device-link/useDeviceLinkReconnectEpoch';
import {
  selectRemoteCodexAccountUsage,
  useRemoteCodexAccountUsage,
  useRemoteCodexRateLimits,
  useRemoteXaiSubscriptionUsage,
  requestRemoteCodexAccountRefresh,
  requestRemoteCodexRateLimitsRefresh,
  requestRemoteXaiSubscriptionRefresh,
} from '@/hooks/useRemoteDeviceUsage';
import {
  useXaiSubscriptionUsage,
  requestXaiSubscriptionRefresh,
} from '@/hooks/useXaiSubscriptionUsage';
import { isXaiWeeklyUsageCurrent } from '../../../shared/xaiSubscriptionUsage';
import { providerWeeklyQuotaSource } from '../new-chat/useProviderWeeklyQuota';
import {
  buildKimiUsageCard,
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
  // The host's native read displays only … + the final six account-ID chars;
  // the usage mirror keeps the full ID. Compare in that existing display form
  // only for masked native replies; older raw replies still require exact IDs.
  const nativeAccountId = snapshot?.account.accountId;
  const mirrorAccountId = account?.accountId;
  const sameAccount = nativeAccountId && mirrorAccountId && (
    nativeAccountId === mirrorAccountId ||
    (nativeAccountId.startsWith('…') && nativeAccountId === `…${mirrorAccountId.slice(-6)}`)
  );
  // Missing identity cannot bind old fallback data. Older hosts without a
  // native snapshot retain their legacy fallback; no wire identity is changed.
  const fallback = !snapshot || sameAccount
    ? account
    : null;
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
        : fallback;
  const planType = [snapshot?.account.planType, direct?.planType, fallback?.planType].find(
    (value) =>
      typeof value === 'string' && value.trim() && value.trim().toLowerCase() !== 'unknown',
  );
  const credits = fallback?.credits;
  return buildCodexUsageCard(
    quota || planType ? { ...quota, planType, credits } : null,
    null, // Reset count and expiry belong to the collapsible reset list.
    t,
    nowMs,
    locale,
  );
}

export function useProviderSubscriptionCard(
  provider?: ProviderView,
  options: { live?: boolean } = {},
): UsageCardAccount | null {
  const { t, i18n } = useTranslation();
  // Suspension only disables routing; settings must still show the saved account.
  const source = provider ? providerWeeklyQuotaSource({ ...provider, suspended: false }) : null;
  const providerId = provider?.id ?? 'openai';
  const { snapshot } = useCodexRateLimits(source === 'codex', providerId, options);
  const account = useAccountUsage(
    undefined,
    source === 'codex' ? 'codex' : undefined,
    'app-server',
    undefined,
    providerId,
    options,
  );
  const claude = useClaudeSubscriptionUsage(source === 'claude', providerId, options);
  const xai = useXaiSubscriptionUsage(source === 'xai', providerId, options);
  const [nowMs, setNowMs] = useState(Date.now);
  useEffect(() => {
    if (!source) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [source]);
  useEffect(() => {
    if (!options.live && source === 'xai' && !isXaiWeeklyUsageCurrent(xai, nowMs)) requestXaiSubscriptionRefresh(providerId);
  }, [source, xai, nowMs, providerId, options.live]);
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

/**
 * 同账号另一台电脑上一个供应商连接的订阅额度卡：OpenAI 主动查询那台的原生额度，镜像仅作兜底。
 * 按电脑 + 供应商分开缓存，不借用本机同名账号；与本机卡片共用通用额度桶的选择。
 */
function useRemoteProviderSubscriptionCard(
  provider: ProviderView | undefined,
  deviceId: string | null,
  groupLive: boolean,
  refreshEpoch: number,
): UsageCardAccount | null {
  const { t, i18n } = useTranslation();
  const source = provider && deviceId ? providerWeeklyQuotaSource({ ...provider, suspended: false }) : null;
  const providerId = provider?.id ?? 'openai';
  const liveObservation = groupLive ? { live: true, refreshEpoch } : { live: false };
  // Ordinary cards keep the upstream shared minute reader; expanded group cards
  // retain their native result + legacy mirror and explicit recovery/15s refresh.
  const codex = useRemoteCodexAccountUsage(source === 'codex' ? deviceId : null, providerId, { live: !groupLive, groupLive, refreshEpoch });
  const limits = useRemoteCodexRateLimits(groupLive && source === 'codex' ? deviceId : null, providerId);
  const claude = useRemoteClaudeSubscriptionUsage(source === 'claude' ? deviceId : null, providerId, liveObservation);
  const xai = useRemoteXaiSubscriptionUsage(source === 'xai' ? deviceId : null, providerId, liveObservation);
  const [nowMs, setNowMs] = useState(Date.now);
  useEffect(() => {
    if (!source) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [source]);
  if (source === 'codex') {
    const account = selectRemoteCodexAccountUsage(codex, 'app-server');
    if (!groupLive) return account
      ? buildCodexUsageCard(account, null, t, nowMs, i18n?.resolvedLanguage ?? i18n?.language)
      : null;
    return limits || account
      ? buildSettingsCodexUsageCard(limits, account, t, nowMs, i18n?.resolvedLanguage ?? i18n?.language)
      : null;
  }
  if (source === 'claude' && claude) return buildClaudeUsageCard(claude, t);
  if (source === 'xai' && xai) return buildXaiUsageCard(xai, null, t, nowMs);
  return null;
}

/** 一个供应商连接的订阅额度卡；展开的组成员用 live 开启前台刷新，收起卸载时停止。 */
export function useDeviceProviderSubscriptionCard(
  provider: ProviderView | undefined,
  deviceId: string | null,
  options: { live?: boolean; active?: boolean } = {},
): UsageCardAccount | null {
  const visible = useDocumentVisible(options.live === true);
  const [nativeVisible, setNativeVisible] = useState(
    () => typeof document === 'undefined' || !document.documentElement.hasAttribute(HIDDEN_ANIMATION_ATTR),
  );
  useEffect(() => {
    if (!options.live) return;
    // Electron may keep visibilityState visible while an active turn disables
    // throttling. Observe the existing host hide/minimize gate as well.
    const update = () => setNativeVisible(!document.documentElement.hasAttribute(HIDDEN_ANIMATION_ATTR));
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: [HIDDEN_ANIMATION_ATTR] });
    return () => observer.disconnect();
  }, [options.live]);
  const active = !options.live || (options.active !== false && visible && nativeVisible);
  const activeProvider = active ? provider : undefined;
  const source = activeProvider
    ? providerWeeklyQuotaSource({ ...activeProvider, suspended: false })
    : null;
  const providerId = activeProvider?.id;
  const epoch = useDeviceLinkReconnectEpoch(
    options.live && source ? deviceId ?? undefined : undefined,
    options.live ? true : undefined,
  );
  const local = useProviderSubscriptionCard(deviceId === null ? activeProvider : undefined, {
    live: options.live === true,
  });
  const remote = useRemoteProviderSubscriptionCard(
    deviceId === null ? undefined : activeProvider,
    deviceId,
    options.live === true,
    epoch,
  );
  useEffect(() => {
    if (!options.live || !source || !providerId) return;
    const timer = window.setInterval(
      () => refreshSubscriptionCard(source, providerId, deviceId, { background: true }),
      15_000,
    );
    return () => window.clearInterval(timer);
  }, [options.live, source, providerId, deviceId]);
  // Live mirrors observe epoch changes with the same cancellable lifecycle as
  // mount/resume. Native Codex retains its shared one-per-entry recovery probe.
  const { t } = useTranslation();
  const kimi = useProviderAccountUsage(
    deviceId && isKimiCodingProviderView(provider) ? provider : undefined,
    undefined,
    deviceId,
    { live: options.live === true, active, refreshEpoch: epoch },
  );
  if (deviceId && kimi.supported) {
    const snapshot = kimi.result?.status === 'ready' ? kimi.result.snapshot : null;
    const card = buildKimiUsageCard(snapshot?.kind === 'kimi-coding-quota' ? snapshot : null, t);
    if (kimi.result?.status === 'unavailable') card.emptyText = t(`providerAccountUsage.kimi.error.${kimi.result.error}`);
    if (kimi.result?.status === 'ready' && kimi.result.stale) card.notices = [{ text: t('providerAccountUsage.kimi.stale'), tone: 'warn' }];
    return card;
  }
  return deviceId === null ? local : remote;
}

function refreshSubscriptionCard(
  source: NonNullable<ReturnType<typeof providerWeeklyQuotaSource>>,
  providerId: string,
  deviceId: string | null,
  scheduling?: { background?: boolean },
): void {
  if (deviceId) {
    if (source === 'codex') {
      requestRemoteCodexRateLimitsRefresh(deviceId, providerId, false, scheduling);
      requestRemoteCodexAccountRefresh(deviceId, providerId, false, scheduling);
    } else if (source === 'claude') {
      requestRemoteClaudeSubscriptionRefresh(deviceId, providerId, false, scheduling);
    } else if (source === 'xai') requestRemoteXaiSubscriptionRefresh(deviceId, providerId, false, scheduling);
  } else if (source === 'codex') {
    requestCodexRateLimitsRefresh(providerId);
    requestCodexAccountRefresh(providerId, true);
  } else if (source === 'claude') requestClaudeSubscriptionRefresh(providerId, true);
  else if (source === 'xai') requestXaiSubscriptionRefresh(providerId, true);
}
