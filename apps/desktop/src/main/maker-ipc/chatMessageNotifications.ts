/** Live chat notifications. Server reads/mute state win over delayed or replayed socket events. */
export interface ChatMessageNotification {
  groupId: string;
  groupName: string;
  messageId: string;
  threadRootId?: string;
  conversationKind?: 'direct' | 'group';
  threadName?: string;
  senderName: string;
  avatar: string;
  preview: string;
}

export interface ChatNotificationMessage {
  id: string; seq: string; authorId: string; deleted: boolean; origin?: string;
  threadRootId: string | null; mentions?: string[];
}

export interface ChatAttentionSnapshot<M extends ChatNotificationMessage> {
  room: { name: string; kind?: string; archived?: boolean; dissolved_at?: string | null };
  messages: M[];
  reads?: Array<{ thread_key: string; read_seq: string; muted?: boolean; following?: boolean }>;
}

/** One eligibility rule for native notifications and the island's unread projection. */
export function isChatMessageAttention<M extends ChatNotificationMessage>(snapshot: ChatAttentionSnapshot<M>, message: M, selfId: string): boolean {
  if (!snapshot.reads || snapshot.room.archived || snapshot.room.dissolved_at
    || snapshot.reads.some(read => read.thread_key === 'main' && read.muted)
    || message.deleted || message.origin === 'system' || message.origin === 'import' || message.authorId === selfId) return false;
  const read = snapshot.reads.find(read => read.thread_key === (message.threadRootId ?? 'main'));
  if (read?.muted || BigInt(message.seq) <= BigInt(read?.read_seq ?? '0')) return false;
  return !message.threadRootId || read?.following === true || message.mentions?.includes(selfId) === true;
}

/** An unread mention wins; otherwise show the newest eligible message, regardless of snapshot order. */
export function selectChatAttentionMessage<M extends ChatNotificationMessage>(snapshot: ChatAttentionSnapshot<M>, selfId: string): M | null {
  let selected: M | null = null;
  for (const message of snapshot.messages) {
    if (!isChatMessageAttention(snapshot, message, selfId)) continue;
    const mention = message.mentions?.includes(selfId) === true;
    const previousMention = selected?.mentions?.includes(selfId) === true;
    if (!selected || (mention && !previousMention) || (mention === previousMention && BigInt(message.seq) > BigInt(selected.seq))) selected = message;
  }
  return selected;
}

export function createChatMessageNotifications<M extends ChatNotificationMessage>(deps: {
  current: () => boolean;
  selfId: () => string;
  message?: (groupId: string, messageId: string) => Promise<M>;
  snapshot: (groupId: string) => Promise<ChatAttentionSnapshot<M>>;
  present: (groupId: string, message: M) => Promise<Omit<ChatMessageNotification, 'groupId' | 'groupName' | 'messageId' | 'threadRootId'>>;
  notify: (notification: ChatMessageNotification, current: () => boolean) => void;
  shouldAlert?: (message: M, snapshot: ChatAttentionSnapshot<M>, groupId: string) => boolean;
  revision?: (groupId: string) => unknown;
}) {
  const pending = new Map<string, Set<string>>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const handled = new Set<string>();
  const retries = new Map<string, number>();
  let disposed = false;
  const current = () => !disposed && deps.current();
  const remember = (id: string) => {
    handled.add(id);
    retries.delete(id);
    if (handled.size > 1000) handled.delete(handled.values().next().value!);
  };
  async function flush(groupId: string) {
    timers.delete(groupId);
    const ids = pending.get(groupId);
    pending.delete(groupId);
    if (!ids || !current()) return;
    try {
      const revision = deps.revision?.(groupId);
      const stillCurrent = () => current() && deps.revision?.(groupId) === revision;
      const snapshot = await deps.snapshot(groupId);
      if (!stillCurrent()) throw new Error('CHAT_NOTIFICATION_CHANGED');
      if (!current() || !snapshot.reads || snapshot.room.archived || snapshot.room.dissolved_at) return;
      const main = snapshot.reads.find(read => read.thread_key === 'main');
      if (main?.muted) return;
      for (const id of ids) {
        if (handled.has(id)) continue;
        const message = snapshot.messages.find(message => message.id === id) ?? await deps.message?.(groupId, id);
        if (!current()) return;
        if (!message) continue;
        if (!isChatMessageAttention(snapshot, message, deps.selfId()) || deps.shouldAlert?.(message, snapshot, groupId) === false) { remember(id); continue; }
        const presentation = await deps.present(groupId, message);
        if (!current()) return;
        if (!stillCurrent()) throw new Error('CHAT_NOTIFICATION_CHANGED');
        deps.notify({ ...presentation, groupId, groupName: snapshot.room.name, messageId: message.id,
          ...(message.threadRootId ? { threadRootId: message.threadRootId } : {}) }, stillCurrent);
        remember(id);
      }
    } catch {
      // A transient disconnect must not consume a live notice. Retry a bounded
      // window with fresh authorization/read state, preserving arrivals during the request.
      if (!current()) return;
      const remaining = pending.get(groupId) ?? new Set<string>();
      for (const id of ids) {
        if (handled.has(id)) continue;
        const attempt = (retries.get(id) ?? 0) + 1;
        if (attempt > 3) { remember(id); continue; }
        retries.set(id, attempt);
        if (remaining.size < 100) remaining.add(id);
      }
      if (remaining.size && (pending.has(groupId) || pending.size < 100)) {
        pending.set(groupId, remaining);
        if (!timers.has(groupId)) timers.set(groupId, setTimeout(() => { void flush(groupId); }, 3000));
      }
    }
  }
  return {
    enqueue(groupId: string, messageId: string) {
      if (!current() || handled.has(messageId)) return;
      const ids = pending.get(groupId) ?? new Set<string>();
      if (ids.size >= 100 || (!pending.has(groupId) && pending.size >= 100)) return;
      ids.add(messageId); pending.set(groupId, ids);
      if (!timers.has(groupId)) timers.set(groupId, setTimeout(() => { void flush(groupId); }, 1200));
    },
    dispose() {
      disposed = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear(); pending.clear(); handled.clear(); retries.clear();
    },
  };
}
