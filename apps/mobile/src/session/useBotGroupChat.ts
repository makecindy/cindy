import { useCallback, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useTranslation } from 'react-i18next';
import type { RemoteActionInvokeResponse } from '@cindy/device-link';
import { BOT_GROUP_REMOTE_COLLECTION_ID, type BotGroupRemoteActionId, type BotGroupRemoteChatData } from '@cindy/maker-shared/botGroupChat';
import { useAuth } from '@/auth/AuthContext';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { startFocusedTopicSubscription } from '@/device-link/focusedTopicSubscription';
import { getRemoteResource, invokeRemoteResourceAction, type RemoteResourceHostTarget } from '@/device-link/remoteResources';
import { formatRemoteError } from '@/device-link/remoteStatus';
import { useRemoteSyncCoordinator } from '@/device-link/remoteSyncTask';
import { BOT_GROUP_CLIENT_PRIMITIVES, botGroupChatDataFromResource, botGroupErrorCode, botGroupResourceRef } from './botGroupRemote';

export type BotGroupChatState =
  | { kind: 'loading' }
  | { kind: 'ready'; group: BotGroupRemoteChatData }
  | { kind: 'missing' }
  | { kind: 'error'; message: string };

/** Pushes for one change arrive in bursts (messages, round, plan); read once per burst. */
const PUSH_COALESCE_MS = 150;

/**
 * One group as the computer sees it (docs/product-rules/bot-group-chat.md §8). Every change
 * on the computer broadcasts `maker:remote-resources:changed` for the group; the screen
 * re-reads the whole projection on it, never patches the timeline locally. Actions go
 * through the same resource and are followed by a read.
 */
export function useBotGroupChat(host: RemoteResourceHostTarget, groupId: string) {
  const { invoke, openLink, status, connectionEpoch, presenceVersion, getPresenceAvailability, onRemoteResourceChanged, subscribe, unsubscribe } = useDeviceLink();
  const { accountGeneration } = useAuth();
  const { i18n } = useTranslation();
  const identity = JSON.stringify([accountGeneration, host.deviceId, groupId]);
  const identityRef = useRef(identity); identityRef.current = identity;
  const [state, setState] = useState<{ identity: string; value: BotGroupChatState }>({ identity, value: { kind: 'loading' } });

  const read = useCallback(async (isStale: () => boolean) => {
    const owner = identity;
    const valid = () => !isStale() && identityRef.current === owner;
    if (!host.deviceId || !groupId) {
      setState({ identity: owner, value: { kind: 'missing' } });
      return;
    }
    try {
      await openLink(host.deviceId);
      const resource = await getRemoteResource(invoke, host, botGroupResourceRef(groupId), i18n.language, BOT_GROUP_CLIENT_PRIMITIVES);
      if (!valid()) return;
      const group = botGroupChatDataFromResource(resource);
      if (!group || group.id !== groupId) throw new Error('INVALID_GROUP_DATA');
      setState({ identity: owner, value: { kind: 'ready', group } });
    } catch (error) {
      if (!valid()) return;
      if (botGroupErrorCode(error) === 'NOT_FOUND') {
        setState({ identity: owner, value: { kind: 'missing' } });
        return;
      }
      // Keep a conversation that is already on screen; only a first read fails loudly.
      setState((previous) => previous.identity === owner && previous.value.kind === 'ready'
        ? previous
        : { identity: owner, value: { kind: 'error', message: formatRemoteError(error) } });
    }
  }, [groupId, host, i18n.language, identity, invoke, openLink]);

  const request = useRemoteSyncCoordinator((run) => read(run.isStale), identity);
  const reload = useCallback(() => { void request({ reason: 'changed' }); }, [request]);

  useFocusEffect(useCallback(() => {
    if (!host.deviceId || !groupId || status !== 'online') return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (timer) return;
      timer = setTimeout(() => { timer = undefined; if (AppState.currentState === 'active') reload(); }, PUSH_COALESCE_MS);
    };
    const offPush = onRemoteResourceChanged((source, payload) => {
      if (source !== host.deviceId || payload.collectionId !== BOT_GROUP_REMOTE_COLLECTION_ID) return;
      if (payload.resourceRefs?.length && !payload.resourceRefs.some((ref) => ref.id === groupId)) return;
      schedule();
    });
    // The change push rides the account-level `sessions` topic.
    const offTopic = startFocusedTopicSubscription({ deviceId: host.deviceId, owner: `bot-group:${groupId}`, topic: 'sessions', subscribe, unsubscribe });
    const appState = AppState.addEventListener('change', (value) => { if (value === 'active') reload(); });
    reload();
    return () => { offPush(); offTopic(); appState.remove(); if (timer) clearTimeout(timer); };
  }, [connectionEpoch, groupId, host.deviceId, onRemoteResourceChanged, reload, status, subscribe, unsubscribe]));

  /** Run a group action; rejects with the host's error (see `botGroupErrorCode`). */
  const act = useCallback(async (actionId: BotGroupRemoteActionId, input?: Record<string, unknown>): Promise<RemoteActionInvokeResponse> => {
    try {
      await openLink(host.deviceId);
      return await invokeRemoteResourceAction(invoke, host, {
        collectionId: BOT_GROUP_REMOTE_COLLECTION_ID,
        actionId,
        resourceRef: botGroupResourceRef(groupId),
        ...(input ? { input } : {}),
      }, i18n.language);
    } finally {
      // A refused action usually means the phone's copy is stale (PLAN_CLOSED, PLAN_OPEN): re-read either way.
      // A deleted group is left by the screen instead.
      if (actionId !== 'delete' && identityRef.current === identity) reload();
    }
  }, [groupId, host, i18n.language, identity, invoke, openLink, reload]);

  const value: BotGroupChatState = !host.deviceId || !groupId
    ? { kind: 'missing' }
    : state.identity === identity ? state.value : { kind: 'loading' };
  void presenceVersion;
  // Unknown presence still allows actions; the host answers or the link reports offline.
  const online = status === 'online' && !!host.deviceId && getPresenceAvailability(host.deviceId) !== false;
  return { state: value, reload, act, online };
}
