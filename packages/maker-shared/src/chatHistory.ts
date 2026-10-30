/** A disposable, authorized server projection. Runtime/model history is deliberately separate. */
export interface ChatHistoryMessage {
  id: string; seq: string; revision?: number; deleted?: boolean; threadRootId?: string | null;
}
export interface ChatHistorySnapshot {
  room: { id: string; kind?: string }; cursor: string; messages: ChatHistoryMessage[];
}
export interface ChatHistoryState {
  generation: string;
  snapshot: ChatHistorySnapshot;
  cursor: string;
  messages: Record<string, ChatHistoryMessage>;
  /** Exact server page membership. Absence means not loaded, including after reset. */
  pages: Record<string, string[]>;
  /** Aggregates absent from change bodies (reactions/reply counts) need a page refresh. */
  stalePages?: string[];
  /** Individually fetched roots outside covered pages; bodies live in messages, as usual. */
  lookups?: string[];
  staleLookups?: string[];
  metadataDirty: boolean;
}
export interface ChatHistoryStore {
  read: (room: string) => Promise<ChatHistoryState | undefined>;
  /** State, message revisions/tombstones, page coverage and cursor commit together. */
  write: (room: string, state: ChatHistoryState | null) => Promise<void>;
}
export interface ChatHistoryChange {
  type: string; entityId?: string; data?: { message?: ChatHistoryMessage; threadRootId?: string | null };
}
export interface ChatHistoryBatch { cursor: string; changes: ChatHistoryChange[]; hasMore?: boolean }
type Api = <T>(route: string) => Promise<T>;
const isCursor = (value: unknown): value is string => typeof value === 'string' && /^\d+$/.test(value);
const errorCode = (error: unknown) => error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
  ? error.code : error instanceof Error ? error.message : '';

export function createChatHistory(input: { api: Api; store: ChatHistoryStore; current: () => boolean; newGeneration: () => string }) {
  const chains = new Map<string, Promise<unknown>>();
  const states = new Map<string, ChatHistoryState>();
  const checked = new Map<string, number>();
  const metadataConnection = new Map<string, number>();
  const dirty = new Set<string>();
  // A refresh consumes only the invalidation it successfully committed. New
  // notices during I/O and notices surviving CAS retries must remain pending.
  const metadataDirty = new Map<string, number>();
  let nextMetadataInvalidation = 0;
  let connection = 0;
  function assertCurrent() { if (!input.current()) throw new Error('OWNER_CHANGED'); }
  function serial<T>(room: string, run: () => Promise<T>): Promise<T> {
    const pending = (chains.get(room) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      assertCurrent();
      for (let attempt = 0; ; attempt++) {
        try { const result = await run(); assertCurrent(); return result; }
        catch (error) {
          states.delete(room); checked.delete(room); metadataConnection.delete(room);
          if (errorCode(error) === 'CHAT_CACHE_CONFLICT' && attempt < 2) continue;
          if (['FORBIDDEN', 'NOT_MEMBER', 'NOT_A_MEMBER', 'CONVERSATION_NOT_FOUND', 'ACTOR_NOT_FOUND', 'ACCOUNT_UNAVAILABLE'].includes(errorCode(error))) {
            assertCurrent();
            try { await input.store.write(room, null); }
            catch (cleanupError) {
              // Another mount may have committed a newer projection. Leave it alone,
              // but preserve this caller's revocation error so its UI clears stale data.
              if (errorCode(cleanupError) !== 'CHAT_CACHE_CONFLICT') throw cleanupError;
            }
          }
          throw error;
        }
      }
    });
    chains.set(room, pending);
    void pending.finally(() => { if (chains.get(room) === pending) chains.delete(room); }).catch(() => undefined);
    return pending;
  }
  async function save(room: string, state: ChatHistoryState) {
    assertCurrent();
    state.stalePages = state.stalePages?.filter(key => state.pages[key]);
    // Keep only covered pages and the snapshot, never every change in the room's history.
    const retained = new Set([...state.snapshot.messages.map(m => m.id), ...Object.values(state.pages).flat(), ...(state.lookups ?? [])]);
    state.staleLookups = state.staleLookups?.filter(id => state.lookups?.includes(id));
    for (const id of Object.keys(state.messages)) if (!retained.has(id)) delete state.messages[id];
    await input.store.write(room, state);
    assertCurrent(); states.set(room, state);
  }
  async function bootstrap(room: string) {
    dirty.delete(room);
    const invalidation = metadataDirty.get(room);
    const epoch = connection;
    const snapshot = await input.api<ChatHistorySnapshot>(`/conversations/${room}/snapshot`);
    if (!isCursor(snapshot.cursor) || snapshot.room.id !== room || !Array.isArray(snapshot.messages)) throw new Error('CHAT_RESPONSE_INVALID');
    const state: ChatHistoryState = { generation: input.newGeneration(), snapshot, cursor: snapshot.cursor, messages: {}, pages: {}, metadataDirty: false };
    for (const message of snapshot.messages) state.messages[message.id] = message;
    await save(room, state);
    if (metadataDirty.get(room) === invalidation) metadataDirty.delete(room);
    if (epoch === connection) { checked.set(room, Date.now()); metadataConnection.set(room, epoch); }
    return state;
  }
  function merge(state: ChatHistoryState, message: ChatHistoryMessage) {
    const previous = state.messages[message.id];
    if (!previous || (message.revision ?? 0) >= (previous.revision ?? 0))
      state.messages[message.id] = { ...previous, ...message };
  }
  /** Returns false when the membership/history boundary requires a new bootstrap. */
  function apply(state: ChatHistoryState, batch: ChatHistoryBatch): boolean {
    if (!isCursor(batch.cursor) || !Array.isArray(batch.changes)) throw new Error('CHAT_RESPONSE_INVALID');
    if (BigInt(batch.cursor) <= BigInt(state.cursor)) return true;
    if (batch.changes.some(c => c.type === 'membership.changed')) return false;
    for (const change of batch.changes) {
      const message = change.data?.message;
      if (/^(message\.|reaction\.|pin\.)/.test(change.type)) {
        if (!message) return false;
        if (change.type === 'reaction.changed') {
          if (state.snapshot.messages.some(m => m.id === message.id)) state.metadataDirty = true;
          for (const [key, ids] of Object.entries(state.pages)) if (ids.includes(message.id)) stale(state, key);
          staleLookup(state, message.id);
        }
        if (message) {
          merge(state, message);
          if (change.type === 'message.created' && !state.snapshot.messages.some(m => m.id === message.id)) {
            state.snapshot.messages.push(message);
            state.snapshot.messages.sort((a, b) => BigInt(a.seq) > BigInt(b.seq) ? -1 : BigInt(a.seq) < BigInt(b.seq) ? 1 : 0);
            state.snapshot.messages = state.snapshot.messages.slice(0, 100);
          }
          // A new reply also changes its root's reply count. Refresh only pages containing that root.
          if (message.threadRootId && ['message.created', 'message.deleted'].includes(change.type)) {
            for (const [key, ids] of Object.entries(state.pages)) if (ids.includes(message.threadRootId)) stale(state, key);
            staleLookup(state, message.threadRootId);
          }
        }
        if (change.type === 'message.created') {
          for (const key of Object.keys(state.pages)) {
            const query = new URLSearchParams(key);
            if (query.has('before')) continue;
            if (query.get('all') !== 'true' && (query.get('threadRootId') ?? null) !== (message.threadRootId ?? null)) continue;
            const ids = state.pages[key]!;
            // Preserve the old window as bounded coverage: new arrivals shift pagination
            // boundaries, but must not make every older page download again.
            const first = ids[0] && state.messages[ids[0]];
            if (first) {
              query.set('before', String(BigInt(first.seq) + 1n)); state.pages[query.toString()] = ids;
              if (state.stalePages?.includes(key)) stale(state, query.toString());
            }
            delete state.pages[key];
          }
        }
      } else if (!['execution.changed', 'plan.changed'].includes(change.type)) state.metadataDirty = true;
    }
    state.snapshot.messages = state.snapshot.messages.map(m => state.messages[m.id] ?? m);
    state.cursor = batch.cursor;
    return true;
  }
  function stale(state: ChatHistoryState, key: string) {
    state.stalePages ??= [];
    if (!state.stalePages.includes(key)) state.stalePages.push(key);
  }
  function staleLookup(state: ChatHistoryState, id: string) {
    if (!state.lookups?.includes(id)) return;
    state.staleLookups ??= [];
    if (!state.staleLookups.includes(id)) state.staleLookups.push(id);
  }
  async function fetchPage<M extends ChatHistoryMessage>(room: string, state: ChatHistoryState, key: string) {
    const messages = await input.api<M[]>(`/conversations/${room}/messages?${key}`);
    if (!Array.isArray(messages)) throw new Error('CHAT_RESPONSE_INVALID');
    for (const message of messages) merge(state, message);
    const ids = messages.map(m => m.id); state.pages[key] = ids;
    state.stalePages = state.stalePages?.filter(value => value !== key);
    const excess = Object.keys(state.pages).length - 500;
    if (excess > 0) {
      // Retain the newest covered ranges, not insertion order: renaming a shifted
      // head must not evict the next page and cascade misses through a transcript.
      // Keep this response covered until page() has returned its message objects.
      const oldest = Object.entries(state.pages).filter(([pageKey]) => pageKey !== key)
        .map(([pageKey, pageIds]) => ({ key: pageKey,
          seq: BigInt(state.messages[pageIds[0] ?? '']?.seq ?? new URLSearchParams(pageKey).get('before') ?? '0') }))
        .sort((a, b) => a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0);
      for (const page of oldest.slice(0, excess)) delete state.pages[page.key];
    }
    await save(room, state);
    return ids;
  }
  async function ensure(room: string, force = false): Promise<ChatHistoryState> {
    let state = states.get(room) ?? await input.store.read(room);
    assertCurrent();
    if (!state) return bootstrap(room);
    states.set(room, state);
    // Personal reads belong to actor scope, so room deltas cannot repair missed
    // read notifications on reconnect (including rooms first restored from disk).
    if (connection > 0 && metadataConnection.get(room) !== connection) state.metadataDirty = true;
    const invalidation = metadataDirty.get(room);
    if (invalidation !== undefined) state.metadataDirty = true;
    if (!force && !state.metadataDirty && !dirty.has(room) && Date.now() - (checked.get(room) ?? 0) < 30_000) return state;
    const epoch = connection;
    dirty.delete(room);
    try {
      // Bound one catch-up. A compacted or exceptionally long backlog is cheaper to rebootstrap.
      for (let page = 0; page < 20; page++) {
        const batch = await input.api<ChatHistoryBatch>(`/changes?scope=conversation:${room}&after=${state.cursor}&limit=100`);
        if (batch.hasMore && batch.cursor === state.cursor) throw new Error('CHAT_SYNC_STALLED');
        if (!apply(state, batch)) return bootstrap(room);
        await save(room, state);
        if (!batch.hasMore) {
          if (state.metadataDirty) {
            const snapshot = await input.api<ChatHistorySnapshot>(`/conversations/${room}/snapshot`);
            // Do not jump past changes committed between the delta and this metadata read.
            for (const message of snapshot.messages) merge(state, message);
            state.snapshot = { ...snapshot, cursor: state.cursor, messages: snapshot.messages.map(m => state!.messages[m.id]!) };
            state.metadataDirty = false;
            await save(room, state);
            if (metadataDirty.get(room) === invalidation) metadataDirty.delete(room);
          }
          if (epoch === connection) { checked.set(room, Date.now()); metadataConnection.set(room, epoch); }
          return state;
        }
      }
      return bootstrap(room);
    } catch (error) {
      if (['RESET_REQUIRED', 'CURSOR_AHEAD'].includes(errorCode(error))) return bootstrap(room);
      throw error;
    }
  }
  function coveredPage(state: ChatHistoryState, query: URLSearchParams): string[] | undefined {
    const before = query.get('before');
    if (!before) return undefined;
    const limit = Number(query.get('limit') ?? 100);
    let position = BigInt(before);
    const found = new Map<string, ChatHistoryMessage>();
    const candidates = Object.entries(state.pages).filter(([key]) => !state.stalePages?.includes(key)
      && ['threadRootId', 'all', 'after'].every(field => new URLSearchParams(key).get(field) === query.get(field)));
    while (candidates.length) {
      const covering = candidates.find(([key, ids]) => {
        const upper = new URLSearchParams(key).get('before');
        if (upper && BigInt(upper) < position) return false;
        const last = ids.at(-1);
        return !last || BigInt(state.messages[last]!.seq) < position;
      });
      if (!covering) return undefined;
      const [key, ids] = covering;
      for (const id of ids) {
        const message = state.messages[id]!;
        if (BigInt(message.seq) < position && BigInt(message.seq) < BigInt(before)) found.set(id, message);
      }
      const sorted = [...found.values()].sort((a, b) => BigInt(a.seq) > BigInt(b.seq) ? -1 : BigInt(a.seq) < BigInt(b.seq) ? 1 : 0);
      if (sorted.length >= limit || ids.length < Number(new URLSearchParams(key).get('limit') ?? 100)) return sorted.slice(0, limit).map(m => m.id);
      position = BigInt(state.messages[ids.at(-1)!]!.seq);
      candidates.splice(candidates.indexOf(covering), 1);
    }
    return undefined;
  }
  return {
    message: <M extends ChatHistoryMessage>(room: string, id: string): Promise<M> => serial(room, async () => {
      const state = await ensure(room);
      if (!state.lookups?.includes(id) || !state.messages[id] || state.staleLookups?.includes(id)) {
        const message = await input.api<M>(`/conversations/${room}/messages/${encodeURIComponent(id)}`);
        if (message?.id !== id || !isCursor(message.seq)) throw new Error('CHAT_RESPONSE_INVALID');
        merge(state, message);
        state.lookups = [...(state.lookups ?? []).filter(value => value !== id), id].slice(-100);
        state.staleLookups = state.staleLookups?.filter(value => value !== id);
        await save(room, state);
      }
      return state.messages[id] as M;
    }),
    snapshot: <S extends ChatHistorySnapshot>(room: string): Promise<S & { cacheGeneration: string }> => serial(room, async () => {
      const state = await ensure(room);
      return { ...state.snapshot, cursor: state.cursor, cacheGeneration: state.generation } as S & { cacheGeneration: string };
    }),
    page: <M extends ChatHistoryMessage>(room: string, query: URLSearchParams): Promise<M[]> => serial(room, async () => {
      const state = await ensure(room);
      const key = query.toString();
      const ids = (state.stalePages?.includes(key) ? undefined : state.pages[key])
        ?? coveredPage(state, query) ?? await fetchPage<M>(room, state, key);
      return ids.map(id => state.messages[id] as M);
    }),
    /** A reconnect must verify membership and catch up before returning persisted content. */
    reconnect() { connection++; checked.clear(); },
    invalidate(room: string, metadata = false) {
      dirty.add(room); checked.delete(room);
      if (metadata) metadataDirty.set(room, ++nextMetadataInvalidation);
    },
    cursor(room: string) { return states.get(room)?.cursor; },
    generation(room: string) { return states.get(room)?.generation; },
    projection: <M extends ChatHistoryMessage>(room: string, ids: string[]) => serial(room, async () => {
      const state = await ensure(room);
      const shown = new Set(ids);
      for (const key of state.stalePages ?? [])
        if (state.pages[key]?.some(id => shown.has(id))) await fetchPage<M>(room, state, key);
      return { generation: state.generation, messages: ids.flatMap(id => state.messages[id] ? [state.messages[id] as M] : []) };
    }),
    receive: (room: string, batch: ChatHistoryBatch, subscribedAfter: string | undefined): Promise<string | undefined> => serial(room, async () => {
      const state = states.get(room) ?? await input.store.read(room);
      if (!state) return undefined;
      // Another foreground snapshot may have started this subscription beyond our durable cursor.
      // Catch up that gap instead of acknowledging unseen edits/deletions.
      if (!subscribedAfter || BigInt(subscribedAfter) > BigInt(state.cursor)) return (await ensure(room, true)).cursor;
      if (!apply(state, batch)) {
        await input.store.write(room, null); states.delete(room); checked.delete(room); metadataConnection.delete(room);
        return undefined;
      }
      await save(room, state);
      return state.cursor;
    }),
    clear: (room: string) => serial(room, async () => {
      await input.store.write(room, null); states.delete(room); checked.delete(room); metadataConnection.delete(room);
    }),
  };
}
export type ChatHistory = ReturnType<typeof createChatHistory>;
