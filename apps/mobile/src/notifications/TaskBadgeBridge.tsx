import { useEffect } from 'react';
import { AppState } from 'react-native';
import { useAuth } from '@/auth/AuthContext';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { remoteSessionStore } from '@/session/remoteSessionStore';
import { readTaskBadgeCount } from '@/widgets/agentActivity';
import { createTaskBadgeSync } from './notificationBadge';
import { isPushSupported, readPushEnabled, subscribePushPreferences } from './pushNotifications';

/** Runs on Android too, independently of ActivityKit. No new network subscription. */
export function TaskBadgeBridge() {
  const { initialized, isAuthenticated, user, accountGeneration } = useAuth();
  const { status, getConnectionState, getPresenceAvailability, getSubscriptionIdentity, presenceVersion } = useDeviceLink();
  const accountId = user?.id;
  useEffect(() => {
    if (!isPushSupported() || !initialized || !isAuthenticated || !accountId) return;
    let disposed = false;
    let enabled: boolean | undefined;
    let preferenceVersion = 0;
    const controller = createTaskBadgeSync(() => {
      if (enabled === undefined) return undefined;
      if (!enabled) return 0;
      return readTaskBadgeCount(remoteSessionStore.getHomeSessions(), accountId,
        remoteSessionStore.getSessionSnapshotDeviceIds(),
        deviceId => (getConnectionState?.(deviceId).status ?? status) === 'online'
          && getPresenceAvailability(deviceId) !== false
          && remoteSessionStore.isDeviceHomeSnapshotReady(deviceId)
          && !!getSubscriptionIdentity && getSubscriptionIdentity(deviceId, ['sessions']) !== null,
        session => remoteSessionStore.getSessionLiveActivity(session.id, session.deviceLinkDeviceId));
    }, () => !disposed && AppState.currentState === 'active');
    const sync = (force = false) => { void controller.sync(force).catch(() => undefined); };
    const refreshPreferences = async () => {
      const version = ++preferenceVersion;
      enabled = undefined;
      const next = await readPushEnabled();
      if (disposed || version !== preferenceVersion) return;
      enabled = next;
      sync(true);
    };
    const unsubscribe = remoteSessionStore.subscribeHomeStatus(() => sync());
    const preferences = subscribePushPreferences(signedOut => {
      if (signedOut) { disposed = true; controller.dispose(); }
      else void refreshPreferences();
    });
    const foreground = AppState.addEventListener('change', state => {
      if (state === 'active') void refreshPreferences();
    });
    void refreshPreferences();
    return () => { disposed = true; controller.dispose(); unsubscribe(); preferences(); foreground.remove(); };
  }, [initialized, isAuthenticated, accountId, accountGeneration, status, getConnectionState,
    getPresenceAvailability, getSubscriptionIdentity, presenceVersion]);
  return null;
}
