import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useIsFocused } from 'expo-router';
import { AppState } from 'react-native';
import type { RemoteResourceBlock } from '@cindy/device-link';
import { parseMailCard } from '@cindy/maker-shared/ghost-card-form';
import { useAuth } from '@/auth/AuthContext';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { getRemoteResource } from '@/device-link/remoteResources';
import { startFocusedTopicSubscription } from '@/device-link/focusedTopicSubscription';

/** Card content and Host-projected actions are scoped to account + device + task.
 * Refresh after foreground/reconnect and host invalidation; stale replies cannot
 * replace a recycled row or another account's card. */
export function usePluginResultCard(deviceId: string | undefined, sessionId: string, callId: string, followMailReplacement = false) {
  const resource = useSessionPluginResource(deviceId, sessionId, callId, 'plugin-results', 'card', followMailReplacement);
  const hidden = resource.blocks?.some(block => block.primitive === 'plugin-card-actions' &&
    !!parseMailCard((block.data as { mail?: unknown } | undefined)?.mail)?.supersededBy) ?? false;
  return { ...resource, hidden };
}

export function useSessionPluginResource(deviceId: string | undefined, sessionId: string, callId: string, collectionId: string, kind: string, followMailReplacement = false) {
  const { invoke, connectionEpoch, status, onRemoteResourceChanged, subscribe, unsubscribe } = useDeviceLink(deviceId);
  const { accountGeneration } = useAuth();
  const focused = useIsFocused();
  const subscriberId = useId();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ binding: string; callId?: string; blocks?: RemoteResourceBlock[]; title?: string; error?: boolean }>();
  const binding = JSON.stringify([accountGeneration, deviceId, sessionId, callId, collectionId, kind, followMailReplacement]);
  const current = useRef(binding); current.current = binding;
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  useEffect(() => {
    if (!deviceId || !focused || status !== 'online') return;
    let disposed = false;
    let generation = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const id = JSON.stringify([sessionId, callId]);
    let resolvedId = id;
    const load = async () => {
      if (AppState.currentState !== 'active') return;
      const expected = ++generation;
      const valid = () => !disposed && current.current === binding && generation === expected && AppState.currentState === 'active';
      try {
        const read = (next: string) => getRemoteResource(invoke, { deviceId, deviceName: deviceId }, { collectionId, kind, id: JSON.stringify([sessionId, next]) }, undefined, collectionId === 'plugin-results' ? ['plugin-card-actions', 'plugin-card-forms', 'plugin-card-rich'] : []);
        let next = callId, resource = await read(next);
        if (followMailReplacement) {
          const identity = (blocks: RemoteResourceBlock[] | undefined) => {
            const data = blocks?.find(block => block.primitive === 'plugin-card-actions')?.data as { pluginId?: unknown; mail?: unknown } | undefined;
            const mail = parseMailCard(data?.mail);
            return mail && typeof data?.pluginId === 'string' && data.pluginId ? { pluginId: data.pluginId, mail } : undefined;
          };
          const first = identity(resource.blocks), visited = new Set([next]);
          let card = first;
          while (card?.mail.supersededBy) {
            if (!valid()) return;
            next = card.mail.supersededBy;
            if (visited.has(next) || visited.size >= 32) throw new Error('NOT_FOUND: Mail replacement unavailable');
            visited.add(next);
            resource = await read(next);
            card = identity(resource.blocks);
            // Host verifies task ownership on every resource read; additionally
            // reject a replacement belonging to another installation or draft.
            if (!card || card.pluginId !== first!.pluginId || card.mail.accountId !== first!.mail.accountId || card.mail.draftId !== first!.mail.draftId)
              throw new Error('NOT_FOUND: Mail replacement unavailable');
          }
        }
        if (valid()) {
          resolvedId = JSON.stringify([sessionId, next]);
          setState({ binding, callId: next, blocks: resource.blocks ?? [], title: typeof resource.display.title === 'string' ? resource.display.title : resource.display.title.fallback, error: kind === 'card' && !resource.blocks?.length });
        }
      } catch (error) {
        const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
        const unavailable = /NOT_FOUND|FORBIDDEN|UNAUTHORIZED/.test(String(code ?? '') + String(error));
        if (valid()) setState((previous) => ({ binding, ...(!unavailable && previous?.binding === binding ? { callId: previous.callId, blocks: previous.blocks, title: previous.title } : {}), error: true }));
      }
    };
    const offPush = onRemoteResourceChanged((source, payload) => {
      if (source !== deviceId || payload.collectionId !== collectionId) return;
      if (payload.resourceRefs?.length && !payload.resourceRefs.some((ref) => ref.kind === kind && (ref.id === id || ref.id === resolvedId))) return;
      if (!timer) timer = setTimeout(() => { timer = undefined; void load(); }, 200);
    });
    const offTopic = startFocusedTopicSubscription({ deviceId, owner: `${collectionId}:${id}:${subscriberId}`, topic: 'sessions', subscribe, unsubscribe });
    const listener = AppState.addEventListener('change', (next) => { generation += 1; if (next === 'active') void load(); });
    void load();
    return () => { disposed = true; generation += 1; offPush(); offTopic(); listener.remove(); if (timer) clearTimeout(timer); };
  }, [subscriberId, focused, binding, deviceId, sessionId, callId, collectionId, kind, followMailReplacement, attempt, connectionEpoch, status, invoke, onRemoteResourceChanged, subscribe, unsubscribe]);
  return { callId: state?.binding === binding ? state.callId : undefined, title: state?.binding === binding ? state.title : undefined, blocks: state?.binding === binding ? state.blocks : undefined, error: !deviceId || status !== 'online' || (state?.binding === binding && state.error), retry };
}
