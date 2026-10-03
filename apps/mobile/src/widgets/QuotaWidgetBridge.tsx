import { useEffect, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { useTheme } from '@/theme';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent } from '@/auth/authOwnerGeneration';
import { nativeQuotaWidget, quotaWidgetStore } from './quotaWidgetStore';
import type { WidgetQuotaReader } from './readWidgetQuota';

export function useQuotaWidgetRefresh() {
  const link = useDeviceLink();
  const state = useSyncExternalStore(quotaWidgetStore.subscribe, quotaWidgetStore.getSnapshot);
  const refresh = async () => {
    const deviceId = state.deviceId;
    if (!deviceId || AppState.currentState !== 'active' || quotaWidgetStore.getSnapshot().deviceId !== deviceId) return;
    if (link.status !== 'online' || link.getPresenceAvailability(deviceId) === false) { quotaWidgetStore.offline(); return; }
    const owner = getMobileAuthOwner();
    const call = (channel: string, args?: unknown[]) => link.invoke(deviceId, channel, args, { preSend: () => {
      if (!isMobileAuthOwnerCurrent(owner) || quotaWidgetStore.getSnapshot().deviceId !== deviceId || AppState.currentState !== 'active') {
        throw new Error('Quota widget read is no longer current');
      }
    } });
    const reader: WidgetQuotaReader = {
      listProviders: () => call('maker:provider:list'),
      getCodexRateLimits: (id) => call('maker:usage:codex-rate-limits', id ? [id] : undefined),
      getAccountUsage: (agent, id) => call('maker:usage:account', id ? [agent, id] : [agent]),
      getSubscriptionUsage: (platform, id) => call(`maker:usage:${platform}-subscription`, id ? [id] : undefined),
    };
    await quotaWidgetStore.refresh(reader);
  };
  return { state, refresh, link };
}

/** Foreground only. Never keep the relay, JS runtime, or background audio alive for widgets. */
export function QuotaWidgetBridge() {
  const { state, refresh, link } = useQuotaWidgetRefresh();
  const { preference } = useTheme();
  const { i18n } = useTranslation();
  useEffect(() => {
    try { nativeQuotaWidget?.setPresentation(i18n.resolvedLanguage ?? 'en', preference); } catch { /* Page reports unsupported native builds. */ }
  }, [i18n.resolvedLanguage, preference]);
  useEffect(() => {
    if (!nativeQuotaWidget || !state.ready || !state.deviceId) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 60_000);
    const sub = AppState.addEventListener('change', next => {
      if (next === 'active') void refresh();
      else quotaWidgetStore.suspend();
    });
    return () => { clearInterval(timer); sub.remove(); };
  }, [state.ready, state.deviceId, link.status, link.connectionEpoch, link.presenceVersion]);
  return null;
}
