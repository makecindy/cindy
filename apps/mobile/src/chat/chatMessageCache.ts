import { getMobileAuthOwner, isMobileAuthOwnerCurrent } from '@/auth/authOwnerGeneration';
import { clearConversationDisk, historyDiskAuthority, readConversationDisk, writeConversationDisk } from '@/session/remoteHistoryDiskCache';
import type { ChatActor, ChatPage } from './chatServerClient';

export interface CachedChatPage { version: 1; page: ChatPage; self: string; actors: ChatActor[] }
const device = 'chat-server';
let owner = getMobileAuthOwner();
const memory = new Map<string, CachedChatPage>();
const revisions = new Map<string, number>();
const invalidated = new Set<(roomId: string) => void>();
/** Serializing a whole page belongs after the screen has drawn it, and once per burst: a read
 * and the thread summaries that follow it replace the same page within a moment. */
const DISK_WRITE_DELAY_MS = 400;
type Authority = ReturnType<typeof historyDiskAuthority>;
const queued = new Map<string, { value: CachedChatPage; authority: Authority; settle: Array<(saved: boolean) => void>; timer: ReturnType<typeof setTimeout> }>();
function writeQueued(key: string) {
  const entry = queued.get(key);
  if (!entry) return;
  queued.delete(key); clearTimeout(entry.timer);
  // The newest page speaks for every page it replaced while waiting.
  void writeConversationDisk(entry.authority, entry.value).catch(() => false)
    .then(saved => { for (const settle of entry.settle) settle(saved); });
}
/** Commit pages still waiting for their turn; the screen calls this when it stops being shown. */
export function flushChatMessageCache(): void { for (const key of [...queued.keys()]) writeQueued(key); }
export function subscribeChatInvalidation(listener: (roomId: string) => void) {
  invalidated.add(listener); return () => { invalidated.delete(listener); };
}
function own() {
  if (!isMobileAuthOwnerCurrent(owner)) { owner = getMobileAuthOwner(); memory.clear(); revisions.clear(); }
}
const keyFor = (roomId: string, threadRootId?: string) => JSON.stringify([roomId, threadRootId ?? null]);
function valid(value: unknown): value is CachedChatPage {
  const entry = value as CachedChatPage | null;
  return entry?.version === 1 && typeof entry.self === 'string' && Array.isArray(entry.actors)
    && entry.actors.every(actor => actor && typeof actor.id === 'string')
    && typeof entry.page?.snapshot?.room?.id === 'string' && typeof entry.page.snapshot.room.name === 'string'
    && Array.isArray(entry.page.snapshot.members) && entry.page.snapshot.members.every(member => member
      && typeof member.id === 'string' && typeof member.name === 'string' && typeof member.state === 'string')
    && (entry.page.before === null || typeof entry.page.before === 'string')
    && Array.isArray(entry.page.messages) && entry.page.messages.every(message => message
      && typeof message.id === 'string' && /^\d{1,30}$/.test(message.seq) && typeof message.authorId === 'string'
      && typeof message.author?.kind === 'string' && typeof message.author.name === 'string'
      && Array.isArray(message.content) && message.content.every(block => block && typeof block.type === 'string'));
}
export function peekChatMessages(roomId: string, threadRootId?: string): CachedChatPage | null {
  own(); return owner.accountId ? memory.get(keyFor(roomId, threadRootId)) ?? null : null;
}
export async function readChatMessages(roomId: string, threadRootId?: string): Promise<CachedChatPage | null> {
  own();
  const key = keyFor(roomId, threadRootId);
  if (memory.has(key)) return memory.get(key)!;
  const revision = revisions.get(key) ?? 0;
  revisions.set(key, revision);
  const authority = historyDiskAuthority(device, key);
  const value = await readConversationDisk(authority, valid);
  if (!authority.current() || revision !== (revisions.get(key) ?? 0)) return null;
  if (value && value.page.snapshot.room.id === roomId && value.page.threadRootId === threadRootId) memory.set(key, value);
  return peekChatMessages(roomId, threadRootId);
}
/** `afterPaint` is for a screen refreshing what it shows: memory is updated now, the disk a
 * moment later and once per burst. Callers that act on the saved copy (the outbox) write now. */
export async function cacheChatMessages(roomId: string, value: CachedChatPage, afterPaint = false): Promise<boolean> {
  own();
  const key = keyFor(roomId, value.page.threadRootId);
  const authority = historyDiskAuthority(device, key);
  if (!authority.current()) return false;
  revisions.set(key, (revisions.get(key) ?? 0) + 1);
  memory.set(key, value);
  return new Promise<boolean>(resolve => {
    const waiting = queued.get(key);
    if (waiting) { waiting.value = value; waiting.authority = authority; waiting.settle.push(resolve); }
    else queued.set(key, { value, authority, settle: [resolve], timer: setTimeout(() => writeQueued(key), DISK_WRITE_DELAY_MS) });
    if (!afterPaint) writeQueued(key);
  });
}
/** Membership loss clears every opened thread too, and invalidates delayed hydration. */
export async function forgetChatMessages(roomId: string): Promise<void> {
  own();
  const keys = new Set([...memory.keys(), ...revisions.keys(), keyFor(roomId)]);
  for (const key of keys) {
    if (JSON.parse(key)[0] !== roomId) continue;
    revisions.set(key, (revisions.get(key) ?? 0) + 1); memory.delete(key);
    // A page waiting for its write must not land after the room was forgotten.
    const waiting = queued.get(key);
    if (waiting) { queued.delete(key); clearTimeout(waiting.timer); for (const settle of waiting.settle) settle(false); }
  }
  invalidated.forEach(listener => listener(roomId));
  await clearConversationDisk(roomId);
}
