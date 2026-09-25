import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RemoteResource } from '@cindy/device-link';
import { AppState } from 'react-native';
import { useFocusEffect, useIsFocused, useLocalSearchParams, useRouter } from 'expo-router';
import { useAuth } from '@/auth/AuthContext';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { getRemoteResource } from '@/device-link/remoteResources';
import { readRemoteCollectionCache } from '@/device-link/remoteResourceAvailability';
import { formatRemoteError } from '@/device-link/remoteStatus';
import { markRemoteResourceRead } from '@/device-link/remoteResourceCache';
import { startFocusedTopicSubscription } from '@/device-link/focusedTopicSubscription';
import { remoteSessionStore } from './remoteSessionStore';
import type { RemoteSession } from './types';

/** Follow a companion's current host-owned task on focus/reconnect, retaining its permanent identity. */
export function useRemoteResourceSession(deviceId: string, deviceName: string, sessionId: string, canMarkRead: boolean, metadataVerified = false) {
  const params = useLocalSearchParams<{ resourceCollectionId?: string; resourceId?: string; resourceKind?: string }>();
  const collectionId = typeof params.resourceCollectionId === 'string' ? params.resourceCollectionId : '';
  const resourceId = typeof params.resourceId === 'string' ? params.resourceId : '';
  const resourceKind = typeof params.resourceKind === 'string' ? params.resourceKind : '';
  const { invoke, connectionEpoch, status, onRemoteResourceChanged, subscribe, unsubscribe } = useDeviceLink();
  const { user, accountGeneration } = useAuth();
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const focused = useIsFocused();
  const identity = JSON.stringify([accountGeneration, deviceId, sessionId, collectionId, resourceKind, resourceId]);
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
  const resource = display?.identity === identity ? display.resource : cached ?? null;
  const ready = !required || (focused && AppState.currentState === 'active' && status === 'online' && verified === binding && metadataVerified);
  useEffect(() => {
    if (ready && canMarkRead && resourceKind === 'bot' && resource) {
      void markRemoteResourceRead(user?.id ?? '', deviceId, resourceId, resource.display.lastReplyAt ?? 0);
    }
  }, [canMarkRead, deviceId, ready, resource, resourceId, resourceKind, user?.id]);
  useFocusEffect(useCallback(() => {
    if (!collectionId || !resourceId || !resourceKind || !deviceId || status !== 'online') return;
    setVerified(null);
    let disposed = false;
    let generation = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      if (AppState.currentState !== 'active') return;
      const expected = ++generation;
      const valid = () => !disposed && current.current === binding && generation === expected && AppState.currentState === 'active';
      try {
        const resource = await getRemoteResource(invoke, { deviceId, deviceName }, { collectionId, id: resourceId, kind: resourceKind }, i18n.language);
        if (!valid()) return;
        // Reuse this existing read rather than issuing a second profile request per turn.
        setDisplay({ identity, resource });
        setFailure(null);
        const stage = (resource.blocks?.find(block => block.id === 'invitation' && block.primitive === 'status')?.data as { stage?: string } | undefined)?.stage;
        if (stage && stage !== 'ready') {
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
          const session = await invoke<RemoteSession>(deviceId, 'local-db:sessions:get', [target.sessionId]);
          if (!valid()) return;
          if (!session || session.id !== target.sessionId || (resourceKind === 'bot' && session.source !== 'bot')) throw new Error(t('devices.resources.noConversation'));
          const prior = remoteSessionStore.getSessionDeviceId(session.id);
          if (prior && prior !== deviceId) throw new Error(t('devices.resources.noConversation'));
          remoteSessionStore.upsertDeviceSession(deviceId, deviceName, session);
          router.setParams({ sessionId: session.id });
          return; // The replacement task must mount and finish its own message sync first.
        }
        setVerified(binding);
      } catch (error) {
        if (!valid()) return;
        setVerified(null);
        setFailure({ binding, message: formatRemoteError(error) });
        const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
        if (code === 'NOT_FOUND' || /\[NOT_FOUND\]/.test(String(error))) {
          setDisplay(null);
          // A removed/hidden resource must leave the cached task view immediately.
          // The resolver displays the existing unavailable/retry state.
          router.replace({ pathname: '/resources/[collectionId]/[resourceId]', params: {
            collectionId, resourceId, resourceKind, deviceId, deviceName,
          } });
        }
        // Transient link errors retain the normal task recovery path.
      }
    };
    const offPush = onRemoteResourceChanged((source, payload) => {
      if (source !== deviceId || payload.collectionId !== collectionId || timer) return;
      if (payload.resourceRefs?.length && !payload.resourceRefs.some((ref) => ref.id === resourceId && ref.kind === resourceKind)) return;
      generation += 1;
      timer = setTimeout(() => { timer = undefined; void load(); }, 300);
    });
    const offTopic = startFocusedTopicSubscription({ deviceId, owner: `resource-session:${sessionId}`, topic: 'sessions', subscribe, unsubscribe });
    const appState = AppState.addEventListener('change', (state) => { generation += 1; setVerified(null); if (state === 'active') void load(); });
    void load();
    return () => { disposed = true; setVerified(null); offPush(); offTopic(); appState.remove(); if (timer) clearTimeout(timer); };
  }, [attempt, binding, collectionId, deviceId, deviceName, identity, invoke, i18n.language, onRemoteResourceChanged, resourceId, resourceKind, router, sessionId, status, subscribe, t, unsubscribe, user?.id]));
  return { resource, ready, error: failure?.binding === binding ? failure.message : null, retry };
}
