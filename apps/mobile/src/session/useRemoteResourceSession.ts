import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RemoteResource } from '@cindy/device-link';
import { AppState } from 'react-native';
import { useFocusEffect, useIsFocused, useLocalSearchParams, useRouter } from 'expo-router';
import { useAuth } from '@/auth/AuthContext';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { getRemoteResource } from '@/device-link/remoteResources';
import { readRemoteCollectionCache } from '@/device-link/remoteResourceAvailability';
import { createRemoteReadRecovery } from '@/device-link/remoteReadRecovery';
import { createRemoteSyncCoordinator, retryRemoteSyncRead, type RemoteSyncRun } from '@/device-link/remoteSyncTask';
import { isAutoRecoveringRemoteError, formatRemoteError } from '@/device-link/remoteStatus';
import { forgetRemoteResource, markRemoteResourceRead } from '@/device-link/remoteResourceCache';
import { startFocusedTopicSubscription } from '@/device-link/focusedTopicSubscription';
import { remoteSessionStore } from './remoteSessionStore';
import type { RemoteSession } from './types';
import { useCachedCompanionSession } from './useCachedCompanionSession';

/** Follow a companion's current host-owned task on focus/reconnect, retaining its permanent identity. */
export function useRemoteResourceSession(deviceId: string, deviceName: string, sessionId: string, canMarkRead: boolean, metadataVerified = false) {
  const params = useLocalSearchParams<{ resourceCollectionId?: string; resourceId?: string; resourceKind?: string; openSearch?: string; resourceHistorySessionId?: string; resourceThreadRootSessionId?: string; resourceThreadRootClientId?: string }>();
  const savedCompanion = useCachedCompanionSession(deviceId, sessionId);
  const collectionId = typeof params.resourceCollectionId === 'string' ? params.resourceCollectionId : savedCompanion ? 'teammates' : '';
  const resourceId = typeof params.resourceId === 'string' ? params.resourceId : savedCompanion?.ref.id ?? '';
  const resourceKind = typeof params.resourceKind === 'string' ? params.resourceKind : savedCompanion?.ref.kind ?? '';
  const historyEntry = params.openSearch === '1';
  const threadRootSessionId = typeof params.resourceThreadRootSessionId === 'string' ? params.resourceThreadRootSessionId : '';
  const threadRootClientId = typeof params.resourceThreadRootClientId === 'string' ? params.resourceThreadRootClientId : '';
  const threadEntry = !!(threadRootSessionId || threadRootClientId);
  const transcriptEntry = params.resourceHistorySessionId === sessionId;
  const { invoke, openLink, connectionEpoch, status, onRemoteResourceChanged, subscribe, unsubscribe } = useDeviceLink();
  const { user, accountGeneration } = useAuth();
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const focused = useIsFocused();
  const identity = JSON.stringify([accountGeneration, deviceId, sessionId, collectionId, resourceKind, resourceId, historyEntry, transcriptEntry, threadRootSessionId, threadRootClientId]);
  const [display, setDisplay] = useState<{ identity: string; resource: RemoteResource } | null>(null);
  const binding = JSON.stringify([identity, connectionEpoch, i18n.language]);
  const current = useRef(binding); current.current = binding;
  const required = !!(collectionId && resourceId && resourceKind && deviceId);
  const [verified, setVerified] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ binding: string; message: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt(value => value + 1), []);
  const cached = readRemoteCollectionCache(`${user?.id ?? ''}:${accountGeneration}`, collectionId)
    .find(row => row.host.deviceId === deviceId && row.item.ref.id === resourceId && row.item.ref.kind === resourceKind)?.item;
  const savedMatches = savedCompanion?.ref.id === resourceId && savedCompanion.ref.kind === resourceKind && collectionId === 'teammates';
  const resource = display?.identity === identity ? display.resource : cached ?? (savedMatches ? savedCompanion : null);
  const stage = (display?.identity === identity
    ? display.resource.blocks?.find(block => block.id === 'invitation' && block.primitive === 'status')?.data as { stage?: string } | undefined
    : undefined)?.stage;
  const cachedTarget = resource?.links.find(link => link.rel === 'conversation')?.target;
  // Local editing and durable queuing do not confer permission to dispatch.
  const canCompose = !transcriptEntry && (!threadEntry || verified === binding) && (!required || (!!resource && cachedTarget?.kind === 'session' && (threadEntry || cachedTarget.sessionId === sessionId)
    && (!stage || stage === 'ready') && (!failure || failure.binding !== binding || isAutoRecoveringRemoteError(failure.message))));
  // `ready` also unlocks queued sends and runtime controls in the session screen.
  const ready = !transcriptEntry && (!threadEntry || (required && verified === binding)) && (!required || (focused && AppState.currentState === 'active' && status === 'online' && verified === binding && metadataVerified));
  const markReadThrough = useCallback((at: number) => {
    if (!threadEntry && !transcriptEntry && current.current === binding && AppState.currentState === 'active' && ready && canMarkRead && resourceKind === 'bot' && resource && Number.isFinite(at) && at > 0) {
      // The synchronized, visible message is the read boundary. The independent
      // resource lookup can predate it; capping at that snapshot leaves a reply
      // unread even after the user has reached it in the chat.
      void markRemoteResourceRead(user?.id ?? '', deviceId, resourceId, at);
    }
  }, [binding, canMarkRead, deviceId, ready, resource, resourceId, resourceKind, user?.id, transcriptEntry, threadEntry]);
  useFocusEffect(useCallback(() => {
    if (!collectionId || !resourceId || !resourceKind || !deviceId || status !== 'online') return;
    setVerified(null);
    let disposed = false;
    let generation = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const recovery = createRemoteReadRecovery(() => { void coordinator.request({ reason: 'retry' }); },
      () => !disposed && current.current === binding && AppState.currentState === 'active');
    const load = async (run: RemoteSyncRun) => {
      if (AppState.currentState !== 'active') return;
      const expected = ++generation;
      const valid = () => !run.isStale() && !disposed && current.current === binding && generation === expected && AppState.currentState === 'active';
      try {
        const resource = await retryRemoteSyncRead(run, async () => {
          await openLink(deviceId);
          return getRemoteResource(invoke, { deviceId, deviceName }, { collectionId, id: resourceId, kind: resourceKind }, i18n.language);
        });
        if (!valid()) return;
        if (threadEntry) {
          const profile = await retryRemoteSyncRead(run, () => invoke<{
            dmThreadsSupported?: boolean;
            sessions?: Array<{ id: string; role: string; status: string; threadRoot?: { rootSessionId: string; rootClientId: string } }>;
          }>(deviceId, 'local-db:bots:get', [resourceId]));
          if (!valid()) return;
          if (resourceKind !== 'bot' || !profile?.dmThreadsSupported || !profile.sessions?.some(row =>
            row.id === sessionId && row.role === 'thread' && row.status === 'active'
            && row.threadRoot?.rootSessionId === threadRootSessionId && row.threadRoot.rootClientId === threadRootClientId)) {
            throw new Error(t('devices.resources.noConversation'));
          }
          setDisplay({ identity, resource });
          setFailure(null);
          setVerified(binding);
          recovery.succeeded();
          return;
        }
        if (transcriptEntry) {
          const profile = await retryRemoteSyncRead(run, () => invoke<{
            sessions?: Array<{ id: string; role: string; status: string }>;
          }>(deviceId, 'local-db:bots:get', [resourceId]));
          if (!valid()) return;
          if (!profile?.sessions?.some(row => row.id === sessionId && row.status !== 'deleted'
            && (row.role === 'canonical' || row.role === 'history'))) {
            throw new Error(t('devices.resources.noConversation'));
          }
          setDisplay({ identity, resource });
          setFailure(null);
          setVerified(binding);
          recovery.succeeded();
          return;
        }
        // Reuse this existing read rather than issuing a second profile request per turn.
        setDisplay({ identity, resource });
        setFailure(null);
        const stage = (resource.blocks?.find(block => block.id === 'invitation' && block.primitive === 'status')?.data as { stage?: string } | undefined)?.stage;
        const invitationPending = !!stage && stage !== 'ready';
        if (invitationPending && !historyEntry) {
          setVerified(null);
          router.replace({ pathname: '/resources/[collectionId]/[resourceId]', params: {
            collectionId, resourceId, resourceKind, deviceId, deviceName,
          } });
          return;
        }
        const target = resource.links.find((link) => link.rel === 'conversation')?.target;
        if (target?.kind !== 'session') throw new Error(t('devices.resources.noConversation'));
        if (target.sessionId !== sessionId) {
          setVerified(null);
          const session = await retryRemoteSyncRead(run, () => invoke<RemoteSession>(deviceId, 'local-db:sessions:get', [target.sessionId]));
          if (!valid()) return;
          if (!session || session.id !== target.sessionId || (resourceKind === 'bot' && session.source !== 'bot')) throw new Error(t('devices.resources.noConversation'));
          const prior = remoteSessionStore.getSessionDeviceId(session.id);
          if (prior && prior !== deviceId) throw new Error(t('devices.resources.noConversation'));
          remoteSessionStore.upsertDeviceSession(deviceId, deviceName, session);
          router.setParams({ sessionId: session.id });
          return; // The replacement task must mount and finish its own message sync first.
        }
        // History remains visible during preparation, but must not enable the
        // composer, realtime controls or queued sends until the invitation is ready.
        setVerified(invitationPending ? null : binding);
        recovery.succeeded();
      } catch (error) {
        if (!valid()) return;
        setVerified(null);
        setFailure({ binding, message: formatRemoteError(error) });
        recovery.failed(error);
        const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
        const denied = ['NOT_FOUND', 'FORBIDDEN', 'PERMISSION_DENIED', 'ACCESS_REVOKED', 'DEVICE_REVOKED'];
        if (denied.includes(String(code)) || denied.some(value => String(error).includes(`[${value}]`))) {
          setDisplay(null);
          if (user?.id) void forgetRemoteResource(user.id, resourceId);
          // A removed/hidden resource must leave the cached task view immediately.
          // The resolver displays the existing unavailable/retry state.
          router.replace({ pathname: '/resources/[collectionId]/[resourceId]', params: {
            collectionId, resourceId, resourceKind, deviceId, deviceName,
          } });
        }
        // Transient link errors retain the normal task recovery path.
      }
    };
    const coordinator = createRemoteSyncCoordinator(load);
    coordinator.setContext(binding);
    const refresh = () => { void coordinator.request({ reason: 'changed' }); };
    const offPush = onRemoteResourceChanged((source, payload) => {
      if (source !== deviceId || payload.collectionId !== collectionId || timer) return;
      if (payload.resourceRefs?.length && !payload.resourceRefs.some((ref) => ref.id === resourceId && ref.kind === resourceKind)) return;
      generation += 1;
      setVerified(null);
      timer = setTimeout(() => { timer = undefined; refresh(); }, 300);
    });
    const offTopic = startFocusedTopicSubscription({ deviceId, owner: `resource-session:${sessionId}`, topic: 'sessions', subscribe, unsubscribe });
    const appState = AppState.addEventListener('change', (state) => { generation += 1; setVerified(null); if (state === 'active') { coordinator.setContext(binding); refresh(); } else coordinator.setContext('background'); });
    refresh();
    return () => { disposed = true; recovery.dispose(); coordinator.setContext('disposed'); setVerified(null); offPush(); offTopic(); appState.remove(); if (timer) clearTimeout(timer); };
  }, [attempt, binding, historyEntry, transcriptEntry, threadEntry, threadRootSessionId, threadRootClientId, collectionId, deviceId, deviceName, identity, invoke, openLink, i18n.language, onRemoteResourceChanged, resourceId, resourceKind, router, sessionId, status, subscribe, t, unsubscribe, user?.id]));
  return { resource, ready, canCompose, threadRootSessionId, threadRootClientId, readOnly: transcriptEntry, markReadThrough, error: failure?.binding === binding ? failure.message : null, retry };
}
