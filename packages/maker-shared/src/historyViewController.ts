import {
  readHistoryWorkDetails, isHistoryViewUnavailable, historyWorkSummaries, historyViewLeaves, type HistoryDetailPage, type HistoryMessageSource,
  type HistoryViewItem, type HistoryViewPage, type HistoryWorkSummary,
} from './historyView.js';

export interface HistoryWorkDetailState<T extends HistoryMessageSource> {
  messages: readonly T[];
  revision: string;
  lastMessageId: string;
  loading: boolean;
  complete: boolean;
  error: unknown | null;
}

export interface HistoryViewSnapshot<T extends HistoryMessageSource> {
  items: readonly HistoryViewItem<T>[];
  details: ReadonlyMap<string, HistoryWorkDetailState<T>>;
  expanded: ReadonlySet<string>;
  nextCursor: string | null;
  hasMore: boolean;
  loading: boolean;
  ready: boolean;
  error: unknown | null;
}

export interface HistoryViewTransport<T extends HistoryMessageSource> {
  page(before?: string): Promise<HistoryViewPage<T>>;
  details(summary: HistoryWorkSummary, after?: string): Promise<HistoryDetailPage<T>>;
  /** Full replacement of this view's intent; empty releases detail streaming. */
  expanded(summaries: readonly HistoryWorkSummary[]): Promise<void>;
}

/**
 * Shared reading state for native and desktop controllers. Raw message stores never
 * receive synthetic rows or a false promise that deferred source ranges are loaded.
 */
export class HistoryViewController<T extends HistoryMessageSource> {
  private state: HistoryViewSnapshot<T> = {
    items: [], details: new Map(), expanded: new Set(), nextCursor: null,
    hasMore: false, loading: false, ready: false, error: null,
  };
  private listeners = new Set<() => void>();
  private generation = 0;
  // Transport changes invalidate remote reads, not local disk restoration.
  private cacheGeneration = 0;
  private detailRuns = new Map<string, object>();
  private active = true;
  private networkAvailable = true;
  private pagePromise: Promise<void> | null = null;
  private pageOlder = false;
  private pageGeneration = 0;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly transport: HistoryViewTransport<T>,
    // A replacement controller can inherit the same ordering without waiting
    // for the old source's page/detail requests.
    private readonly intentQueue = { tail: Promise.resolve() as Promise<void> },
  ) {}
  isActive = (): boolean => this.active && this.networkAvailable;
  /** Offline reading retains the view, but never sends page/detail/interest requests. */
  setNetworkAvailable(available: boolean): void {
    if (this.networkAvailable === available) return;
    this.networkAvailable = available;
    this.generation++;
    this.detailRuns.clear();
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    this.publish({ loading: false, details: new Map([...this.state.details].map(([key, detail]) =>
      [key, detail.loading ? { ...detail, loading: false } : detail])) });
    if (available && this.active) void this.refresh();
  }
  getSnapshot = (): HistoryViewSnapshot<T> => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private publish(patch: Partial<HistoryViewSnapshot<T>>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** Optimistic local display only. A fresh response or reset always wins over disk IO. */
  async restoreCachedView(read: () => Promise<HistoryViewSnapshot<T> | null>): Promise<void> {
    if (this.state.ready || isHistoryViewUnavailable(this.state.error)) return;
    const generation = this.cacheGeneration;
    const cached = await read().catch(() => null);
    if (!cached || this.state.ready || isHistoryViewUnavailable(this.state.error) || generation !== this.cacheGeneration) return;
    this.publish({ ...cached, loading: this.state.loading, error: this.state.error });
  }

  refresh(older = false, fresh = false): Promise<void> {
    // Keep the existing raw fallback until an explicit reset; a later latest
    // page must not re-enable projection after an oversized older-page read.
    if (/UNSUPPORTED_CAPABILITY/.test(String(this.state.error))) return Promise.resolve();
    if (this.pagePromise) {
      // Subscription recovery must read after its ACK, not reuse a pre-ACK page.
      // Reuse the same wait queue and preserve expansion; no parallel read is needed.
      // A caller after reset/reactivation must await its own generation's read,
      // even when the invalidated request happened to have the same direction.
      if (!fresh && older === this.pageOlder && this.pageGeneration === this.generation) return this.pagePromise;
      const generation = this.generation;
      return this.pagePromise.then(() => {
        if (this.isActive() && generation === this.generation && (fresh || !this.state.error)) return this.refresh(older);
      });
    }
    this.pageOlder = older;
    this.pageGeneration = this.generation;
    const promise = this.readPage(older);
    this.pagePromise = promise;
    void promise.finally(() => { if (this.pagePromise === promise) this.pagePromise = null; });
    return promise;
  }

  /** Coalesce activity notices; full assistant streaming continues on its existing path. */
  invalidate(): void {
    if (!this.isActive() || this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      if (this.pagePromise) {
        void this.pagePromise.then(() => this.invalidate());
      } else void this.refresh();
    }, 500);
  }

  private async readPage(older: boolean): Promise<void> {
    if (!this.isActive() || this.state.loading || (older && !this.state.hasMore)) return;
    const generation = this.generation;
    const before = older ? this.state.nextCursor ?? undefined : undefined;
    this.publish({ loading: true, error: null });
    try {
      const page = await this.transport.page(before);
      if (page == null) throw new Error('[CHANNEL_NOT_ALLOWED] History view is unavailable');
      if (!this.active || generation !== this.generation) return;
      let items = page.items;
      if (older) {
        const keys = new Set(items.map((item) => item.key));
        items = [...items, ...this.state.items.filter((item) => !keys.has(item.key))];
      } else if (page.hasMore && this.state.items.length) {
        const firstSourceId = (item: HistoryViewItem<T> | undefined) => item?.type === 'work'
          ? item.summary.firstMessageId : item?.messages[0]?.id;
        const first = page.items[0];
        const sourceId = firstSourceId(first);
        const boundary = this.state.items.findIndex((item) => item.key === first?.key
          || (sourceId !== undefined && firstSourceId(item) === sourceId));
        // Completed outer groups can replace the running top-level key while
        // retaining its exact source start. Never infer a prefix from a later overlap.
        // Only retain a prefix with a proven overlap. Reset/rewind cannot leave an island.
        if (boundary > 0) items = [...this.state.items.slice(0, boundary), ...items];
      }
      const retainedPrefix = !older && items.length > page.items.length;
      // A background validation of the same page must not replace rendering
      // identities. Applies to both Mobile and Desktop history consumers.
      const previous = new Map(this.state.items.map((item) => [item.key, item]));
      items = items.map((item) => {
        const cached = previous.get(item.key);
        return cached && JSON.stringify(cached) === JSON.stringify(item) ? cached : item;
      });
      const stableItems = items.length === this.state.items.length
        && items.every((item, index) => item === this.state.items[index]) ? this.state.items : items;
      this.publish({ items: stableItems, ready: true, loading: false,
        hasMore: retainedPrefix ? this.state.hasMore : page.hasMore,
        nextCursor: retainedPrefix ? this.state.nextCursor : page.nextCursor });
      for (const summary of historyWorkSummaries(items)) {
        if (this.state.expanded.has(summary.key)) void this.loadDetails(summary);
      }
      this.sendIntent();
    } catch (error) {
      if (generation === this.generation && this.active) {
        if (isHistoryViewUnavailable(error)) {
          // A downgraded Host must not leave a ready projection masking the raw
          // fallback. Invalidate in-flight details and every cached source row.
          this.generation++;
          this.cacheGeneration++;
          this.detailRuns.clear();
          if (this.refreshTimer) clearTimeout(this.refreshTimer);
          this.refreshTimer = null;
          this.publish({ items: [], details: new Map(), expanded: new Set(), ready: false,
            nextCursor: null, hasMore: false, loading: false, error });
        } else this.publish({ loading: false, error });
      }
    }
  }

  setExpanded(key: string, expanded: boolean): void {
    if (this.state.expanded.has(key) === expanded) return;
    const next = new Set(this.state.expanded);
    if (expanded) next.add(key); else next.delete(key);
    if (!expanded) this.detailRuns.delete(key);
    this.publish({ expanded: next });
    this.sendIntent();
    const summary = historyWorkSummaries(this.state.items).find((value) => value.key === key);
    if (expanded && summary) void this.loadDetails(summary);
  }

  private sendIntent(): void {
    if (!this.networkAvailable) return;
    // Serialize replacement intents: a late expand ACK can never win over collapse.
    const generation = this.generation;
    this.intentQueue.tail = this.intentQueue.tail.catch(() => undefined).then(async () => {
      if (generation !== this.generation || !this.networkAvailable) return;
      // Empty replacement intents must release old interest even before a reset view is ready.
      const summaries = this.active ? historyWorkSummaries(this.state.items).filter((item) => this.state.expanded.has(item.key)) : [];
      await this.transport.expanded(summaries);
    }).catch(() => {
      // Detail interest is advisory; a transient ACK failure must not poison a successful page.
      if (this.active && generation === this.generation) this.invalidate();
    });
  }

  async loadDetails(summary: HistoryWorkSummary): Promise<void> {
    if (!this.isActive() || !this.state.expanded.has(summary.key) || this.detailRuns.has(summary.key)) return;
    const existing = this.state.details.get(summary.key);
    if (existing?.complete && existing.revision === summary.revision) return;
    const token = {};
    const generation = this.generation;
    this.detailRuns.set(summary.key, token);
    const current = () => this.active && generation === this.generation
      && this.detailRuns.get(summary.key) === token && this.state.expanded.has(summary.key);
    // A changed revision may include late edits anywhere in the range, even
    // when its endpoint also advances. Keep the old display while rereading.
    let collected: T[] = [];
    const update = (patch: Partial<HistoryWorkDetailState<T>>) => {
      const completed = this.state.details.get(summary.key);
      if (completed?.complete && completed.revision === summary.revision && !patch.complete) return;
      const details = new Map(this.state.details);
      details.set(summary.key, { messages: collected.length ? collected : (existing?.messages ?? []), revision: summary.revision,
        lastMessageId: summary.lastMessageId, loading: true, complete: false, error: null, ...patch });
      this.publish({ details });
    };
    update({});
    try {
      await readHistoryWorkDetails({
        readPage: (cursor) => this.transport.details(summary, cursor ?? undefined),
        isCurrent: current,
        onPage: (rows) => {
          const incoming = new Set(rows.map((row) => row.clientId));
          collected = [...collected.filter((row) => !incoming.has(row.clientId)), ...rows];
          update({});
        },
      });
      if (current()) update({ loading: false, complete: true });
    } catch (error) {
      if (current()) update({ loading: false, error });
    } finally {
      if (this.detailRuns.get(summary.key) === token) {
        const stillCurrent = current();
        this.detailRuns.delete(summary.key);
        const latest = historyWorkSummaries(this.state.items).find((item) => item.key === summary.key);
        if (stillCurrent && latest && latest.revision !== summary.revision) void this.loadDetails(latest);
      }
    }
  }

  /** Locate by visible pages, preserving the original folded aggregate focus behavior. */
  async locate(clientId: string, createdAt: string): Promise<T | null> {
    const generation = this.generation;
    const targetMs = Date.parse(createdAt);
    const tried = new Set<string>();
    while (this.active && generation === this.generation) {
      for (const item of historyViewLeaves(this.state.items)) {
        if (item.type === 'messages') {
          const found = item.messages.find((row) => row.clientId === clientId);
          if (found) return found;
        } else if (!tried.has(item.key) && targetMs >= item.summary.startedAtMs && targetMs <= item.summary.endedAtMs) {
          tried.add(item.key);
          const summary = item.summary;
          const current = () => this.active && generation === this.generation
            && historyWorkSummaries(this.state.items).some((value) => value.key === summary.key && value.revision === summary.revision
              && value.firstMessageId === summary.firstMessageId && value.lastMessageId === summary.lastMessageId);
          const cached = this.state.details.get(item.key);
          let messages = cached?.complete && cached.revision === summary.revision ? [...cached.messages] : [];
          if (!messages.length && this.networkAvailable) {
            // Search reads the bounded range without changing user expansion memory
            // or subscribing to hidden activity. Mount/collapse cannot cancel it.
            try {
              await readHistoryWorkDetails({
                readPage: (cursor) => this.transport.details(summary, cursor ?? undefined),
                isCurrent: current,
                onPage: (rows) => { messages.push(...rows); },
              });
            } catch (error) {
              if (!current()) return null;
              throw error;
            }
            if (!current()) return null;
            const details = new Map(this.state.details);
            details.set(item.key, { messages, revision: summary.revision, lastMessageId: summary.lastMessageId,
              loading: false, complete: true, error: null });
            this.publish({ details });
          }
          if (!current()) return null;
          const found = messages.find((row) => row.clientId === clientId);
          if (found) return found;
        }
      }
      if (!this.networkAvailable || !this.state.hasMore) return null;
      await this.refresh(true);
      if (this.state.error) throw this.state.error;
    }
    return null;
  }

  /** View blur/background and source resets invalidate all outstanding reads. */
  setActive(active: boolean): void {
    if (active === this.active) { if (active && !this.state.ready) void this.refresh(); return; }
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    this.active = active;
    this.generation++;
    this.cacheGeneration++;
    this.detailRuns.clear();
    this.publish({ loading: false });
    this.sendIntent();
    if (active) void this.refresh();
  }
  reset(): void {
    this.generation++;
    this.cacheGeneration++;
    this.detailRuns.clear();
    this.publish({ items: [], details: new Map(), expanded: new Set(), ready: false,
      nextCursor: null, hasMore: false, loading: false, error: null });
    this.sendIntent();
    if (this.active) void this.refresh();
  }
}
