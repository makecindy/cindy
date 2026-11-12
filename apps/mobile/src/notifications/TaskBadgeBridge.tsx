import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { useAuth } from '@/auth/AuthContext';
import { useSelfHostedRelay } from '@/device-link/selfHostedRelay';
import { getActiveMobileSessionRealm, getMobileEndpointForRealm, loadMobileEndpointsForRealm } from '@/config/env';
import Notifications from './nativeNotifications';
import { applyTaskBadge, setTaskBadgeIdentity } from './nativeTaskBadge';
import { createServerTaskBadgeSync, parseTaskBadgeSnapshot, readNotificationTaskBadge } from './taskBadgeSync';
import { isPushSupported, readPushEnabled, subscribePushPreferences } from './pushNotifications';

/** Account totals only. Home pagination, filters and device selection never write a badge. */
export function TaskBadgeBridge() {
  const auth = useAuth();
  const accountId = auth.user?.id;
  const relay = useSelfHostedRelay();
  const apiFetch = useRef(auth.apiFetch);
  apiFetch.current = auth.apiFetch;
  useEffect(() => {
    if (!isPushSupported() || !auth.initialized || !auth.isAuthenticated || !accountId || relay) return;
    const realm = getActiveMobileSessionRealm();
    let disposed = false;
    let enabled = false;
    let unavailable = false;
    let preferenceVersion = 0;
    const abort = new AbortController();
    const current = () => !disposed && enabled && AppState.currentState === 'active'
      && getActiveMobileSessionRealm() === realm;
    const assertCurrent = () => { if (!current()) throw new Error('TASK_BADGE_LIFETIME_ENDED'); };
    const controller = createServerTaskBadgeSync(async () => {
      if (unavailable) return;
      await loadMobileEndpointsForRealm(realm);
      assertCurrent();
      try {
        const data = await apiFetch.current<unknown>('/api/device-link/task-activity', {
          baseUrl: getMobileEndpointForRealm(realm, 'deviceLinkApiBaseUrl'),
          cache: 'no-store', signal: abort.signal, assertCurrent,
        });
        return parseTaskBadgeSnapshot(data, accountId);
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (status === 404 || status === 405) { unavailable = true; return; }
        throw error;
      }
    }, current, accountId, applyTaskBadge);
    const refreshPreferences = async () => {
      const version = ++preferenceVersion;
      enabled = false;
      const next = await readPushEnabled();
      if (disposed || version !== preferenceVersion) return;
      enabled = next;
      await setTaskBadgeIdentity(next ? `${realm}:${accountId}` : '', next ? accountId : '').catch(() => undefined);
      if (disposed || version !== preferenceVersion) return;
      if (current()) await controller.refresh().catch(() => undefined);
    };
    const received = Notifications.addNotificationReceivedListener(notification => {
      const summary = readNotificationTaskBadge(notification, accountId);
      void controller.accept(summary).catch(() => undefined);
    });
    const preferences = subscribePushPreferences(signedOut => {
      if (signedOut) { disposed = true; abort.abort(); controller.dispose(); void setTaskBadgeIdentity('', '').catch(() => undefined); }
      else void refreshPreferences();
    });
    const foreground = AppState.addEventListener('change', state => {
      if (state === 'active') void refreshPreferences();
    });
    void refreshPreferences();
    return () => { disposed = true; abort.abort(); controller.dispose(); received.remove(); preferences(); foreground.remove(); void setTaskBadgeIdentity('', '').catch(() => undefined); };
  }, [auth.initialized, auth.isAuthenticated, accountId, auth.accountGeneration, relay]);
  return null;
}
