import { useChatServerGroup } from '@/chat/useChatServer';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useTranslation } from 'react-i18next';
import type { RemoteActionInvokeResponse, RemoteResource } from '@cindy/device-link';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent } from '@/auth/authOwnerGeneration';
import { useRevokedDevices } from '@/device-link/revokedDevicesStore';
import { clearHistoryDisk, historyDiskAuthority, readConversationDisk, writeConversationDisk } from './remoteHistoryDiskCache';
import { BOT_GROUP_REMOTE_COLLECTION_ID, type BotGroupRemoteActionId, type BotGroupRemoteChatData } from '@cindy/maker-shared/botGroupChat';
import { useAuth } from '@/auth/AuthContext';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { startFocusedTopicSubscription } from '@/device-link/focusedTopicSubscription';
import { getRemoteResource, invokeRemoteResourceAction, type RemoteResourceHostTarget } from '@/device-link/remoteResources';
import { formatRemoteError } from '@/device-link/remoteStatus';
import { useRemoteSyncCoordinator } from '@/device-link/remoteSyncTask';
import { isTransientRemoteError } from '@/device-link/remoteRetry';
import { BOT_GROUP_CLIENT_PRIMITIVES, botGroupChatDataFromResource, botGroupErrorCode, botGroupResourceRef } from './botGroupRemote';

export type BotGroupChatState =
  | { kind: 'loading' }
  | { kind: 'ready'; group: BotGroupRemoteChatData }
  | { kind: 'missing' }
  | { kind: 'error'; message: string };

/** Pushes for one change arrive in bursts (messages, round, plan); read once per burst. */
const PUSH_COALESCE_MS = 150;
const READ_RECOVERY_MS = 30_000;
let cacheOwner = getMobileAuthOwner();
const cachedGroups = new Map<string, BotGroupRemoteChatData>();

/**
 * One group as the computer sees it (docs/product-rules/bot-group-chat.md §8). Every change
 * on the computer broadcasts `maker:remote-resources:changed` for the group; the screen
 * re-reads the whole projection on it, never patches the timeline locally. Actions go
 * through the same resource and are followed by a read.
 */
export function useBotGroupChat(host: RemoteResourceHostTarget, groupId: string, threadRootId?: string) {
  const server = useChatServerGroup(groupId, !host.deviceId, threadRootId);
  const { invoke, openLink, status, connectionEpoch, presenceVersion, getPresenceAvailability, onRemoteResourceChanged, subscribe, unsubscribe } = useDeviceLink();
  const { accountGeneration } = useAuth();
  const revoked = useRevokedDevices().has(host.deviceId);
  if (!isMobileAuthOwnerCurrent(cacheOwner)) { cacheOwner = getMobileAuthOwner(); cachedGroups.clear(); }
  const namespace = `remote-group:${host.deviceId}`;
  const cacheKey = JSON.stringify([host.deviceId, groupId]);
  const { i18n } = useTranslation();
  const identity = JSON.stringify([accountGeneration, host.deviceId, groupId]);
  const identityRef = useRef(identity); identityRef.current = identity;
  const [state, setState] = useState<{ identity: string; value: BotGroupChatState }>(() => ({ identity,
    value: !revoked && cachedGroups.has(cacheKey) ? { kind: 'ready', group: cachedGroups.get(cacheKey)! } : { kind: 'loading' } }));
  // A queued read may fail before React commits the previous successful snapshot.
  const recovery = useRef({ identity, hasGroup: false });
  if (recovery.current.identity !== identity) recovery.current = { identity, hasGroup: false };
  const recoveryControl = useRef<{ identity: string; clear: () => void; schedule: () => void } | null>(null);
  const fresh = useRef(0);
  useEffect(() => {
    if (!host.deviceId || !groupId) return;
    if (revoked) {
      fresh.current++; cachedGroups.delete(cacheKey); void clearHistoryDisk(namespace, groupId);
      setState({ identity, value: { kind: 'missing' } }); return;
    }
    let cancelled = false;
    const revision = fresh.current;
    const authority = historyDiskAuthority(namespace, groupId);
    void readConversationDisk(authority, (value): value is RemoteResource => {
      if (!value || typeof value !== 'object' || !('blocks' in value)) return false;
      return botGroupChatDataFromResource(value as RemoteResource)?.id === groupId;
    }).then(resource => {
      if (!resource || cancelled || !authority.current() || revision !== fresh.current || identityRef.current !== identity) return;
      const group = botGroupChatDataFromResource(resource)!;
      cachedGroups.set(cacheKey, group); recovery.current.hasGroup = true;
      setState({ identity, value: { kind: 'ready', group } });
    });
    return () => { cancelled = true; };
  }, [cacheKey, namespace, groupId, host.deviceId, identity, revoked]);

  const read = useCallback(async (isStale: () => boolean) => {
    const owner = identity;
    const authority = historyDiskAuthority(namespace, groupId);
    const valid = () => !isStale() && identityRef.current === owner && authority.current();
    if (recoveryControl.current?.identity === owner) recoveryControl.current.clear();
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
      fresh.current++; cachedGroups.set(cacheKey, group);
      void writeConversationDisk(authority, resource);
      recovery.current.hasGroup = true;
      setState({ identity: owner, value: { kind: 'ready', group } });
    } catch (error) {
      if (!valid()) return;
      if (['NOT_FOUND', 'PERMISSION_DENIED'].includes(botGroupErrorCode(error) ?? '')) {
        fresh.current++; cachedGroups.delete(cacheKey); void clearHistoryDisk(namespace, groupId);
        recovery.current.hasGroup = false;
        setState({ identity: owner, value: { kind: 'missing' } });
        return;
      }
      // Keep a conversation that is already on screen; only a first read fails loudly.
      setState((previous) => previous.identity === owner && previous.value.kind === 'ready'
        ? previous
        : { identity: owner, value: { kind: 'error', message: formatRemoteError(error) } });
      const code = botGroupErrorCode(error);
      if (recovery.current.hasGroup && (isTransientRemoteError(error)
        || code === 'SERVICE_ERROR' || code === 'CHAT_UNAVAILABLE' || code === 'HOST_NOT_READY')
        && recoveryControl.current?.identity === owner) recoveryControl.current.schedule();
    }
  }, [cacheKey, namespace, groupId, host, i18n.language, identity, invoke, openLink]);

  const request = useRemoteSyncCoordinator((run) => read(run.isStale), identity);
  const reload = useCallback(() => { void request({ reason: 'changed' }); }, [request]);

  useFocusEffect(useCallback(() => {
    if (!host.deviceId || !groupId || status !== 'online') return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const control = {
      identity,
      clear: () => { clearTimeout(retryTimer); retryTimer = undefined; },
      schedule: () => {
        control.clear();
        if (AppState.currentState !== 'active') return;
        retryTimer = setTimeout(() => {
          retryTimer = undefined;
          if (identityRef.current === identity && AppState.currentState === 'active') reload();
        }, READ_RECOVERY_MS);
      },
    };
    recoveryControl.current = control;
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
    const appState = AppState.addEventListener('change', (value) => {
      control.clear();
      if (value === 'active') reload();
    });
    if (AppState.currentState === 'active') reload();
    return () => {
      offPush(); offTopic(); appState.remove(); if (timer) clearTimeout(timer); control.clear();
      if (recoveryControl.current === control) recoveryControl.current = null;
    };
  }, [connectionEpoch, groupId, host.deviceId, identity, onRemoteResourceChanged, reload, status, subscribe, unsubscribe]));

  /** Run a group action; rejects with the host's error (see `botGroupErrorCode`). */
  const act = useCallback(async (actionId: BotGroupRemoteActionId, input?: Record<string, unknown>): Promise<RemoteActionInvokeResponse> => {
    try {
      await openLink(host.deviceId);
      if (identityRef.current !== identity) throw new Error('OWNER_CHANGED');
      const receipt = await invokeRemoteResourceAction(<T,>(deviceId: string, channel: string, args?: unknown[]) =>
        invoke<T>(deviceId, channel, args, { preSend: () => { if (identityRef.current !== identity) throw new Error('OWNER_CHANGED'); } }), host, {
        collectionId: BOT_GROUP_REMOTE_COLLECTION_ID,
        actionId,
        resourceRef: botGroupResourceRef(groupId),
        ...(input ? { input } : {}),
      }, i18n.language);
      if (actionId === 'hide' && identityRef.current === identity) {
        await server.acceptListState((receipt.result as { listState?: unknown } | undefined)?.listState);
      }
      if (['hide', 'delete', 'leave'].includes(actionId) && identityRef.current === identity) {
        fresh.current++; cachedGroups.delete(cacheKey); void clearHistoryDisk(namespace, groupId);
        setState({ identity, value: { kind: 'missing' } });
      }
      return receipt;
    } finally {
      // A refused action usually means the phone's copy is stale (PLAN_CLOSED, PLAN_OPEN): re-read either way.
      // A deleted group is left by the screen instead.
      if (actionId !== 'delete' && actionId !== 'read' && actionId !== 'mask' && actionId !== 'mask-mentions' && identityRef.current === identity) reload();
    }
  }, [cacheKey, namespace, groupId, host, i18n.language, identity, invoke, openLink, reload, server.acceptListState]);

  const value: BotGroupChatState = !host.deviceId || !groupId || server.isListHidden() || revoked
    ? { kind: 'missing' }
    : state.identity === identity ? state.value : { kind: 'loading' };
  const markRead = useCallback(async (messageIds: string[]) => {
    if (state.identity !== identity || state.value.kind !== 'ready' || !state.value.group.supportsReadReceipts) return;
    const seen = new Set(messageIds);
    const message = state.value.group.messages.filter(message => seen.has(message.id) && !message.threadRootId)
      .reduce<(typeof state.value.group.messages)[number] | undefined>((last, row) => !last || row.sequence > last.sequence ? row : last, undefined);
    if (message) await act('read', { messageId: message.id }).catch(() => undefined);
  }, [state, identity, act]);
  void presenceVersion;
  // Unknown presence still allows actions; the host answers or the link reports offline.
  const online = status === 'online' && !!host.deviceId && getPresenceAvailability(host.deviceId) !== false;
  return !host.deviceId ? { ...server, server: true } : { state: value, reload, act, online, server: false, listHidden: server.listHidden, loadOlder: undefined, loadingOlder: false, media: undefined, markRead,
    uploadAttachment: undefined, pending: [], pendingAction: undefined, canQueue: false, threadMeta: undefined, followThread: undefined, shareToMain: undefined, react: undefined };
}
