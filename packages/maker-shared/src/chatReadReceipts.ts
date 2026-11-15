/**
 * Group read receipts (bot-group-chat.md「消息已读」): who else has read a message of mine.
 * Positions are server sequences; they stay decimal strings on the wire and BigInt here,
 * never Number.
 */
import type { BotGroupMessageReaders } from './botGroupChat';

export const MAIN_READ_KEY = 'main';

/** Per Thread, the highest position of my own messages another member (a person, or a teammate that took the execution up) has read (`thread_key` is `main` or the lowercase root ID). */
export type OthersReadEntries = ReadonlyArray<{ thread_key: string; read_seq: string }>;

export const readReceiptKey = (threadRootId?: string | null): string => threadRootId ? threadRootId.toLowerCase() : MAIN_READ_KEY;

const sequence = (value: unknown): bigint | null => typeof value === 'string' && /^\d{1,30}$/.test(value) ? BigInt(value) : null;

/** The snapshot's positions as a map, or null when the server reports no read receipts. */
export function othersReadMap(entries: OthersReadEntries | undefined): Map<string, bigint> | null {
  if (!entries) return null;
  const map = new Map<string, bigint>();
  for (const entry of entries) {
    const seq = sequence(entry?.read_seq);
    const key = typeof entry?.thread_key === 'string' ? entry.thread_key.toLowerCase() : null;
    if (key !== null && seq !== null && seq > (map.get(key) ?? -1n)) map.set(key, seq);
  }
  return map;
}

/** Whether another member has read this message: its Thread's position has reached its sequence. */
export function isReadByOthers(seq: string, threadRootId: string | null | undefined, positions: ReadonlyMap<string, bigint>): boolean {
  const value = sequence(seq);
  return value !== null && value <= (positions.get(readReceiptKey(threadRootId)) ?? 0n);
}

export interface ReadReceiptAdvance {
  /** The member who read; the frame goes to the author of what was read, never to the group. */
  readerId: string;
  conversationId: string;
  advances: Array<{ key: string; seq: bigint }>;
}

/**
 * The author's private frame when someone reads their messages: an `ephemeral` frame of kind
 * `receipt` on `actor:<author>` whose `data` is the JSON string `{ conversationId, threadRootId, readSeq }`,
 * `readSeq` being the author's own newest message in the range just read. Anything else yields null.
 */
export function parseReadReceiptFrame(frame: unknown, selfActorId: string): ReadReceiptAdvance | null {
  const value = frame as { type?: unknown; kind?: unknown; scope?: unknown; actorId?: unknown; data?: unknown } | null;
  if (value?.type !== 'ephemeral' || value.kind !== 'receipt' || value.scope !== `actor:${selfActorId}`
    || typeof value.actorId !== 'string' || typeof value.data !== 'string') return null;
  let data: { conversationId?: unknown; threadRootId?: unknown; readSeq?: unknown };
  try { data = JSON.parse(value.data); } catch { return null; }
  if (!data || typeof data !== 'object' || typeof data.conversationId !== 'string' || !data.conversationId) return null;
  if (data.threadRootId !== null && data.threadRootId !== undefined && (typeof data.threadRootId !== 'string' || !data.threadRootId)) return null;
  const read = sequence(data.readSeq);
  if (read === null) return null;
  return { readerId: value.actorId, conversationId: data.conversationId, advances: [{ key: readReceiptKey(data.threadRootId as string | null | undefined), seq: read }] };
}

/**
 * Receipts that arrived after the snapshot in use, layered on its positions. A position is the
 * maximum over current members, so it can fall when someone leaves: every new snapshot replaces
 * the layer, and the layer only ever holds what arrived since.
 */
export function createOthersReadOverlay() {
  interface Layer { base: OthersReadEntries | undefined; added: Map<string, bigint>; unread: Map<string, { key: string; seq: bigint }>; at: number }
  const layers = new Map<string, Layer>();
  const layer = (room: string, base: OthersReadEntries | undefined): Layer => {
    const known = layers.get(room);
    if (known && known.base === base) return known;
    const fresh: Layer = { base, added: new Map(), unread: new Map(), at: Date.now() };
    layers.set(room, fresh);
    return fresh;
  };
  return {
    /**
     * The positions to show for this snapshot, or null when the server keeps none. `own` are the
     * sender's own loaded messages; the ones still unread are remembered so a later receipt can
     * tell whether it changed any of them. Reads of the same room (the main timeline, an older page,
     * a Thread) add to what earlier ones remembered instead of replacing it; the next snapshot
     * starts the list over.
     */
    positions(room: string, base: OthersReadEntries | undefined, own: ReadonlyArray<{ seq: string; threadRootId?: string | null }> = []): Map<string, bigint> | null {
      const map = othersReadMap(base);
      if (!map) { layers.delete(room); return null; }
      const current = layer(room, base);
      for (const [key, seq] of current.added) if (seq > (map.get(key) ?? 0n)) map.set(key, seq);
      for (const message of own) {
        const seq = sequence(message.seq);
        const key = readReceiptKey(message.threadRootId);
        if (seq !== null && seq > (map.get(key) ?? 0n)) current.unread.set(`${key}:${seq}`, { key, seq });
      }
      return map;
    },
    /**
     * Apply one receipt to the layer of the snapshot last shown. Returns true when it read
     * a remembered own message that was unread, so the view is worth refreshing.
     */
    advance(room: string, advances: ReadReceiptAdvance['advances']): boolean {
      const current = layers.get(room);
      if (!current) return false;
      for (const { key, seq } of advances) if (seq > (current.added.get(key) ?? 0n)) current.added.set(key, seq);
      const base = othersReadMap(current.base)!;
      const reached = (message: { key: string; seq: bigint }) => message.seq <= maxOf(base.get(message.key), current.added.get(message.key));
      let read = false;
      for (const [id, message] of current.unread) if (reached(message)) { current.unread.delete(id); read = true; }
      return read;
    },
    /**
     * Whether the snapshot behind this room's positions is old while some of my messages in it are
     * still unread. A receipt can be lost, and the snapshot is what makes up for it, so a reader of
     * such a room should read it again.
     */
    stale(room: string, olderThanMs: number): boolean {
      const current = layers.get(room);
      return !!current && current.unread.size > 0 && Date.now() - current.at >= olderThanMs;
    },
    forget(room: string) { layers.delete(room); },
    clear() { layers.clear(); },
  };
}

const maxOf = (a: bigint | undefined, b: bigint | undefined): bigint => (a ?? 0n) > (b ?? 0n) ? (a ?? 0n) : (b ?? 0n);

/**
 * What `GET /conversations/:id/messages/:id/readers` answers. `readCount` and `listed` come from servers
 * that give only the counts in a very large group; older ones list everyone, and `unread` (never shown) is ignored.
 */
export interface MessageReadersReply {
  messageId: string; eligibleCount: number;
  readCount?: number; listed?: boolean;
  readers: Array<{ actorId: string; readAt: string | null }>;
}

/**
 * The read list a client shows, as the server gives it: people and teammates alike (a teammate reads
 * a message when its computer takes the execution up), in the server's order. Former members keep their
 * group name, and a time that does not parse (a teammate's read has none) is dropped rather than shown.
 */
export function projectMessageReaders(
  reply: MessageReadersReply,
  members: ReadonlyArray<{ id: string; kind: string; state: string }>,
  nameOf: (actorId: string) => string | null,
): BotGroupMessageReaders {
  const memberOf = (actorId: string) => members.find(member => member.id === actorId);
  const readers = reply.readers.map(({ actorId, readAt }) => {
    const at = readAt === null ? NaN : Date.parse(readAt);
    return { actorId, name: nameOf(actorId), readAt: Number.isFinite(at) ? at : null, formerMember: memberOf(actorId)?.state !== 'joined' };
  });
  const listed = reply.listed !== false;
  return {
    messageId: reply.messageId,
    eligibleCount: reply.eligibleCount,
    readCount: listed ? readers.length : Math.min(reply.readCount ?? 0, reply.eligibleCount),
    listed,
    readers: listed ? readers : [],
  };
}
