import { getMobileAuthOwner, isMobileAuthOwnerCurrent } from '@/auth/authOwnerGeneration';
import { clearConversationDisk, historyDiskAuthority, readConversationDisk, writeConversationDisk } from '@/session/remoteHistoryDiskCache';
import type { ChatActor, ChatPage } from './chatServerClient';

export interface CachedChatPage { version: 1; page: ChatPage; self: string; actors: ChatActor[] }
const device = 'chat-server';
let owner = getMobileAuthOwner();
const memory = new Map<string, CachedChatPage>();
const revisions = new Map<string, number>();
const invalidated = new Set<(roomId: string) => void>();
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
export async function cacheChatMessages(roomId: string, value: CachedChatPage): Promise<boolean> {
  own();
  const key = keyFor(roomId, value.page.threadRootId);
  const authority = historyDiskAuthority(device, key);
  if (!authority.current()) return false;
  revisions.set(key, (revisions.get(key) ?? 0) + 1);
  memory.set(key, value);
  return writeConversationDisk(authority, value);
}
/** Membership loss clears every opened thread too, and invalidates delayed hydration. */
export async function forgetChatMessages(roomId: string): Promise<void> {
  own();
  const keys = new Set([...memory.keys(), ...revisions.keys(), keyFor(roomId)]);
  for (const key of keys) {
    if (JSON.parse(key)[0] !== roomId) continue;
    revisions.set(key, (revisions.get(key) ?? 0) + 1); memory.delete(key);
  }
  invalidated.forEach(listener => listener(roomId));
  await clearConversationDisk(roomId);
}
