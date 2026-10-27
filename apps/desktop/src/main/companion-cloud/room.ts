/** Reading a companion's 1:1 room: the conversation layer every device can see. */
import type { CompanionTranscriptMessage, CompanionTranscriptPage } from '../../shared/companionCloud.js';
import type { CompanionApi } from './types.js';

export interface CompanionRoomMessage {
  id: string;
  seq: string;
  authorId: string;
  author?: { kind?: string };
  origin?: string;
  deleted?: boolean;
  threadRootId?: string | null;
  createdAt: string;
  content?: Array<{ type?: string; text?: string; caption?: string; fallback?: string; mediaId?: string }>;
}

const PAGE = 100;

/**
 * Visible user/assistant text of a room message, with its files; null for system rows, threads
 * and deletions. Files appear as attachments, not as text.
 */
export function roomMessageView(message: CompanionRoomMessage, botActorId: string): CompanionTranscriptMessage | null {
  if (message.deleted || message.origin === 'system' || message.threadRootId) return null;
  const blocks = message.content ?? [];
  const attachments = blocks.flatMap(block => block.type === 'media' && typeof block.mediaId === 'string' && block.mediaId
    ? [{ mediaId: block.mediaId, name: (block.caption ?? '').trim() || '文件' }] : []);
  const text = blocks.map(block => block.type === 'text' ? block.text ?? ''
    : block.type === 'media' ? (block.mediaId ? '' : `[附件: ${block.caption ?? '文件'}]`) : block.fallback ?? '').filter(Boolean).join('\n').trim();
  const createdAt = Date.parse(message.createdAt);
  if ((!text && !attachments.length) || !Number.isFinite(createdAt)) return null;
  return { id: message.id, seq: message.seq, role: message.authorId === botActorId ? 'assistant' : 'user', text, createdAt,
    ...(attachments.length ? { attachments } : {}) };
}

export async function readRoomPage(api: CompanionApi, roomId: string, before?: string): Promise<CompanionRoomMessage[]> {
  const query = new URLSearchParams({ limit: String(PAGE) });
  if (before) query.set('before', before);
  const page = await api<CompanionRoomMessage[]>(`/conversations/${roomId}/messages?${query}`);
  return Array.isArray(page) ? page : [];
}

/** One page of the room for display, oldest first. */
export async function readTranscriptPage(api: CompanionApi, roomId: string, botActorId: string, before?: string): Promise<CompanionTranscriptPage> {
  const page = await readRoomPage(api, roomId, before);
  const messages = page.flatMap(message => roomMessageView(message, botActorId) ?? []).reverse();
  const oldest = page.reduce<string | undefined>((min, m) => min === undefined || BigInt(m.seq) < BigInt(min) ? m.seq : min, undefined);
  return { messages, ...(page.length === PAGE && oldest ? { nextBefore: oldest } : {}) };
}

/** Room pages read at most for the whole conversation (100 messages each). */
export const ROOM_HISTORY_MAX_PAGES = 500;

/** Message time first: history uploaded later (backfill, merges) arrives after newer messages. */
export function byMessageTime(a: CompanionTranscriptMessage, b: CompanionTranscriptMessage): number {
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  const left = BigInt(a.seq); const right = BigInt(b.seq);
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Every visible message of the room (bounded by `maxPages`), in message-time order. */
/**
 * The room's messages in message-time order. A view reads at most `ROOM_HISTORY_MAX_PAGES`
 * pages; `complete` (a take-over or a merge, which treat the result as the whole history) reads
 * to the very first page and fails rather than return part of it.
 */
export async function readAllRoomMessages(api: CompanionApi, roomId: string, botActorId: string,
  options: { complete?: boolean } = {}) {
  const collected: CompanionTranscriptMessage[] = [];
  let before: string | undefined;
  for (let page = 0; options.complete || page < ROOM_HISTORY_MAX_PAGES; page += 1) {
    const result = await readTranscriptPage(api, roomId, botActorId, before);
    collected.push(...result.messages);
    if (!result.nextBefore) break;
    // Paging must move to older messages; a cursor that does not would read forever.
    if (before !== undefined && BigInt(result.nextBefore) >= BigInt(before)) throw new Error('ROOM_HISTORY_STALLED');
    before = result.nextBefore;
  }
  return collected.sort(byMessageTime);
}

const TRANSCRIPT_PAGE = 100;

/**
 * One display page of the whole conversation in message-time order: the latest messages older
 * than `before` (a message time in ms). Messages sharing the page's oldest time stay together.
 */
export function transcriptPageOf(messages: readonly CompanionTranscriptMessage[], before?: number): CompanionTranscriptPage {
  let end = messages.length;
  if (before !== undefined) while (end > 0 && messages[end - 1]!.createdAt >= before) end -= 1;
  let start = Math.max(0, end - TRANSCRIPT_PAGE);
  while (start > 0 && messages[start - 1]!.createdAt === messages[start]!.createdAt) start -= 1;
  const page = messages.slice(start, end);
  return { messages: page, ...(start > 0 && page.length ? { nextBefore: String(page[0]!.createdAt) } : {}) };
}
