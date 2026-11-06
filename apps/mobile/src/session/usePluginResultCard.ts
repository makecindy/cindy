import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useIsFocused } from 'expo-router';
import { AppState } from 'react-native';
import type { RemoteResourceBlock } from '@cindy/device-link';
import { parseMailCard } from '@cindy/maker-shared/ghost-card-form';
import { useAuth } from '@/auth/AuthContext';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { getRemoteResource } from '@/device-link/remoteResources';
import { startFocusedTopicSubscription } from '@/device-link/focusedTopicSubscription';

/** A link to a GitHub pull request: its state can change without the card being saved. The Host adds `prState` only
 * once a status lookup has worked, so the link itself must start the refresh, or a first failed lookup is never retried. */
const GITHUB_PR_URL = /^https:\/\/(?:www\.)?github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+(?:[/?#]|$)/;

/** How often a visible card that shows a PR's live status is read again. The Host only pushes when the card is
 * saved, but the PR's checks and merge state change on GitHub without it. Matches the Host's status cache TTL. */
const PR_STATUS_REFRESH_MS = 60_000;

/** Card content and Host-projected actions are scoped to account + device + task.
 * Refresh after foreground/reconnect and host invalidation; stale replies cannot
 * replace a recycled row or another account's card. */
export function usePluginResultCard(deviceId: string | undefined, sessionId: string, callId: string, followMailReplacement = false) {
  const resource = useSessionPluginResource(deviceId, sessionId, callId, 'plugin-results', 'card', followMailReplacement);
  // A card the plugin moved to a newer call (or a replaced mail view) is shown only at its new place.
  const hidden = resource.blocks?.some(block => block.primitive === 'plugin-card-actions' &&
    (typeof (block.data as { supersededBy?: unknown } | undefined)?.supersededBy === 'string' ||
      !!parseMailCard((block.data as { mail?: unknown } | undefined)?.mail)?.supersededBy)) ?? false;
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
    let statusTimer: ReturnType<typeof setTimeout> | undefined;
    let pollsPrStatus = false;
    const id = JSON.stringify([sessionId, callId]);
    let resolvedId = id;
    const scheduleStatusRefresh = () => {
      if (statusTimer) clearTimeout(statusTimer);
      statusTimer = pollsPrStatus && !disposed && AppState.currentState === 'active' ? setTimeout(() => { statusTimer = undefined; void loadAndSchedule(); }, PR_STATUS_REFRESH_MS) : undefined;
    };
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
          // Live PR state arrives either as a status slot or only on a PR link's `prState` (the title icon).
          // A card the plugin moved is hidden, so nobody sees its status: stop refreshing it.
          pollsPrStatus = !!resource.blocks?.some(block => {
            if (block.primitive !== 'plugin-card-actions') return false;
            const data = block.data as { prStatus?: unknown; items?: unknown; supersededBy?: unknown } | undefined;
            if (typeof data?.supersededBy === 'string') return false;
            return (Array.isArray(data?.prStatus) && data.prStatus.length > 0) ||
              (Array.isArray(data?.items) && data.items.some(item => !!item && typeof item === 'object' &&
                ('prState' in item || (typeof (item as { url?: unknown }).url === 'string' && GITHUB_PR_URL.test((item as { url: string }).url)))));
          });
        }
      } catch (error) {
        const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
        const unavailable = /NOT_FOUND|FORBIDDEN|UNAUTHORIZED/.test(String(code ?? '') + String(error));
        // A card gone for good stops the refresh; a transient failure keeps it going so the next minute retries.
        if (unavailable && valid()) pollsPrStatus = false;
        if (valid()) setState((previous) => ({ binding, ...(!unavailable && previous?.binding === binding ? { callId: previous.callId, blocks: previous.blocks, title: previous.title } : {}), error: true }));
      }
    };
    // A read that a newer one overtook must not touch the refresh timer: the newer read schedules its own.
    const loadAndSchedule = async () => { const before = generation; await load(); if (generation === before + 1) scheduleStatusRefresh(); };
    const offPush = onRemoteResourceChanged((source, payload) => {
      if (source !== deviceId || payload.collectionId !== collectionId) return;
      if (payload.resourceRefs?.length && !payload.resourceRefs.some((ref) => ref.kind === kind && (ref.id === id || ref.id === resolvedId))) return;
      if (!timer) timer = setTimeout(() => { timer = undefined; void loadAndSchedule(); }, 200);
    });
    const offTopic = startFocusedTopicSubscription({ deviceId, owner: `${collectionId}:${id}:${subscriberId}`, topic: 'sessions', subscribe, unsubscribe });
    const listener = AppState.addEventListener('change', (next) => { generation += 1; if (next === 'active') void loadAndSchedule(); });
    void loadAndSchedule();
    return () => { disposed = true; generation += 1; offPush(); offTopic(); listener.remove(); if (timer) clearTimeout(timer); if (statusTimer) clearTimeout(statusTimer); };
  }, [subscriberId, focused, binding, deviceId, sessionId, callId, collectionId, kind, followMailReplacement, attempt, connectionEpoch, status, invoke, onRemoteResourceChanged, subscribe, unsubscribe]);
  return { callId: state?.binding === binding ? state.callId : undefined, title: state?.binding === binding ? state.title : undefined, blocks: state?.binding === binding ? state.blocks : undefined, error: !deviceId || status !== 'online' || (state?.binding === binding && state.error), retry };
}
