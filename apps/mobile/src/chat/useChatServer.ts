import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from 'expo-router';
import type { RemoteActionInvokeResponse } from '@cindy/device-link';
import type { BotGroupAttachment, BotGroupRemoteActionId } from '@cindy/maker-shared/botGroupChat';
import { useAuth } from '@/auth/AuthContext';
import { getActiveMobileSessionRealm, getMobileEndpointForRealm, loadMobileEndpointsForRealm } from '@/config/env';
import { markRemoteResourceRead } from '@/device-link/remoteResourceCache';
import { useRemoteSyncCoordinator } from '@/device-link/remoteSyncTask';
import type { BotGroupChatState } from '@/session/useBotGroupChat';
import { chatAccessLost, chatCursor, chatGroupView, chatHttpsUrl, chatRoomRow, chatReadAt, chatReadSequence, chatLastReplyAt, chatLastReplySequence, createChatServerClient, type ChatPage, type ChatRequest, type ChatSnapshot } from './chatServerClient';
import { subscribeChatServer } from './chatServerSubscription';

function useChatClient() {
  const auth = useAuth();
  const owner = `${auth.user?.id ?? ''}:${auth.accountGeneration}:${getActiveMobileSessionRealm()}`;
  const active = useRef(owner); active.current = owner;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const deps = useRef(auth); deps.current = auth;
  return useMemo(() => {
    const realm = getActiveMobileSessionRealm();
    const current = () => mounted.current && active.current === owner && getActiveMobileSessionRealm() === realm;
    const check = () => { if (!current()) throw new Error('OWNER_CHANGED'); };
    const baseUrl = () => {
      try { return chatHttpsUrl(getMobileEndpointForRealm(realm, 'chatApiBaseUrl')).replace(/\/$/, ''); }
      catch { throw new Error('CHAT_ENDPOINT_UNAVAILABLE'); }
    };
    let discovering: Promise<string> | undefined;
    const endpoint = async () => {
      check();
      try { return baseUrl(); } catch { /* An older snapshot may predate the chat endpoint. */ }
      discovering ??= loadMobileEndpointsForRealm(realm, { refresh: true })
        .then(() => { check(); return baseUrl(); })
        .catch(() => { check(); throw new Error('CHAT_ENDPOINT_UNAVAILABLE'); })
        .finally(() => { discovering = undefined; });
      return discovering;
    };
    const request: ChatRequest = async <T,>(path: string, method: 'GET' | 'POST' = 'GET', body?: unknown) => {
      check();
      const url = await endpoint(); check();
      const result = await deps.current.apiFetch<T>(`/v1${path}`, { baseUrl: url, method, cache: 'no-store', ...(body !== undefined ? { body } : {}), assertCurrent: check });
      check(); return result;
    };
    const client = createChatServerClient(request);
    return { owner, userId: auth.user?.id ?? '', current, baseUrl, endpoint, request, client,
      token: async () => { check(); await client.me(); const token = await deps.current.getAccessToken(); check(); return token; }, enabled: !!auth.user };
  }, [owner, !!auth.user]);
}

/** Direct server roster, independent of device discovery and presence. */
export function useChatServerRoster(enabled: boolean) {
  const api = useChatClient();
  const known = useRef({ owner: api.owner, ids: new Set<string>() });
  if (known.current.owner !== api.owner) known.current = { owner: api.owner, ids: new Set() };
  const snapshots = useRef(new Map<string, { owner: string; head: string | undefined; value: ChatSnapshot }>());
  const [state, setState] = useState({ owner: api.owner, rooms: [] as ReturnType<typeof chatRoomRow>[], loading: true, refreshing: false, error: null as string | null });
  const read = useRemoteSyncCoordinator(async run => {
    if (!api.enabled || !enabled) return;
    setState(old => ({ ...old, refreshing: run.reasons.includes('visible') }));
    try {
      const [rooms, self] = await Promise.all([api.client.list(), api.client.me()]);
      const rows: ReturnType<typeof chatRoomRow>[] = [];
      const fresh = new Map<string, { owner: string; head: string | undefined; value: ChatSnapshot }>();
      let partial = false;
      // List provides room heads, so unchanged rooms need no history download on polling.
      for (let offset = 0; offset < rooms.length; offset += 4) {
        await Promise.all(rooms.slice(offset, offset + 4).map(async room => {
          try {
            const cached = snapshots.current.get(room.id);
            const value = cached?.owner === api.owner && room.head !== undefined && cached.head === room.head
              && !run.reasons.some(reason => ['changed', 'connected', 'visible'].includes(reason))
              ? cached.value : await api.client.snapshot(room.id);
            fresh.set(room.id, { owner: api.owner, head: room.head, value });
            rows.push(chatRoomRow(room, value, self));
          } catch (error) {
            if (!chatAccessLost(error)) { partial = true; rows.push(chatRoomRow(room)); }
          }
        }));
        if (run.isStale() || !api.current()) return;
      }
      if (!run.isStale() && api.current()) {
        // Reuse the existing account-scoped local read mirror, without persisting messages
        // or making a server read-state mutation just because the roster was fetched.
        for (const [id, snapshot] of fresh) {
          if (run.isStale() || !api.current()) return;
          await markRemoteResourceRead(api.userId, '', id, chatReadAt(snapshot.value, self), chatReadSequence(snapshot.value));
        }
        if (run.isStale() || !api.current()) return;
        snapshots.current = fresh;
        for (const room of rooms) known.current.ids.add(room.id);
        setState({ owner: api.owner, rooms: rows, loading: false, refreshing: false, error: partial ? 'CHAT_LIST_FAILED' : null });
      }
    } catch (error) {
      if (!run.isStale() && api.current()) setState(old => ({ owner: api.owner, rooms: old.owner === api.owner && !chatAccessLost(error) ? old.rooms : [], loading: false, refreshing: false, error: error instanceof Error && error.message === 'CHAT_ENDPOINT_UNAVAILABLE' ? error.message : 'CHAT_LIST_FAILED' }));
    }
  }, api.owner);
  const refresh = useCallback(() => read({ reason: 'visible' }), [read]);
  useFocusEffect(useCallback(() => {
    if (!enabled || !api.enabled) return;
    let stop: (() => void) | undefined;
    let subscribed = false;
    let poll: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      stop?.(); subscribed = false; clearInterval(poll);
      if (AppState.currentState !== 'active') return;
      void read({ reason: 'focus' });
      // Actor events cover membership; room heads also catch messages and renames without
      // subscribing every group (the service limits each socket to 16 scopes).
      poll = setInterval(() => { if (!subscribed) start(); else void read({ reason: 'poll' }); }, 30000);
      let cancelled = false;
      let disposeSocket: (() => void) | undefined;
      stop = () => { cancelled = true; disposeSocket?.(); };
      void api.endpoint().then(baseUrl => {
        if (cancelled || !api.current()) return;
        disposeSocket = subscribeChatServer({ baseUrl, token: api.token, current: api.current, socket: url => new WebSocket(url),
        ready: async actorId => {
          let cursor: string;
          try { cursor = chatCursor((await api.request<{ head: string }>(`/changes?scope=actor:${actorId}&after=0&limit=1`)).head); }
          catch (error) {
            if ((error as { code?: string }).code !== 'RESET_REQUIRED') throw error;
            cursor = '0'; // The socket returns the reset head without changing shared API errors.
          }
          await read({ reason: 'connected' });
          return { scope: `actor:${actorId}`, cursor };
        }, changed: () => { void read({ reason: 'changed' }); }, available: () => { subscribed = true; }, unavailable: () => { subscribed = false; } });
      }).catch(() => {}); // HTTP read presents endpoint errors.
    };
    start();
    const foreground = AppState.addEventListener('change', value => { if (value === 'active') start(); else { stop?.(); clearInterval(poll); } });
    return () => { stop?.(); clearInterval(poll); foreground.remove(); };
  }, [api, enabled, read]));
  const own = state.owner === api.owner;
  return { items: own ? state.rooms : [], serverIds: known.current.ids, loading: api.enabled && (!own || state.loading),
    refreshing: own && state.refreshing, error: own ? state.error : null, refresh };
}

/** Reads and sends use the account's Chat Server identity, never its computer identity. */
export function useChatServerGroup(groupId: string, enabled: boolean) {
  const api = useChatClient();
  const identity = `${api.owner}:${groupId}`;
  const active = useRef(identity); active.current = identity;
  const [state, setState] = useState<{ identity: string; value: BotGroupChatState; online: boolean; loadingOlder: boolean }>({ identity, value: { kind: 'loading' }, online: true, loadingOlder: false });
  const page = useRef<{ identity: string; page: ChatPage; self: string } | null>(null);
  const accessGeneration = useRef(0);
  const freshRead = useRef(false);
  const olderPending = useRef(false);
  const valid = () => api.current() && active.current === identity;
  const loseAccess = () => {
    accessGeneration.current++; freshRead.current = false; page.current = null;
    setState({ identity, value: { kind: 'missing' }, online: false, loadingOlder: false });
  };
  const request = useRemoteSyncCoordinator(async run => {
    if (!enabled || !api.enabled) return;
    const generation = accessGeneration.current;
    freshRead.current = false;
    try {
      const previous = page.current?.identity === identity ? page.current.page : null;
      const oldest = previous?.messages.reduce<string | undefined>((oldest, message) => !oldest || BigInt(message.seq) < BigInt(oldest) ? message.seq : oldest, undefined);
      const [next, self] = await Promise.all([api.client.load(groupId, oldest), api.client.me()]);
      if (run.isStale() || !valid() || generation !== accessGeneration.current) return;
      // Replace the reauthorized window; no stale history survives changed access.
      freshRead.current = true;
      page.current = { identity, page: next, self };
      setState({ identity, value: { kind: 'ready', group: chatGroupView(next, self) }, online: true, loadingOlder: false });
    } catch (error) {
      if (run.isStale() || !valid() || generation !== accessGeneration.current) return;
      if (chatAccessLost(error)) loseAccess();
      else setState(old => ({ identity, value: old.identity === identity && old.value.kind === 'ready' ? old.value : { kind: 'error', message: error instanceof Error && error.message === 'CHAT_ENDPOINT_UNAVAILABLE' ? error.message : 'CHAT_READ_FAILED' }, online: false, loadingOlder: false }));
    }
  }, identity);
  const reload = useCallback(() => { void request({ reason: 'changed' }); }, [request]);
  useFocusEffect(useCallback(() => {
    if (!enabled || !api.enabled || !groupId) return;
    let stop: (() => void) | undefined;
    let subscribed = false;
    let recovery: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      stop?.(); subscribed = false; clearInterval(recovery);
      if (AppState.currentState !== 'active') return;
      reload();
      // A failed read after an acknowledged event must recover even without another event.
      recovery = setInterval(() => { if (!subscribed) start(); else if (!freshRead.current) reload(); }, 30000);
      let cancelled = false;
      let disposeSocket: (() => void) | undefined;
      stop = () => { cancelled = true; disposeSocket?.(); };
      void api.endpoint().then(baseUrl => {
        if (cancelled || !api.current() || active.current !== identity) return;
        disposeSocket = subscribeChatServer({ baseUrl, token: api.token, current: () => api.current() && active.current === identity,
        socket: url => new WebSocket(url), ready: async () => {
          await request({ reason: 'connected' });
          const latest = page.current;
          if (!freshRead.current || !latest || latest.identity !== identity) throw new Error('CHAT_READ_FAILED');
          return { scope: `conversation:${groupId}`, cursor: latest.page.snapshot.cursor };
        }, changed: reload, available: () => { subscribed = true; }, unavailable: () => { subscribed = false; freshRead.current = false; } });
      }).catch(() => {}); // Read presents endpoint errors.
    };
    start();
    const foreground = AppState.addEventListener('change', value => { if (value === 'active') start(); else { stop?.(); clearInterval(recovery); } });
    return () => { stop?.(); clearInterval(recovery); foreground.remove(); };
  }, [api, enabled, groupId, identity, reload, request]));
  const loadOlder = async () => {
    const previous = page.current;
    if (!previous || previous.identity !== identity || olderPending.current) return;
    olderPending.current = true;
    setState(old => ({ ...old, loadingOlder: true }));
    try {
      const next = await api.client.older(groupId, previous.page);
      if (!valid() || page.current !== previous) return;
      page.current = { ...previous, page: next };
      setState({ identity, value: { kind: 'ready', group: chatGroupView(next, previous.self) }, online: true, loadingOlder: false });
    } catch (error) {
      if (valid() && page.current === previous && chatAccessLost(error)) loseAccess();
      throw error;
    } finally { olderPending.current = false; if (valid()) setState(old => ({ ...old, loadingOlder: false })); }
  };
  const act = async (action: BotGroupRemoteActionId, input?: Record<string, unknown>): Promise<RemoteActionInvokeResponse> => {
    if (action !== 'send' || !input || input.division || (Array.isArray(input.attachments) && input.attachments.length)) throw new Error('UNSUPPORTED_CHAT_ACTION');
    const latest = page.current;
    if (!latest || latest.identity !== identity) throw new Error('CHAT_READ_FAILED');
    try {
      const mentions = input.mentions as { all: boolean; botIds: string[] };
      const recipients = mentions.all
        ? (await api.client.members(groupId)).filter(member => member.state === 'joined').map(member => member.id)
        : mentions.botIds;
      if (!valid() || page.current?.identity !== identity) throw new Error('OWNER_CHANGED');
      await api.client.send(groupId, { clientId: String(input.clientId), text: String(input.text),
        mentions: { all: false, botIds: recipients.filter(id => id !== latest.self) } });
      if (valid()) reload();
      return { effects: [] };
    } catch (error) {
      if (valid()) {
        freshRead.current = false;
        if (chatAccessLost(error)) loseAccess();
        else setState(old => ({ ...old, online: false }));
      }
      throw error;
    }
  };
  const media = async (mediaId: string): Promise<BotGroupAttachment> => {
    const generation = accessGeneration.current;
    try {
      const attachment = await api.client.media(groupId, mediaId);
      if (!valid() || generation !== accessGeneration.current) throw new Error('OWNER_CHANGED');
      return attachment;
    } catch (error) {
      // A missing/deleted attachment is distinct from losing the room's membership.
      if (valid() && generation === accessGeneration.current && chatAccessLost(error)
        && (error as { code?: string }).code !== 'MEDIA_NOT_FOUND') loseAccess();
      throw error;
    }
  };
  const markRead = useCallback(async (messageIds: readonly string[]) => {
    const latest = page.current;
    if (!api.current() || active.current !== identity || !latest || latest.identity !== identity) return;
    // Only the measured UI's messages are acknowledged, even if a newer read is settling.
    const seen = new Set(messageIds);
    const messages = latest.page.messages.filter(message => seen.has(message.id));
    await markRemoteResourceRead(api.userId, '', groupId, chatLastReplyAt(messages, latest.self), chatLastReplySequence(messages, latest.self));
  }, [api, groupId, identity]);
  return { state: state.identity === identity ? state.value : { kind: 'loading' } as BotGroupChatState,
    online: state.identity === identity && state.online, reload, act, loadOlder, loadingOlder: state.loadingOlder, media, markRead };
}
