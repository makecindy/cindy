import { historyViewLeaves, isHistoryViewUnavailable, type HistoryViewSnapshot } from '@cindy/maker-shared/message-window';
import { replaceCachedSessionMessages } from './mobileSessionMessageCache';
import { historyDiskAuthority, readHistoryDisk, writeHistoryDisk } from './remoteHistoryDiskCache';
import { findRemoteHistoryView } from './remoteHistoryViews';
import { remoteSessionStore } from './remoteSessionStore';
import type { RemoteMessage } from './types';

/** A sent row can age out of the latest window; it must not become a pending bubble forever. */
function coversMessage(snapshot: HistoryViewSnapshot<RemoteMessage>, message: RemoteMessage): boolean {
  if (!snapshot.ready) return false;
  const leaves = historyViewLeaves(snapshot.items);
  if (leaves.some(item => item.type === 'messages'
    && item.messages.some(row => row.role === 'user' && row.clientId === message.clientId))) return true;
  // User rows never fold into work. Skip leading work to find a stored boundary,
  // and use the host's (createdAt, rowid) order, not import/insertion order alone.
  const first = leaves.find(item => item.type === 'messages' && item.messages.length > 0);
  const oldest = first?.type === 'messages' ? first.messages[0] : undefined;
  if (!oldest || !Number.isFinite(message.rowid) || !Number.isFinite(oldest.rowid)) return false;
  const sentAt = Date.parse(message.createdAt), oldestAt = Date.parse(oldest.createdAt);
  return Number.isFinite(sentAt) && Number.isFinite(oldestAt)
    && (sentAt < oldestAt || (sentAt === oldestAt && message.rowid! < oldest.rowid!));
}

/** Keep the existing durable outbox until the representation used on reentry is on disk. */
export async function cacheOutboxHistory(
  deviceId: string,
  sessionId: string,
  clientId: string,
  isCurrent: () => boolean,
): Promise<boolean> {
  if (!isCurrent()) return false;
  const messages = remoteSessionStore.getMessages(sessionId);
  const message = messages.find(row => row.clientId === clientId && row.role === 'user');
  if (!message) return false;
  const view = findRemoteHistoryView(deviceId, sessionId);
  const snapshot = view?.getSnapshot();
  if (snapshot && isHistoryViewUnavailable(snapshot.error)) {
    // Older hosts render the raw window. Do not turn a scheduled task into a long-term cache.
    if (remoteSessionStore.getSessionRetention(sessionId) !== 'regular') return true;
    // Revoke pre-handoff debounce writes before the existing serialized replacement.
    return await replaceCachedSessionMessages(deviceId, sessionId, messages) && isCurrent();
  }
  const authority = historyDiskAuthority(deviceId, sessionId);
  if (snapshot && coversMessage(snapshot, message)) {
    // Only status flags change during a refresh; these items already contain the confirmed row.
    const saved = await writeHistoryDisk(authority, { ...snapshot, loading: false, error: null });
    return saved && authority.current() && isCurrent();
  }
  // A mounted stale page still needs its local bubble even if disk is newer.
  if (snapshot) return false;
  const cached = await readHistoryDisk(authority);
  return !!cached && coversMessage(cached, message) && authority.current() && isCurrent();
}
