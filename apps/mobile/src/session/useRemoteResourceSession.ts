import { useCallback, useRef } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useAuth } from '@/auth/AuthContext';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { getRemoteResource } from '@/device-link/remoteResources';
import { markRemoteResourceRead } from '@/device-link/remoteResourceCache';
import { startFocusedTopicSubscription } from '@/device-link/focusedTopicSubscription';
import { remoteSessionStore } from './remoteSessionStore';
import type { RemoteSession } from './types';

/** Follow a companion's current host-owned task on focus/reconnect, retaining its permanent identity. */
export function useRemoteResourceSession(deviceId: string, deviceName: string, sessionId: string): void {
  const params = useLocalSearchParams<{ resourceCollectionId?: string; resourceId?: string; resourceKind?: string }>();
  const collectionId = typeof params.resourceCollectionId === 'string' ? params.resourceCollectionId : '';
  const resourceId = typeof params.resourceId === 'string' ? params.resourceId : '';
  const resourceKind = typeof params.resourceKind === 'string' ? params.resourceKind : '';
  const { invoke, connectionEpoch, status, onRemoteResourceChanged, subscribe, unsubscribe } = useDeviceLink();
  const { user, accountGeneration } = useAuth();
  const router = useRouter();
  const binding = JSON.stringify([accountGeneration, connectionEpoch, deviceId, sessionId, collectionId, resourceId]);
  const current = useRef(binding); current.current = binding;
  useFocusEffect(useCallback(() => {
    if (!collectionId || !resourceId || !resourceKind || !deviceId || status !== 'online') return;
    let disposed = false;
    let generation = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      if (AppState.currentState !== 'active') return;
      const expected = ++generation;
      const valid = () => !disposed && current.current === binding && generation === expected && AppState.currentState === 'active';
      try {
        const resource = await getRemoteResource(invoke, { deviceId, deviceName }, { collectionId, id: resourceId, kind: resourceKind });
        if (!valid()) return;
        const target = resource.links.find((link) => link.rel === 'conversation')?.target;
        if (target?.kind !== 'session') return;
        if (target.sessionId !== sessionId) {
          const session = await invoke<RemoteSession>(deviceId, 'local-db:sessions:get', [target.sessionId]);
          if (!valid() || !session || session.id !== target.sessionId || (resourceKind === 'bot' && session.source !== 'bot')) return;
          const prior = remoteSessionStore.getSessionDeviceId(session.id);
          if (prior && prior !== deviceId) return;
          remoteSessionStore.upsertDeviceSession(deviceId, deviceName, session);
          router.setParams({ sessionId: session.id });
        }
        if (resourceKind === 'bot') void markRemoteResourceRead(user?.id ?? '', deviceId, resourceId, resource.display.lastReplyAt ?? 0);
      } catch { /* normal session recovery handles link errors; retry on focus/push/reconnect */ }
    };
    const offPush = onRemoteResourceChanged((source, payload) => {
      if (source !== deviceId || payload.collectionId !== collectionId || timer) return;
      if (payload.resourceRefs?.length && !payload.resourceRefs.some((ref) => ref.id === resourceId && ref.kind === resourceKind)) return;
      timer = setTimeout(() => { timer = undefined; void load(); }, 300);
    });
    const offTopic = startFocusedTopicSubscription({ deviceId, owner: `resource-session:${sessionId}`, topic: 'sessions', subscribe, unsubscribe });
    const appState = AppState.addEventListener('change', (state) => { generation += 1; if (state === 'active') void load(); });
    void load();
    return () => { disposed = true; offPush(); offTopic(); appState.remove(); if (timer) clearTimeout(timer); };
  }, [binding, collectionId, deviceId, deviceName, invoke, onRemoteResourceChanged, resourceId, resourceKind, router, sessionId, status, subscribe, unsubscribe, user?.id]));
}
