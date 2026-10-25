import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Redirect, useIsFocused } from 'expo-router';
import { AppState } from 'react-native';
import { useTranslation } from 'react-i18next';
import { isSharedTaskPeer } from '@cindy/device-link';
import { CINDY_MAKE_ENABLED, isCindyMakeSource } from '@cindy/maker-shared/cindy-make-feature';
import { useAuth } from '@/auth/AuthContext';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { retryRemoteSyncRead } from '@/device-link/remoteSyncTask';
import { useMobileMakerTransport } from '@/device-link/useMobileMakerTransport';
import { remoteSessionStore } from './remoteSessionStore';
import { MainWindowActionButton } from '@/components/MobilePrimitives';
import { useNewSessionCreationTask } from './newSessionCreation';
import { SessionEntryStatus } from './SessionEntryRecovery';

export const SESSION_ENTRY_LOOKUP_TIMEOUT_MS = 20_000;
type Lookup = { key: string; status: 'loading' | 'failed' | 'missing' | 'timedOut' | 'loaded' };

/** Use the raw mirror to recognize hidden tasks opened by an old link. */
export function CindyMakeSessionGate({ sessionId, deviceId: routeDeviceId, children, ownsSessionSubscription = false }: {
  sessionId: string;
  deviceId?: string;
  children: ReactNode;
  /** Only the task route owns the pipeline subscription; file routes also use this gate. */
  ownsSessionSubscription?: boolean;
}) {
  const { t } = useTranslation();
  const { accountGeneration } = useAuth();
  const { openLink, connectionEpoch, unsubscribe, status: relayStatus, getPresenceAvailability } = useDeviceLink();
  const focused = useIsFocused();
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => setForeground(state === 'active'));
    return () => subscription.remove();
  }, []);
  const sessions = useSyncExternalStore(remoteSessionStore.subscribe, remoteSessionStore.getSessions);
  const deviceId = routeDeviceId ?? remoteSessionStore.getSessionDeviceId(sessionId) ?? '';
  const maker = useMobileMakerTransport(deviceId);
  const presence = getPresenceAvailability(deviceId);
  // The creation pipeline registers this owner before navigating here. The gate
  // owns its lifetime even when source lookup keeps the task content unmounted.
  useEffect(() => () => {
    if (!ownsSessionSubscription || !deviceId || !sessionId) return;
    void unsubscribe(`session:${sessionId}`, deviceId, ['sessions', `session:${sessionId}`]).catch(() => undefined);
  }, [deviceId, sessionId, unsubscribe, ownsSessionSubscription]);
  const knownSession = sessions.find(session => session.id === sessionId
    && (!deviceId || session.deviceLinkDeviceId === deviceId));
  const knownSource = knownSession?.source;
  const task = useNewSessionCreationTask(sessionId);
  const localCreation = task?.sessionId === sessionId && task.deviceId === deviceId
    && (task.status === 'running' || task.status === 'create-failed') ? task : null;
  const creationBlocked = localCreation !== null;
  const [attempt, setAttempt] = useState(0);
  const scope = JSON.stringify([sessionId, deviceId, accountGeneration]);
  const key = JSON.stringify([sessionId, deviceId, accountGeneration, connectionEpoch, relayStatus, presence, focused, foreground, attempt]);
  const [lookup, setLookup] = useState<Lookup | null>(null);
  // Reconnecting must not unmount content whose source was already confirmed for this owner.
  const [loaded, setLoaded] = useState<{ scope: string; source: string | null } | null>(null);

  useEffect(() => {
    if (CINDY_MAKE_ENABLED) return;
    if (knownSource !== undefined) {
      // A mirror confirmation is as authoritative as a direct lookup. Preserve
      // the latest source for this scope when reconnecting clears the mirror.
      setLoaded({ scope, source: knownSource });
      return;
    }
    if (creationBlocked || !focused || !foreground) return;
    if (!sessionId || !deviceId) {
      setLookup({ key, status: 'failed' });
      return;
    }
    const controller = new AbortController();
    const cancelled = () => controller.signal.aborted;
    setLookup({ key, status: 'loading' });
    // This deadline only closes this read attempt; it never tears down the shared link.
    const timeout = setTimeout(() => {
      controller.abort();
      setLookup({ key, status: 'timedOut' });
    }, SESSION_ENTRY_LOOKUP_TIMEOUT_MS);
    // Login restoration can route a notification before DeviceLinkProvider has
    // started. Wait for transport evidence, not an arbitrary startup delay.
    // Presence changes also resume this lookup without a relay reconnect.
    // Shared-task peers report link readiness instead of host presence: their
    // first open must still run, or waiting for availability would deadlock.
    if (relayStatus !== 'online' || (presence === false && !isSharedTaskPeer(deviceId))) {
      return () => { controller.abort(); clearTimeout(timeout); };
    }
    void retryRemoteSyncRead({ signal: controller.signal, isStale: cancelled }, async () => {
      await openLink(deviceId);
      // Do not issue metadata reads after a late accept for an abandoned route.
      if (cancelled()) return null;
      return maker.getSession(sessionId);
    })
      .then(session => {
        if (cancelled()) return;
        if (session?.id === sessionId) setLoaded({ scope, source: session.source ?? null });
        setLookup(session?.id === sessionId
          ? { key, status: 'loaded' }
          : { key, status: 'missing' });
      })
      .catch(() => { if (!cancelled()) setLookup({ key, status: 'failed' }); })
      .finally(() => clearTimeout(timeout));
    return () => { controller.abort(); clearTimeout(timeout); };
  }, [key, scope, sessionId, deviceId, knownSource, maker, openLink, creationBlocked, focused, foreground, relayStatus, presence]);

  const source = knownSource !== undefined ? knownSource : (
    loaded?.scope === scope ? loaded.source : undefined
  );
  if (!CINDY_MAKE_ENABLED && isCindyMakeSource(source)) return <Redirect href="/" />;
  // Locally initiated tasks already have an optimistic message/composer. Keep
  // that screen mounted; it also owns automatic draft recovery after failure.
  // File routes still require confirmed remote metadata.
  if (localCreation && ownsSessionSubscription) return children;
  if (!CINDY_MAKE_ENABLED && source === undefined) {
    const status = lookup?.key === key ? lookup.status : 'loading';
    return <SessionEntryStatus title={t('session.entry.title')}
      copy={t(`session.entry.${status}`)} loading={status === 'loading'}>
      {status !== 'loading' ? <MainWindowActionButton action={{
        label: t('session.entry.retry'), testID: 'session.entryRetry',
        onPress: () => setAttempt(value => value + 1),
      }} numberOfLines={0} /> : null}
    </SessionEntryStatus>;
  }
  return children;
}
