import { useEffect } from 'react';
import { AppState, Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';
import * as Linking from 'expo-linking';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/auth/AuthContext';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { remoteSessionStore } from '@/session/remoteSessionStore';
import { projectAgentActivity } from './agentActivity';
import { createAgentActivitySync, type AgentActivitySink } from './agentActivitySync';

const native = Platform.OS === 'ios'
  ? requireOptionalNativeModule<AgentActivitySink>('CindyAgentActivity')
  : null;

/** No new network subscription: ActivityKit mirrors the existing mobile task list. */
export function AgentActivityBridge() {
  const { initialized, isAuthenticated, user, accountGeneration } = useAuth();
  const { status, getConnectionState, getPresenceAvailability, getSubscriptionIdentity, presenceVersion } = useDeviceLink();
  const { t } = useTranslation();
  const accountId = user?.id;
  useEffect(() => {
    if (!native || !initialized) return;
    // End any previous account's activity before accepting this account's list.
    native.setState(null);
    return () => native.setState(null);
  }, [initialized, isAuthenticated, accountId, accountGeneration]);
  useEffect(() => {
    if (!native || !initialized || !isAuthenticated || !accountId) return;
    const controller = createAgentActivitySync(() => {
      const sessions = remoteSessionStore.getHomeSessions().filter(session => session.userId === accountId);
      const online = sessions.filter(session => !!session.deviceLinkDeviceId
        && (getConnectionState?.(session.deviceLinkDeviceId).status ?? status) === 'online'
        && getPresenceAvailability(session.deviceLinkDeviceId) !== false
        && (!getSubscriptionIdentity || getSubscriptionIdentity(session.deviceLinkDeviceId, ['sessions']) !== null));
      // Losing reachability is not evidence that the task has finished.
      if (!online.length && (status !== 'online' || sessions.some(session => session.status === 'active'
        && session.deviceLinkDeviceId && !session.cacheSeeded && !session.pendingLocalCreation))) return undefined;
      const state = projectAgentActivity(
        online,
        session => remoteSessionStore.getSessionLiveActivity(session.id, session.deviceLinkDeviceId),
        {
          attention: t('devices.companions.avatarStatus.awaiting'),
          running: t('devices.companions.avatarStatus.running'),
          completed: t('devices.companions.avatarStatus.done'),
          error: t('devices.companions.avatarStatus.error'),
        },
        session => Linking.createURL(`/sessions/${encodeURIComponent(session.id)}`, {
          queryParams: { deviceId: session.deviceLinkDeviceId! },
        }),
        t('devices.companions.stale'),
      );
      return state ? JSON.stringify({ accountId, state }) : null;
    }, native);
    const unsubscribe = remoteSessionStore.subscribeHomeStatus(() => controller.sync());
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const resume = () => {
      clearInterval(heartbeat);
      heartbeat = undefined;
      if (AppState.currentState !== 'active') return;
      controller.sync(true);
      heartbeat = setInterval(() => controller.sync(), 60_000);
    };
    resume();
    if (AppState.currentState !== 'active') controller.sync();
    const listener = AppState.addEventListener('change', state => {
      if (state === 'active') resume();
      else { clearInterval(heartbeat); heartbeat = undefined; }
    });
    return () => {
      controller.dispose();
      clearInterval(heartbeat);
      unsubscribe();
      listener.remove();
    };
  }, [initialized, isAuthenticated, accountId, accountGeneration, status, getConnectionState, getPresenceAvailability, getSubscriptionIdentity, presenceVersion, t]);
  return null;
}
