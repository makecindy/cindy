import { createConversationListState } from '@cindy/maker-shared/chatConversationList';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from 'expo-router';
import type { RemoteActionInvokeResponse } from '@cindy/device-link';
import type { BotGroupAttachment, BotGroupRemoteActionId } from '@cindy/maker-shared/botGroupChat';
import { useAuth } from '@/auth/AuthContext';
import { getActiveMobileSessionRealm, getMobileEndpointForRealm, loadMobileEndpointsForRealm } from '@/config/env';
import { cacheChatRoster, forgetRemoteResource, hideCachedChatRooms, markRemoteResourceRead, readCachedChatRoster } from '@/device-link/remoteResourceCache';
import { useRemoteSyncCoordinator } from '@/device-link/remoteSyncTask';
import type { BotGroupChatState } from '@/session/useBotGroupChat';
import { chatAccessLost, chatCursor, chatGroupView, chatHttpsUrl, chatRoomRow, chatReadAt, chatReadSequence, chatLastReplyAt, chatLastReplySequence, createChatServerClient, type ChatActor, type ChatPage, type ChatRequest, type ChatSnapshot } from './chatServerClient';
import { subscribeChatServer } from './chatServerSubscription';

// Shared only within the current authenticated account generation and realm.
let listOwner = '';
let accountList = createConversationListState();
function listFor(owner: string) {
  if (listOwner !== owner) { listOwner = owner; accountList = createConversationListState(); }
  return accountList;
}

/** The account's Chat Server client, fenced to the current account, realm and mount. */
export function useChatClient() {
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
    const request: ChatRequest = async <T,>(path: string, method: 'GET' | 'POST' | 'PATCH' = 'GET', body?: unknown, actorId?: string) => {
      check();
      const url = await endpoint(); check();
      const result = await deps.current.apiFetch<T>(`/v1${path}`, { baseUrl: url, method, cache: 'no-store', ...(body !== undefined ? { body } : {}),
        ...(actorId ? { headers: { 'X-Chat-Actor': actorId } } : {}), assertCurrent: check });
      check(); return result;
    };
    const client = createChatServerClient(request, listFor(owner));
    return { owner, realm, userId: auth.user?.id ?? '', current, baseUrl, endpoint, request, client,
      token: async () => { check(); await client.me(); const token = await deps.current.getAccessToken(); check(); return token; }, enabled: !!auth.user };
  }, [owner, !!auth.user]);
}

/** Direct server roster, independent of device discovery and presence. */
export function useChatServerRoster(enabled: boolean) {
  const api = useChatClient();
  const known = useRef({ owner: api.owner, ids: new Set<string>() });
  if (known.current.owner !== api.owner) known.current = { owner: api.owner, ids: new Set() };
  // A remounted roster must suppress already-known hidden rooms even if HTTP is offline.
  for (const id of api.client.personalList.ids()) known.current.ids.add(id);
  const snapshots = useRef(new Map<string, { owner: string; head: string | undefined; value: ChatSnapshot }>());
  const [state, setState] = useState({ owner: api.owner, rooms: [] as ReturnType<typeof chatRoomRow>[], loading: true, refreshing: false, error: null as string | null });
  const read = useRemoteSyncCoordinator(async run => {
    if (!api.enabled || !enabled) return;
    setState(old => ({ ...old, refreshing: run.reasons.includes('visible') }));
    const saved = await readCachedChatRoster(api.userId, api.realm);
    const cached = saved ?? { items: [], ids: [] };
    if (run.isStale() || !api.current()) return;
    for (const id of cached.ids) known.current.ids.add(id);
    if (saved) setState(old => old.owner === api.owner && !old.loading ? old : { owner: api.owner,
      rooms: cached.items.filter(row => !api.client.personalList.hidden(row.item.ref.id)), loading: false, refreshing: false, error: null });
    try {
      await api.client.syncListState(run.reasons.some(reason => ['focus', 'visible', 'connected'].includes(reason)));
      const [rooms, self] = await Promise.all([api.client.list(), api.client.me()]);
      const rows: ReturnType<typeof chatRoomRow>[] = [];
      const fresh = new Map<string, { owner: string; head: string | undefined; value: ChatSnapshot }>();
      // Keep archived IDs in `rooms` for computer-copy deduplication, but do not
      // download their histories or project them into the default teammate list.
      const visibleRooms = rooms.filter(room => !room.archived);
      let partial = false;
      // List provides room heads, so unchanged rooms need no history download on polling.
      for (let offset = 0; offset < visibleRooms.length; offset += 4) {
        await Promise.all(visibleRooms.slice(offset, offset + 4).map(async room => {
          try {
            const cached = snapshots.current.get(room.id);
            const value = cached?.owner === api.owner && room.head !== undefined && cached.head === room.head
              && !run.reasons.some(reason => ['changed', 'connected', 'visible'].includes(reason))
              ? cached.value : await api.client.snapshot(room.id);
            fresh.set(room.id, { owner: api.owner, head: room.head, value });
            // An archive can land between the list and the newer snapshot.
            if (!value.room.archived) rows.push(chatRoomRow(room, value, self));
          } catch (error) {
            if (!chatAccessLost(error)) {
              partial = true;
              const previous = cached.items.find(row => row.item.ref.id === room.id);
              const row = chatRoomRow(room);
              // Member links back the composite avatar and member search until a snapshot replaces them.
              rows.push(previous ? { ...previous, item: { ...row.item, display: { ...previous.item.display, title: row.item.display.title }, links: previous.item.links } } : row);
            }
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
        for (const id of api.client.personalList.ids()) known.current.ids.add(id);
        const visible = rows.filter(row => !api.client.personalList.hidden(row.item.ref.id));
        setState({ owner: api.owner, rooms: visible, loading: false, refreshing: false, error: partial ? 'CHAT_LIST_FAILED' : null });
        await cacheChatRoster(api.userId, api.realm, visible, known.current.ids);
      }
    } catch (error) {
      if (!run.isStale() && api.current()) {
        setState(old => ({ owner: api.owner, rooms: old.owner === api.owner && !chatAccessLost(error) ? old.rooms.filter(row => !api.client.personalList.hidden(row.item.ref.id)) : [], loading: false, refreshing: false, error: error instanceof Error && error.message === 'CHAT_ENDPOINT_UNAVAILABLE' ? error.message : 'CHAT_LIST_FAILED' }));
        if (chatAccessLost(error)) await cacheChatRoster(api.userId, api.realm, [], known.current.ids);
      }
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
        }, reset: () => api.client.resyncListState(), changed: changes => { for (const change of changes ?? []) if (change.type === 'conversation.list.changed') api.client.personalList.merge(change.data); void read({ reason: 'changed' }); }, available: () => { subscribed = true; }, unavailable: () => { subscribed = false; } });
      }).catch(() => {}); // HTTP read presents endpoint errors.
    };
    start();
    const foreground = AppState.addEventListener('change', value => { if (value === 'active') start(); else { stop?.(); clearInterval(poll); } });
    return () => { stop?.(); clearInterval(poll); foreground.remove(); };
  }, [api, enabled, read]));
  useEffect(() => api.client.personalList.subscribe(() => {
    if (!api.current()) return;
    for (const id of api.client.personalList.ids()) known.current.ids.add(id);
    setState(old => old.owner !== api.owner ? old : { ...old, rooms: old.rooms.filter(row => !api.client.personalList.hidden(row.item.ref.id)) });
    void hideCachedChatRooms(api.userId, api.realm, api.client.personalList.ids().filter(id => api.client.personalList.hidden(id)));
  }), [api]);
  const own = state.owner === api.owner;
  return { items: own ? state.rooms : [], serverIds: known.current.ids, loading: api.enabled && (!own || state.loading),
    refreshing: own && state.refreshing, error: own ? state.error : null, refresh };
}

/** Reads and sends use the account's Chat Server identity, never its computer identity. */
export function useChatServerGroup(groupId: string, enabled: boolean, threadRootId?: string) {
  const api = useChatClient();
  const identity = `${api.owner}:${groupId}:${threadRootId ?? 'main'}`;
  const active = useRef(identity); active.current = identity;
  const [state, setState] = useState<{ identity: string; value: BotGroupChatState; online: boolean; loadingOlder: boolean }>({ identity, value: { kind: 'loading' }, online: true, loadingOlder: false });
  const page = useRef<{ identity: string; page: ChatPage; self: string; actors: ChatActor[] } | null>(null);
  const accessGeneration = useRef(0);
  const freshRead = useRef(false);
  const olderPending = useRef(false);
  const valid = () => api.current() && active.current === identity;
  const loseAccess = () => {
    accessGeneration.current++; freshRead.current = false; page.current = null;
    if (valid()) void forgetRemoteResource(api.userId, groupId);
    setState({ identity, value: { kind: 'missing' }, online: false, loadingOlder: false });
  };
  const view = (next: ChatPage, self: string, actors: ChatActor[]) => ({ ...chatGroupView(next, self, actors), ...api.client.lifecycleCapabilities() });
  const request = useRemoteSyncCoordinator(async run => {
    if (!enabled || !api.enabled) return;
    const generation = accessGeneration.current;
    freshRead.current = false;
    try {
      await api.client.syncListState(run.reasons.some(reason => ['focus', 'visible', 'connected'].includes(reason)));
      const previous = page.current?.identity === identity ? page.current.page : null;
      const oldest = previous?.messages.filter(message => !threadRootId || message.threadRootId === threadRootId).reduce<string | undefined>((oldest, message) => !oldest || BigInt(message.seq) < BigInt(oldest) ? message.seq : oldest, undefined);
      // The account's actors say which computer runs each owned companion (live task cards);
      // the group still reads when that list is unavailable.
      const [next, self, actors] = await Promise.all([api.client.load(groupId, oldest, threadRootId), api.client.me(), api.client.actors().catch((): ChatActor[] => [])]);
      if (run.isStale() || !valid() || generation !== accessGeneration.current) return;
      // Replace the reauthorized window; no stale history survives changed access.
      if (api.client.personalList.hidden(groupId)) { loseAccess(); return; }
      freshRead.current = true;
      page.current = { identity, page: next, self, actors };
      setState({ identity, value: { kind: 'ready', group: view(next, self, actors) }, online: true, loadingOlder: false });
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
        socket: url => new WebSocket(url), ready: async actorId => {
          const head = api.client.lifecycleCapabilities().supportsListRemoval ? await api.request<{ head: string }>(`/changes?scope=actor:${actorId}&after=0&limit=1`).then(value => chatCursor(value.head)).catch(error => {
            if ((error as { code?: string }).code !== 'RESET_REQUIRED') throw error;
            return '0';
          }) : null;
          await request({ reason: 'connected' });
          const latest = page.current;
          if (!freshRead.current || !latest || latest.identity !== identity) throw new Error('CHAT_READ_FAILED');
          return head === null ? { scope: `conversation:${groupId}`, cursor: latest.page.snapshot.cursor }
            : [{ scope: `conversation:${groupId}`, cursor: latest.page.snapshot.cursor }, { scope: `actor:${actorId}`, cursor: head }];
        }, reset: () => api.client.resyncListState(), changed: changes => { for (const change of changes ?? []) if (change.type === 'conversation.list.changed') api.client.personalList.merge(change.data); reload(); }, available: () => { subscribed = true; }, unavailable: () => { subscribed = false; freshRead.current = false; } });
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
      setState({ identity, value: { kind: 'ready', group: view(next, previous.self, previous.actors) }, online: true, loadingOlder: false });
    } catch (error) {
      if (valid() && page.current === previous && chatAccessLost(error)) loseAccess();
      throw error;
    } finally { olderPending.current = false; if (valid()) setState(old => ({ ...old, loadingOlder: false })); }
  };
  const act = async (action: BotGroupRemoteActionId, input?: Record<string, unknown>): Promise<RemoteActionInvokeResponse> => {
    if (action === 'dissolve' || action === 'leave' || action === 'hide') {
      const operationId = (await import('expo-crypto')).randomUUID();
      if (action === 'hide') {
        await api.client.hide(groupId, operationId);
        if (valid()) { accessGeneration.current++; page.current = null; setState({ identity, value: { kind: 'missing' }, online: true, loadingOlder: false });
          await forgetRemoteResource(api.userId, groupId); }
      } else if (action === 'leave') {
        try { await api.client.leave(groupId, operationId); } catch (error) { if (valid()) reload(); throw error; }
        if (valid()) loseAccess();
      } else {
        try { await api.client.dissolve(groupId, input?.expectedRevision, operationId); } finally { if (valid()) reload(); }
      }
      return { effects: [] };
    }
    if (action !== 'send' || !input || input.division || (Array.isArray(input.attachments) && input.attachments.length)) throw new Error('UNSUPPORTED_CHAT_ACTION');
    const latest = page.current;
    if (!latest || latest.identity !== identity) throw new Error('CHAT_READ_FAILED');
    try {
      const mentions = input.mentions as { all: boolean; botIds: string[] };
      const joined = mentions.all || mentions.botIds.length
        ? (await api.client.members(groupId)).filter(member => member.state === 'joined') : [];
      if (!valid() || page.current?.identity !== identity) throw new Error('OWNER_CHANGED');
      // Validate every explicit pick before Everyone expansion; never discard a
      // departed target or submit only the remaining part of the intended list.
      if (mentions.botIds.some(id => !joined.some(member => member.id === id))) throw new Error('MENTION_UNAVAILABLE');
      const recipients = mentions.all
        ? joined.map(member => member.id)
        : [...mentions.botIds];
      const root = threadRootId ? latest.page.messages.find(message => message.id === threadRootId) : undefined;
      if (root && joined.some(member => member.id === root.authorId && member.kind === 'bot')) recipients.push(root.authorId);
      await api.client.send(groupId, { clientId: String(input.clientId), text: String(input.text), threadRootId,
        ...(input.quote && typeof input.quote === 'object' && 'messageId' in input.quote
          ? { quote: { messageId: String(input.quote.messageId) } } : {}),
        mentions: { all: false, botIds: recipients.filter(id => id !== latest.self) } });
      if (valid()) reload();
      return { effects: [] };
    } catch (error) {
      // An unavailable mention is a draft correction, not a connectivity failure.
      if (error instanceof Error && ['MENTION_UNAVAILABLE', 'QUOTE_UNAVAILABLE'].includes(error.message)) throw error;
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
  useEffect(() => api.client.personalList.subscribe(() => {
    if (valid() && api.client.personalList.hidden(groupId)) {
      loseAccess();
      void forgetRemoteResource(api.userId, groupId);
    }
  }), [api, identity, groupId]);
  const markRead = useCallback(async (messageIds: readonly string[]) => {
    const latest = page.current;
    if (!api.current() || active.current !== identity || !latest || latest.identity !== identity) return;
    // Only the measured UI's messages are acknowledged, even if a newer read is settling.
    const seen = new Set(messageIds);
    const messages = latest.page.messages.filter(message => seen.has(message.id));
    if (!threadRootId) await markRemoteResourceRead(api.userId, '', groupId, chatLastReplyAt(messages, latest.self), chatLastReplySequence(messages, latest.self));
    if (!api.current() || active.current !== identity) return;
    try { await api.client.markRead(groupId, latest.page, messageIds); }
    catch {
      // The foreground recovery refresh retries from the measured viewport, never from the head.
      if (api.current() && active.current === identity) freshRead.current = false;
    }
  }, [api, groupId, identity]);
  const acceptListState = useCallback(async (value: unknown) => {
    if (!api.current()) throw new Error('OWNER_CHANGED');
    if ((value as { conversationId?: unknown } | null)?.conversationId !== groupId) throw new Error('INVALID_CHAT_LIST_STATE');
    api.client.personalList.merge(value);
    if (api.current() && api.client.personalList.hidden(groupId)) await forgetRemoteResource(api.userId, groupId);
  }, [api, groupId]);
  return { state: state.identity === identity ? state.value : { kind: 'loading' } as BotGroupChatState,
    listHidden: api.current() && api.client.personalList.hidden(groupId),
    online: state.identity === identity && state.online, reload, act,
    acceptListState, isListHidden: () => api.client.personalList.hidden(groupId), loadOlder, loadingOlder: state.loadingOlder, media, markRead };
}
