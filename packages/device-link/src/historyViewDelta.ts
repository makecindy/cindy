import type { InvokePayload } from "./protocol.js";
import { messageRecord } from "./sessionMessageReuse.js";

/**
 * history-view-delta-v1: a latest-page `local-db:messages:view` read that names the page
 * this client already holds from the same Host.
 *
 * - The request adds `historyDelta: { version: 1, base? }` to its options. `base` is the
 *   token of the last latest page this client decoded for the same peer, task and options.
 * - A supporting Host answers with an ordinary page plus `historyDelta: { version: 1,
 *   token?, base?, revisionSuffix? }`. When it still knows `base`, each run of items whose
 *   content is unchanged since that page, in the base page's order, becomes one
 *   `{ type: "same", from, count }` (indexes into the base page). Outline revisions end in a
 *   page-wide suffix that changes on every database write; a `same` item carries the base
 *   page's suffix, replaced here by this page's `revisionSuffix`.
 * - This client restores every `same` item from its own copy of the base page before the
 *   result reaches a caller, so callers always see the complete page a full read returns.
 *   Any doubt (unknown base, missing item, suffix mismatch) throws
 *   {@link HistoryViewDeltaMiss}; the caller then repeats the read once without a base.
 *
 * The suffix sits on exactly the summaries the Host reader suffixes (`historyWorkSummaries`
 * in maker-shared): each leaf work item's summary and its preview, and a message item's
 * deferred range, at the top level or inside a parent's children. Parent summaries and
 * message rows are never touched.
 *
 * An old Host ignores the option and returns a plain page; an old client never sends it,
 * so the Host never sends `same`. Older-page reads (`before`) never use a base.
 */
export const HISTORY_VIEW_DELTA_VERSION = 1;
export const HISTORY_VIEW_DELTA_SAME = "same";
const CHANNEL = "local-db:messages:view";
const MAX_TOKEN_CHARS = 64;
const MAX_ENTRIES = 16;
/** UTF-16 code units, about 8 MB; one page is bounded by the Host's 1 MiB page budget. */
const MAX_CHARS = 4 * 1024 * 1024;
const MAX_PAGE_CHARS = 2 * 1024 * 1024;

export interface HistoryViewDeltaOptions {
  version: typeof HISTORY_VIEW_DELTA_VERSION;
  base?: string;
}

export interface HistoryViewDeltaInfo {
  version: typeof HISTORY_VIEW_DELTA_VERSION;
  /** Names this page; absent when the Host will not accept it as a later base. */
  token?: string;
  /** The page that `same` items refer to; always the request's base. */
  base?: string;
  /** Outline revision suffix of this page, when its work revisions carry one. */
  revisionSuffix?: string;
}

/** Restoring a delta needed something this client cannot prove; read the full page. */
export class HistoryViewDeltaMiss extends Error {
  constructor(reason: string) {
    super(`history view delta miss: ${reason}`);
    this.name = "HistoryViewDeltaMiss";
  }
}

export function isHistoryViewDeltaMiss(error: unknown): error is HistoryViewDeltaMiss {
  return error instanceof HistoryViewDeltaMiss;
}

/** Host side: the request's opt-in, or null when the read must stay an ordinary page. */
export function parseHistoryViewDeltaOptions(options: unknown): HistoryViewDeltaOptions | null {
  if (!messageRecord(options) || options.before != null) return null;
  const value = options.historyDelta;
  if (!messageRecord(value) || value.version !== HISTORY_VIEW_DELTA_VERSION) return null;
  return typeof value.base === "string" && value.base.length > 0 && value.base.length <= MAX_TOKEN_CHARS
    ? { version: HISTORY_VIEW_DELTA_VERSION, base: value.base }
    : { version: HISTORY_VIEW_DELTA_VERSION };
}

type Swap = (revision: unknown) => string;

function swapSummary(summary: unknown, swap: Swap): unknown {
  if (!messageRecord(summary)) throw new HistoryViewDeltaMiss("work item without summary");
  const next: Record<string, unknown> = { ...summary, revision: swap(summary.revision) };
  if (summary.preview !== undefined) next.preview = swapSummary(summary.preview, swap);
  return next;
}

/** Rewrite the revision of every suffixed summary in one item; other fields are shared. */
function swapItem(item: unknown, swap: Swap): unknown {
  if (!messageRecord(item)) return item;
  if (item.type === "work" && Array.isArray(item.children)) {
    return { ...item, children: item.children.map((child) => swapItem(child, swap)) };
  }
  if (item.type === "work") return { ...item, summary: swapSummary(item.summary, swap) };
  if (item.type === "messages" && item.deferred !== undefined) return { ...item, deferred: swapSummary(item.deferred, swap) };
  return item;
}

/** Remove this page's suffix; a suffixed summary without it cannot be a base. */
export function stripHistoryRevisionSuffix(item: unknown, suffix: string | undefined): unknown {
  if (!suffix) return item;
  return swapItem(item, (revision) => {
    if (typeof revision !== "string" || !revision.endsWith(suffix)) throw new HistoryViewDeltaMiss("revision without page suffix");
    return revision.slice(0, revision.length - suffix.length);
  });
}

export function appendHistoryRevisionSuffix(item: unknown, suffix: string | undefined): unknown {
  if (!suffix) return item;
  return swapItem(item, (revision) => {
    if (typeof revision !== "string") throw new HistoryViewDeltaMiss("summary without revision");
    return revision + suffix;
  });
}

interface StoredItem {
  key: string;
  /** JSON of the item as the caller received it, without the page suffix. */
  json: string;
}

interface Entry {
  peer: string;
  session: string;
  token: string;
  suffixed: boolean;
  /** In page order; `same` runs index into it. */
  items: readonly StoredItem[];
  chars: number;
}

/** Controller side: bounded, in-memory only, cleared with the client. */
export class HistoryViewDeltaCache {
  private entries = new Map<string, Entry>();
  private chars = 0;
  private generation = 0;

  clear(): void {
    this.entries.clear();
    this.chars = 0;
    this.generation++;
  }

  /** Same invalidation as message body reuse: a cleared or removed task drops its pages. */
  receive(peer: string, channel: string, payload: unknown): void {
    if (!messageRecord(payload) || typeof payload.sessionId !== "string") return;
    const patch = messageRecord(payload.patch) ? payload.patch : null;
    if (channel !== "local-db:messages:deleted" && channel !== "local-db:session:error-persisted"
      && !(channel === "local-db:sessions:patched" && patch
        && ("clearedAt" in patch || patch.status === "deleted" || patch.status === "archived"))) return;
    for (const [key, entry] of this.entries) {
      if (entry.peer === peer && entry.session === payload.sessionId) this.delete(key);
    }
  }

  private delete(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.chars -= entry.chars;
    this.entries.delete(key);
  }

  private store(key: string, entry: Entry): void {
    this.delete(key);
    if (entry.chars > MAX_PAGE_CHARS) return;
    this.entries.set(key, entry);
    this.chars += entry.chars;
    while (this.entries.size > MAX_ENTRIES || this.chars > MAX_CHARS) {
      this.delete(this.entries.keys().next().value!);
    }
  }

  /**
   * Prepare one read. `full` omits the base (the retry after a miss) but still opts in,
   * so the Host can name the fresh page.
   */
  prepare(
    peer: string,
    payload: InvokePayload,
    full = false,
  ): { payload: InvokePayload; decode(value: unknown): unknown } {
    const session = payload.args?.[0];
    const options = payload.args?.[1];
    if (payload.channel !== CHANNEL || typeof session !== "string"
      || (options != null && !messageRecord(options)) || (options as { before?: unknown } | undefined)?.before != null) {
      return { payload, decode: (value) => value };
    }
    const { messageBodies: _bodies, historyDelta: _delta, ...rest } = (options ?? {}) as Record<string, unknown>;
    // Work lines only decorate running items, and the Host may not apply them (no session
    // subscription yet, as for a prefetch). Unchanged items are identical either way.
    const key = JSON.stringify([peer, session, rest.lazyDetails === true]);
    // Fixed at dispatch: a concurrent read may replace the entry before this one returns.
    const snapshot = full ? undefined : this.entries.get(key);
    const generation = this.generation;
    const args = [...payload.args];
    // With a base, unchanged rows never travel, so advertising known bodies (up to 256
    // digests, ~28 kB per read) costs more upstream than it saves. Rows that do arrive
    // are still remembered by the body cache for later reads without a base.
    args[1] = {
      ...(snapshot ? rest : (options ?? {})),
      historyDelta: { version: HISTORY_VIEW_DELTA_VERSION, ...(snapshot ? { base: snapshot.token } : {}) },
    };
    return {
      payload: { ...payload, args },
      decode: (value) => {
        if (!messageRecord(value) || !Array.isArray(value.items)) return value;
        const { historyDelta: rawDelta, ...page } = value;
        const delta = messageRecord(rawDelta) && rawDelta.version === HISTORY_VIEW_DELTA_VERSION
          ? rawDelta as unknown as HistoryViewDeltaInfo : null;
        const suffix = typeof delta?.revisionSuffix === "string" && delta.revisionSuffix ? delta.revisionSuffix : undefined;
        // A `same` run reuses its stored entries untouched, with this page's suffix.
        const kept: Array<StoredItem | null> = [];
        const items: unknown[] = [];
        for (const item of value.items) {
          if (!messageRecord(item) || item.type !== HISTORY_VIEW_DELTA_SAME) {
            kept.push(null);
            items.push(item);
            continue;
          }
          if (!delta?.base || !snapshot || delta.base !== snapshot.token) throw new HistoryViewDeltaMiss("unknown base");
          if (snapshot.suffixed !== !!suffix) throw new HistoryViewDeltaMiss("revision suffix changed shape");
          const from = item.from, count = item.count;
          if (!Number.isSafeInteger(from) || !Number.isSafeInteger(count) || (from as number) < 0 || (count as number) < 1
            || (from as number) + (count as number) > snapshot.items.length) throw new HistoryViewDeltaMiss("missing base item");
          for (const stored of snapshot.items.slice(from as number, (from as number) + (count as number))) {
            kept.push(stored);
            items.push(appendHistoryRevisionSuffix(JSON.parse(stored.json), suffix));
          }
        }
        const restored = { ...page, items };
        if (delta && typeof delta.token === "string" && delta.token.length <= MAX_TOKEN_CHARS
          && generation === this.generation) {
          const seen = new Set<string>();
          const stored: StoredItem[] = [];
          let chars = 0;
          try {
            items.forEach((item, index) => {
              const itemKey = messageRecord(item) && typeof item.key === "string" ? item.key : null;
              // Duplicate keys cannot name one item; such a page is never a base.
              if (itemKey === null || seen.has(itemKey)) throw new HistoryViewDeltaMiss("page cannot be a base");
              seen.add(itemKey);
              const entry = kept[index]
                ?? { key: itemKey, json: JSON.stringify(stripHistoryRevisionSuffix(item, suffix)) };
              stored.push(entry);
              chars += entry.json.length;
            });
          } catch (error) {
            if (!isHistoryViewDeltaMiss(error)) throw error;
            // The page itself is complete; it just cannot serve as a later base.
            this.delete(key);
            return restored;
          }
          this.store(key, { peer, session, token: delta.token, suffixed: !!suffix, items: stored, chars });
        }
        return restored;
      },
    };
  }
}
