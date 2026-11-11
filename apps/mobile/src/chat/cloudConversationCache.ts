import { getMobileAuthOwner, isMobileAuthOwnerCurrent } from '@/auth/authOwnerGeneration';
import { clearHistoryDisk, historyDiskAuthority, readConversationDisk, writeConversationDisk } from '@/session/remoteHistoryDiskCache';
import type { ChatMessage } from './chatServerClient';

export interface CachedCloudConversation { roomId: string; messages: ChatMessage[]; before: string | null; historyRevision?: string }
const namespace = 'cloud-companion';
let owner = getMobileAuthOwner();
const pages = new Map<string, CachedCloudConversation>();
const invalidated = new Set<(actorId: string) => void>();
export function subscribeCloudConversationInvalidation(listener: (actorId: string) => void) {
  invalidated.add(listener); return () => { invalidated.delete(listener); };
}
function own() { if (!isMobileAuthOwnerCurrent(owner)) { owner = getMobileAuthOwner(); pages.clear(); } }
export function peekCloudConversation(actorId: string) { own(); return owner.accountId ? pages.get(actorId) ?? null : null; }
export async function readCloudConversation(actorId: string) {
  own();
  const cached = peekCloudConversation(actorId);
  if (cached) return cached;
  const authority = historyDiskAuthority(namespace, actorId);
  const saved = await readConversationDisk(authority, (value): value is CachedCloudConversation => {
    const page = value as CachedCloudConversation | null;
    return !!page && typeof page.roomId === 'string' && (page.before === null || typeof page.before === 'string')
      && Array.isArray(page.messages) && page.messages.every(message => message && typeof message.id === 'string'
        && /^\d{1,30}$/.test(message.seq) && typeof message.authorId === 'string' && !!message.author
        && typeof message.author.name === 'string' && Array.isArray(message.content));
  });
  if (saved && authority.current() && !pages.has(actorId)) pages.set(actorId, saved);
  return authority.current() ? peekCloudConversation(actorId) : null;
}
export async function cacheCloudConversation(actorId: string, page: CachedCloudConversation) {
  own();
  const authority = historyDiskAuthority(namespace, actorId);
  if (!authority.current()) return;
  pages.set(actorId, page);
  await writeConversationDisk(authority, page);
}
export function forgetCloudConversation(actorId: string) {
  own(); pages.delete(actorId);
  invalidated.forEach(listener => listener(actorId));
  return clearHistoryDisk(namespace, actorId);
}
