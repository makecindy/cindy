/**
 * Optimistic reactions for server-backed group chats, shared by Desktop and Mobile
 * (bot-group-chat.md「表情回应是乐观的」). A tap shows the current actor's reaction at once, the
 * request runs behind it, and the server's copy takes over again once it agrees. A failed request
 * removes the local change and tells the caller. Taps on one emoji are sent in order and only the
 * last intent is kept. Every intent belongs to the data owner that made it, so an account switch
 * never shows another account's pending reactions. No React here: each app subscribes through
 * `subscribe` / `version`.
 */

export interface ChatReaction { emoji: string; count: number; me: boolean }
export interface ReactableMessage { id: string; reactions?: ChatReaction[] }
export type ReactionRequestResult = { ok: true } | { ok: false; errorCode: string };
/** Sends one reaction change; a thrown error counts as a failure without a code. */
export type ReactionRequest = (input: { groupId: string; messageId: string; emoji: string; present: boolean }) => Promise<ReactionRequestResult>;
export interface ReactionCallbacks {
  /** The server accepted the last intent: re-read the authoritative message. */
  onChanged(messageId: string): void;
  /** The last intent failed and its local change was removed; `null` when no code is known. */
  onFailed(errorCode: string | null): void;
}

/** The reaction choices offered by the reaction pickers, most common first. */
export const CHAT_REACTION_EMOJIS = [
  '👍', '❤️', '😂', '🎉', '👀', '🙏',
  '✅', '🤔', '🔥', '👏', '🚀', '💯',
  '😀', '😄', '😊', '😍', '🥰', '😎',
  '🤣', '😅', '🥹', '😭', '😮', '😱',
  '😢', '😡', '🤯', '😴', '🤦', '🤷',
  '👌', '🤝', '💪', '🙌', '👋', '✨',
] as const;

/** After the server accepted, its copy wins at the latest by then, even if no agreeing read arrived. */
export const SETTLED_REACTION_TTL_MS = 15_000;

interface Pending<Owner> {
  owner: Owner;
  /** What the actor last asked for; shown until the server agrees or a request fails. */
  desired: boolean;
  inFlight: boolean;
  /** The last request for `desired` succeeded; the entry waits for a server copy that agrees. */
  settled: boolean;
  expiry: ReturnType<typeof setTimeout> | null;
  callbacks: ReactionCallbacks;
}

export interface OptimisticReactionStore {
  /** The message as the actor should see it: the server's copy with pending intents applied. */
  apply<T extends ReactableMessage>(groupId: string | undefined, message: T): T;
  /** A server copy that agrees with an accepted intent ends it; copies from `apply` are ignored. */
  reconcile(groupId: string, message: ReactableMessage): void;
  /** Shows `present` for the current actor at once and saves it. */
  toggle(request: ReactionRequest, groupId: string, messageId: string, emoji: string, present: boolean, callbacks: ReactionCallbacks): void;
  subscribe(listener: () => void): () => void;
  /** Changes whenever this message's pending intents change. */
  version(groupId: string, messageId: string): number;
  /** Test-only: forget every pending reaction. */
  reset(): void;
}

export function createOptimisticReactionStore<Owner>(owners: { current(): Owner; isCurrent(owner: Owner): boolean }): OptimisticReactionStore {
  const pending = new Map<string, Map<string, Pending<Owner>>>();
  const versions = new Map<string, number>();
  const listeners = new Set<() => void>();
  const overlaid = new WeakSet<object>();
  const messageKey = (groupId: string, messageId: string) => `${groupId}\u0000${messageId}`;

  function emit(key: string) {
    versions.set(key, (versions.get(key) ?? 0) + 1);
    for (const listener of [...listeners]) listener();
  }
  function drop(key: string, emoji: string) {
    const entries = pending.get(key);
    const entry = entries?.get(emoji);
    if (!entries || !entry) return;
    if (entry.expiry) clearTimeout(entry.expiry);
    entries.delete(emoji);
    if (!entries.size) pending.delete(key);
    emit(key);
  }

  function apply<T extends ReactableMessage>(groupId: string | undefined, message: T): T {
    if (!groupId) return message;
    const entries = [...(pending.get(messageKey(groupId, message.id)) ?? [])].filter(([, entry]) => owners.isCurrent(entry.owner));
    if (!entries.length) return message;
    const base = message.reactions ?? [];
    let changed = false;
    const next: ChatReaction[] = base.map(reaction => {
      const entry = entries.find(([emoji]) => emoji === reaction.emoji)?.[1];
      if (!entry || reaction.me === entry.desired) return reaction;
      changed = true;
      return { ...reaction, me: entry.desired, count: Math.max(0, reaction.count + (entry.desired ? 1 : -1)) };
    }).filter(reaction => reaction.count > 0);
    for (const [emoji, entry] of entries) {
      if (entry.desired && !base.some(reaction => reaction.emoji === emoji)) {
        changed = true;
        next.push({ emoji, count: 1, me: true });
      }
    }
    if (!changed) return message;
    const view = { ...message, reactions: next };
    overlaid.add(view);
    return view;
  }

  function reconcile(groupId: string, message: ReactableMessage) {
    if (overlaid.has(message)) return;
    const key = messageKey(groupId, message.id);
    const entries = pending.get(key);
    if (!entries) return;
    for (const [emoji, entry] of [...entries]) {
      if (!owners.isCurrent(entry.owner)) { drop(key, emoji); continue; }
      const me = message.reactions?.some(reaction => reaction.emoji === emoji && reaction.me) ?? false;
      if (entry.settled && !entry.inFlight && me === entry.desired) drop(key, emoji);
    }
  }

  async function send(request: ReactionRequest, key: string, groupId: string, messageId: string, emoji: string, entry: Pending<Owner>) {
    let present = entry.desired;
    for (;;) {
      entry.inFlight = true;
      let errorCode: string | null | undefined;
      try {
        const result = await request({ groupId, messageId, emoji, present });
        errorCode = result.ok ? undefined : result.errorCode;
      } catch { errorCode = null; }
      entry.inFlight = false;
      // The account changed or the entry was dropped meanwhile: nothing here is shown any more.
      if (!owners.isCurrent(entry.owner) || pending.get(key)?.get(emoji) !== entry) return;
      if (entry.desired !== present) {
        // A newer tap is waiting: send it whether or not this one landed; the server keeps the last.
        present = entry.desired;
        continue;
      }
      if (errorCode !== undefined) {
        drop(key, emoji);
        entry.callbacks.onFailed(errorCode);
        entry.callbacks.onChanged(messageId);
        return;
      }
      entry.settled = true;
      entry.expiry = setTimeout(() => { if (pending.get(key)?.get(emoji) === entry) drop(key, emoji); }, SETTLED_REACTION_TTL_MS);
      entry.callbacks.onChanged(messageId);
      return;
    }
  }

  function toggle(request: ReactionRequest, groupId: string, messageId: string, emoji: string, present: boolean, callbacks: ReactionCallbacks) {
    const key = messageKey(groupId, messageId);
    const stale = pending.get(key)?.get(emoji);
    if (stale && !owners.isCurrent(stale.owner)) drop(key, emoji);
    let entries = pending.get(key);
    if (!entries) { entries = new Map(); pending.set(key, entries); }
    let entry = entries.get(emoji);
    if (entry) {
      entry.desired = present;
      entry.settled = false;
      entry.callbacks = callbacks;
      if (entry.expiry) { clearTimeout(entry.expiry); entry.expiry = null; }
    } else {
      entry = { owner: owners.current(), desired: present, inFlight: false, settled: false, expiry: null, callbacks };
      entries.set(emoji, entry);
    }
    emit(key);
    if (!entry.inFlight) void send(request, key, groupId, messageId, emoji, entry);
  }

  return {
    apply, reconcile, toggle,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    version: (groupId, messageId) => versions.get(messageKey(groupId, messageId)) ?? 0,
    reset() {
      for (const entries of pending.values()) for (const entry of entries.values()) if (entry.expiry) clearTimeout(entry.expiry);
      pending.clear(); versions.clear();
    },
  };
}
