/** Account-scoped projection. Never persist messages or turn a failed write into a local hide. */
export interface ConversationListState { conversationId: string; hidden: boolean; revision: number }
type Request = <T>(path: string, method?: 'GET' | 'POST', body?: unknown) => Promise<T>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function state(value: unknown): ConversationListState {
  const row = value as ConversationListState | null;
  if (!row || !uuid.test(row.conversationId) || typeof row.hidden !== 'boolean'
    || !Number.isSafeInteger(row.revision) || row.revision < 1) throw new Error('INVALID_CHAT_LIST_STATE');
  return row;
}

/** One instance per account/realm, shared by its roster, settings and subscriptions. */
export function createConversationListState() {
  const rows = new Map<string, ConversationListState>();
  const listeners = new Set<(row: ConversationListState) => void>();
  let synced = false;
  let syncing: Promise<void> | null = null;
  const merge = (value: unknown) => {
    const row = state(value);
    if ((rows.get(row.conversationId)?.revision ?? 0) >= row.revision) return;
    rows.set(row.conversationId, row);
    for (const notify of listeners) notify(row);
  };
  // Reconnects force a full authoritative read; ordinary refreshes share the initial
  // read and then rely on account events, rather than downloading every page again.
  const sync = (request: Request, force = true): Promise<void> => {
    if (syncing) return syncing;
    if (!force && synced) return Promise.resolve();
    synced = false;
    syncing = (async () => {
      let after: string | undefined;
      do {
        const page = await request<unknown[]>(`/conversation-list-state?limit=100${after ? `&after=${after}` : ''}`);
        if (!Array.isArray(page)) throw new Error('INVALID_CHAT_LIST_STATE');
        for (const value of page) merge(value);
        const next = page.length === 100 ? state(page.at(-1)).conversationId : undefined;
        if (next && after && next <= after) throw new Error('INVALID_CHAT_PAGE');
        after = next;
      } while (after);
      synced = true;
    })().finally(() => { syncing = null; });
    return syncing;
  };
  return {
    merge,
    hidden: (id: string) => rows.get(id)?.hidden === true,
    get: (id: string) => rows.get(id),
    revision: (id: string) => rows.get(id)?.revision ?? 0,
    ids: () => [...rows.keys()],
    subscribe(notify: (row: ConversationListState) => void) { listeners.add(notify); return () => { listeners.delete(notify); }; },
    sync,
    ensureSynced: (request: Request) => sync(request, false),
    // A reset's head may be newer than the start of an existing scan. Finish that
    // scan first, then read again so resubscribing at the supplied head loses no gap.
    async resync(request: Request) { if (syncing) await syncing; await sync(request); },
    async setHidden(request: Request, id: string, hidden: boolean, operationId: string) {
      if (!uuid.test(id)) throw new Error('INVALID_CHAT_ID');
      // Read first, including after leaving. A lost acknowledgement is safe to retry.
      await this.sync(request);
      if ((rows.get(id)?.hidden ?? false) === hidden) return;
      const result = state(await request(`/conversations/${id}/list-state`, 'POST', {
        operationId, hidden, expectedRevision: rows.get(id)?.revision ?? 0,
      }));
      if (result.conversationId !== id || result.hidden !== hidden) throw new Error('INVALID_CHAT_LIST_STATE');
      merge(result);
      if (rows.get(id)?.hidden !== hidden) throw new Error('REVISION_CONFLICT');
    },
  };
}
