/**
 * Thread previews and main-chat shares for the Chat Server adapter.
 *
 * Previews: the room snapshot already carries the newest 100 messages of every thread,
 * so active threads cost no extra request. Only a root whose newest replies are older
 * than that window reads a bounded page of its own, cached until its reply count changes
 * or one of those replies is edited or deleted.
 *
 * Shares: a share card only names a reply. Its author, text and files always come from
 * the server's copy of that reply, which the server checks against this reader's access.
 */
import { BOT_GROUP_THREAD_PREVIEW_REPLIES, BOT_GROUP_THREAD_PREVIEW_RESPONDERS, readBotGroupThreadShareCard } from '../../shared/botGroupChat.js';

export interface ThreadMessage {
  id: string; seq: string; authorId: string; deleted: boolean; threadRootId: string | null;
  origin?: string; replyCount?: number; revision?: number;
  content: Array<{ type: string; text?: string; fallback?: string; namespace?: string; schemaRevision?: number; data?: Record<string, unknown>; mediaId?: string; caption?: string }>;
}

/**
 * Concurrent reads per fill (a refresh fills previews and share sources separately); the rest
 * wait for a slot rather than fan out. Reads are deduplicated per item while in flight, and a
 * fill only covers the open page, so this bounds a refresh without a projection-wide queue.
 */
const READ_CONCURRENCY = 6;
/** A failed read backs off from this delay, doubling, and retries on its own a few times. */
const RETRY_MS = 30_000;
const RETRY_ATTEMPTS = 5;
/** Deleted replies still occupy a page, so read a little more than the preview needs. */
const FALLBACK_PAGE = 6;
/** A thread whose newest replies are mostly deleted reads back at most this far. */
const FALLBACK_PAGES = 4;
const SNAPSHOT_WINDOW = 100;

async function eachLimited<T>(items: readonly T[], run: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, items.length) }, async () => {
    while (next < items.length) await run(items[next++]!);
  }));
}

/**
 * Cache lookups never wait for the network: a missing entry is filled in the background
 * and `filled(roomId)` asks for one more read once anything new is cached, so a room with
 * many quiet threads still opens at once and shows the counts first.
 */
export function createThreadProjection<M extends ThreadMessage>(io: {
  /** Newest-first page of one thread, optionally before a sequence. */
  threadPage(roomId: string, rootId: string, limit: number, before?: string): Promise<M[]>;
  /** One message as this reader may see it; `null` when the server says it is not visible. */
  message(roomId: string, messageId: string): Promise<M | null>;
  filled(roomId: string): void;
}) {
  const previews = new Map<string, { replyCount: number; replies: M[] }>();
  const sources = new Map<string, M | null>();
  const retryAt = new Map<string, number>();
  const inFlight = new Set<string>();
  const settling = new Set<Promise<void>>();
  const failures = new Map<string, number>();
  // One wake-up per room, aimed at the earliest pending retry; after firing it re-arms for
  // the next one, so a quiet room still recovers every read that failed.
  const pendingRetries = new Map<string, Map<string, number>>();
  const retryTimers = new Map<string, { at: number; timer: ReturnType<typeof setTimeout> }>();
  function armRetry(roomId: string) {
    const pending = pendingRetries.get(roomId);
    const armed = retryTimers.get(roomId);
    const at = pending?.size ? Math.min(...pending.values()) : undefined;
    if (armed && armed.at === at) return;
    if (armed) { clearTimeout(armed.timer); retryTimers.delete(roomId); }
    if (at === undefined) return;
    const timer = setTimeout(() => {
      retryTimers.delete(roomId);
      let due = false;
      for (const [cacheKey, deadline] of pending!) if (deadline <= Date.now()) { pending!.delete(cacheKey); due = true; }
      if (!pending!.size) pendingRetries.delete(roomId);
      if (due) io.filled(roomId);
      armRetry(roomId);
    }, Math.max(0, at - Date.now()));
    timer.unref?.();
    retryTimers.set(roomId, { at, timer });
  }
  function scheduleRetry(roomId: string, cacheKey: string) {
    const attempt = (failures.get(cacheKey) ?? 0) + 1;
    failures.set(cacheKey, attempt);
    // After the last automatic attempt the next push or reopening retries at once.
    if (attempt > RETRY_ATTEMPTS) { retryAt.delete(cacheKey); return; }
    const at = Date.now() + RETRY_MS * 2 ** (attempt - 1);
    retryAt.set(cacheKey, at);
    const pending = pendingRetries.get(roomId) ?? new Map<string, number>();
    pending.set(cacheKey, at); pendingRetries.set(roomId, pending);
    armRetry(roomId);
  }
  function settledRetry(roomId: string, cacheKey: string) {
    retryAt.delete(cacheKey); failures.delete(cacheKey);
    if (pendingRetries.get(roomId)?.delete(cacheKey)) armRetry(roomId);
  }
  function cancelRetries() {
    for (const { timer } of retryTimers.values()) clearTimeout(timer);
    retryTimers.clear(); pendingRetries.clear(); failures.clear();
  }

  // A read that was in flight across reset()/invalidate() may carry the old copy. Edits only
  // raise their own room, so a busy group never discards another group's reads; the sum of
  // both counters only grows, which keeps a room's version ordered.
  let epoch = 0;
  const roomGenerations = new Map<string, number>();
  const generation = (roomId: string) => epoch + (roomGenerations.get(roomId) ?? 0);
  const key = (roomId: string, id: string) => `${roomId}:${id}`;
  const waiting = (cacheKey: string) => inFlight.has(cacheKey) || (retryAt.get(cacheKey) ?? 0) > Date.now();

  function fill<T>(roomId: string, items: Array<{ cacheKey: string; item: T }>, read: (item: T) => Promise<(() => void) | null>) {
    if (!items.length) return;
    for (const { cacheKey } of items) inFlight.add(cacheKey);
    const started = generation(roomId);
    const task = (async () => {
      let wrote = false;
      await eachLimited(items, async ({ cacheKey, item }) => {
        // A read that outlived a reset or invalidation, whether it succeeded or failed, is
        // dropped, and the reader is asked to read again: the refresh in between skipped it.
        try {
          const store = await read(item);
          settledRetry(roomId, cacheKey);
          if (store) { if (generation(roomId) === started) store(); wrote = true; }
        } catch { if (generation(roomId) === started) scheduleRetry(roomId, cacheKey); else wrote = true; }
        finally { inFlight.delete(cacheKey); }
      });
      if (wrote) io.filled(roomId);
    })();
    settling.add(task);
    void task.finally(() => settling.delete(task));
  }

  return {
    /**
     * Newest replies of every root in `page` that are known now, chronological. `snapshot`
     * is the server's newest-first window across the main chat and all threads.
     */
    previews(roomId: string, page: readonly M[], snapshot: readonly M[]): Map<string, { replies: M[]; responders: M[] }> {
      const complete = snapshot.length < SNAPSHOT_WINDOW;
      const inWindow = new Map<string, M[]>();
      for (const message of snapshot) {
        if (!message.threadRootId || message.deleted) continue;
        const list = inWindow.get(message.threadRootId) ?? [];
        list.push(message); inWindow.set(message.threadRootId, list);
      }
      const result = new Map<string, M[]>();
      const missing: Array<{ cacheKey: string; item: M }> = [];
      const windowStart = snapshot.reduce<bigint | null>((min, message) => min === null || BigInt(message.seq) < min ? BigInt(message.seq) : min, null);
      for (const root of page) {
        const count = root.replyCount ?? 0;
        if (root.threadRootId || count <= 0) continue;
        const found = inWindow.get(root.id) ?? [];
        const cacheKey = key(roomId, root.id);
        const cached = previews.get(cacheKey);
        // The window is a suffix of the room's sequence, so what it holds is the newest.
        if (complete || found.length >= Math.min(count, BOT_GROUP_THREAD_PREVIEW_REPLIES)) result.set(root.id, found);
        // A same count can hide a new reply beside a deleted old one: what the window holds
        // comes first, and the cached page only fills in below it.
        else if (cached?.replyCount === count) result.set(root.id, [...found,
          ...cached.replies.filter(reply => windowStart === null || BigInt(reply.seq) < windowStart)]);
        else if (!waiting(cacheKey)) missing.push({ cacheKey, item: root });
      }
      fill(roomId, missing, async root => {
        const wanted = Math.min(root.replyCount ?? 0, BOT_GROUP_THREAD_PREVIEW_REPLIES);
        const replies: M[] = [];
        let before: string | undefined;
        for (let pages = 0; pages < FALLBACK_PAGES && replies.length < wanted; pages += 1) {
          const batch = await io.threadPage(roomId, root.id, FALLBACK_PAGE, before);
          replies.push(...batch.filter(message => !message.deleted));
          if (batch.length < FALLBACK_PAGE) break;
          before = batch.reduce((min, message) => BigInt(message.seq) < BigInt(min) ? message.seq : min, batch[0]!.seq);
        }
        return () => previews.set(key(roomId, root.id), { replyCount: root.replyCount ?? 0, replies });
      });
      // Keep the existing read budget: choose distinct authors from all rows already
      // fetched, without reading older pages just to fill the avatar slots.
      return new Map([...result].map(([rootId, replies]) => {
        const seen = new Set<string>();
        const responders = replies.filter(reply => {
          if (seen.has(reply.authorId)) return false;
          seen.add(reply.authorId);
          return true;
        }).slice(0, BOT_GROUP_THREAD_PREVIEW_RESPONDERS).reverse();
        return [rootId, { replies: replies.slice(0, BOT_GROUP_THREAD_PREVIEW_REPLIES).reverse(), responders }];
      }));
    },
    /**
     * The replies named by share cards in `page`: a message, `null` when this reader may
     * not see it, or absent while it is still being read.
     */
    shareSources(roomId: string, page: readonly M[], known: readonly M[]): Map<string, M | null> {
      return this.sources(roomId, page.flatMap(message => readBotGroupThreadShareCard(message)?.messageId ?? []), known);
    },
    /** The same lookup by reply ID, for shares the reader already has on screen. */
    sources(roomId: string, messageIds: readonly string[], known: readonly M[]): Map<string, M | null> {
      const fresh = new Map(known.map(message => [message.id, message]));
      const result = new Map<string, M | null>();
      const missing = new Map<string, { cacheKey: string; item: string }>();
      for (const messageId of messageIds) {
        if (result.has(messageId)) continue;
        const cacheKey = key(roomId, messageId);
        if (fresh.has(messageId)) result.set(messageId, fresh.get(messageId)!);
        else if (sources.has(cacheKey)) result.set(messageId, sources.get(cacheKey)!);
        else if (!waiting(cacheKey)) missing.set(messageId, { cacheKey, item: messageId });
      }
      fill(roomId, [...missing.values()], async messageId => {
        const value = await io.message(roomId, messageId);
        return () => sources.set(key(roomId, messageId), value);
      });
      return result;
    },
    /** An edited or deleted message may be a cached reply or share source. */
    invalidate(roomId: string, messageId: string) {
      roomGenerations.set(roomId, (roomGenerations.get(roomId) ?? 0) + 1);
      sources.delete(key(roomId, messageId));
      // Failed preview pages have no cached replies to identify their root. Invalidate
      // their backoff with this room generation too; other rooms keep their deadlines.
      for (const cacheKey of failures.keys()) if (cacheKey.startsWith(`${roomId}:`)) settledRetry(roomId, cacheKey);
      for (const [cacheKey, entry] of previews)
        if (cacheKey.startsWith(`${roomId}:`) && entry.replies.some(reply => reply.id === messageId)) previews.delete(cacheKey);
    },
    /** Pushes may have been missed while disconnected. */
    reset() { epoch += 1; previews.clear(); sources.clear(); retryAt.clear(); cancelRetries(); },
    /** The adapter is gone (account switch or quit): no wake-up may outlive it. */
    dispose() { epoch += 1; cancelRetries(); },
    /** Raised by every reset and by invalidations in this room; views checked at an older one may be stale. */
    version(roomId: string) { return generation(roomId); },
    /** Tests: wait for background fills started so far. */
    async settled() { while (settling.size) await Promise.all([...settling]); },
  };
}

/** A reply that can stand for itself in the main chat. */
export function isShareableThreadReply(message: ThreadMessage): boolean {
  return !!message.threadRootId && !message.deleted && message.origin !== 'system'
    && !message.content.some(block => block.namespace === 'cindy.group-notice' || block.namespace === 'cindy.local-history');
}

const THREAD_PREVIEW_TEXT_MAX = 280;

/** Reply text for a one-line preview; files are listed separately. */
export function threadPreviewText(message: ThreadMessage): string {
  const text = message.content.flatMap(block => block.type === 'media' ? [] : [block.text ?? block.fallback ?? '']).join(' ')
    .replace(/\s+/g, ' ').trim();
  if (text.length <= THREAD_PREVIEW_TEXT_MAX) return text;
  // Never split a surrogate pair (emoji and other astral characters are two UTF-16 units).
  const high = text.charCodeAt(THREAD_PREVIEW_TEXT_MAX - 1);
  return text.slice(0, high >= 0xd800 && high <= 0xdbff ? THREAD_PREVIEW_TEXT_MAX - 1 : THREAD_PREVIEW_TEXT_MAX);
}

export function threadPreviewAttachments(message: ThreadMessage, attachmentName: (block: ThreadMessage['content'][number]) => string) {
  return message.content.flatMap(block => block.type === 'media' && block.mediaId ? [{
    name: attachmentName(block),
    category: /\.(png|jpe?g|gif|webp|heic|heif|bmp|svg)$/i.test(block.caption ?? '') ? 'image' as const : 'file' as const,
  }] : []);
}
