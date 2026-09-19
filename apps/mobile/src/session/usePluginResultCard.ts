import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useIsFocused } from 'expo-router';
import { AppState } from 'react-native';
import type { RemoteResourceBlock } from '@cindy/device-link';
import { useAuth } from '@/auth/AuthContext';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { getRemoteResource } from '@/device-link/remoteResources';
import { startFocusedTopicSubscription } from '@/device-link/focusedTopicSubscription';

/** A card is a read-only remote resource, scoped to account + device + task.
 * Refresh after foreground/reconnect and host invalidation; stale replies cannot
 * replace a recycled row or another account's card. */
export function usePluginResultCard(deviceId: string | undefined, sessionId: string, callId: string) {
  return useSessionPluginResource(deviceId, sessionId, callId, 'plugin-results', 'card');
}

export function useSessionPluginResource(deviceId: string | undefined, sessionId: string, callId: string, collectionId: string, kind: string) {
  const { invoke, connectionEpoch, status, onRemoteResourceChanged, subscribe, unsubscribe } = useDeviceLink();
  const { accountGeneration } = useAuth();
  const focused = useIsFocused();
  const subscriberId = useId();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ binding: string; blocks?: RemoteResourceBlock[]; title?: string; error?: boolean }>();
  const binding = JSON.stringify([accountGeneration, deviceId, sessionId, callId, collectionId, kind]);
  const current = useRef(binding); current.current = binding;
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  useEffect(() => {
    if (!deviceId || !focused || status !== 'online') return;
    let disposed = false;
    let generation = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const id = JSON.stringify([sessionId, callId]);
    const load = async () => {
      if (AppState.currentState !== 'active') return;
      const expected = ++generation;
      const valid = () => !disposed && current.current === binding && generation === expected && AppState.currentState === 'active';
      try {
        const resource = await getRemoteResource(invoke, { deviceId, deviceName: deviceId }, { collectionId, kind, id });
        if (valid()) setState({ binding, blocks: resource.blocks ?? [], title: typeof resource.display.title === 'string' ? resource.display.title : resource.display.title.fallback, error: kind === 'card' && !resource.blocks?.length });
      } catch (error) {
        const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
        const unavailable = /NOT_FOUND|FORBIDDEN|UNAUTHORIZED/.test(String(code ?? '') + String(error));
        if (valid()) setState((previous) => ({ binding, ...(!unavailable && previous?.binding === binding ? { blocks: previous.blocks, title: previous.title } : {}), error: true }));
      }
    };
    const offPush = onRemoteResourceChanged((source, payload) => {
      if (source !== deviceId || payload.collectionId !== collectionId) return;
      if (payload.resourceRefs?.length && !payload.resourceRefs.some((ref) => ref.kind === kind && ref.id === id)) return;
      if (!timer) timer = setTimeout(() => { timer = undefined; void load(); }, 200);
    });
    const offTopic = startFocusedTopicSubscription({ deviceId, owner: `${collectionId}:${id}:${subscriberId}`, topic: 'sessions', subscribe, unsubscribe });
    const listener = AppState.addEventListener('change', (next) => { generation += 1; if (next === 'active') void load(); });
    void load();
    return () => { disposed = true; generation += 1; offPush(); offTopic(); listener.remove(); if (timer) clearTimeout(timer); };
  }, [subscriberId, focused, binding, deviceId, sessionId, callId, collectionId, kind, attempt, connectionEpoch, status, invoke, onRemoteResourceChanged, subscribe, unsubscribe]);
  return { title: state?.binding === binding ? state.title : undefined, blocks: state?.binding === binding ? state.blocks : undefined, error: !deviceId || status !== 'online' || (state?.binding === binding && state.error), retry };
}
