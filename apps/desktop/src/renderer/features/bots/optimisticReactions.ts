/**
 * Optimistic reactions for server-backed group chats: a click shows the current actor's reaction at
 * once, the request runs behind it, and the server's copy takes over again once it agrees. A failed
 * request removes the local change and tells the caller. Rapid clicks on one emoji send in order, and
 * only the last intent is kept. State is per data owner, so an account switch never shows another
 * account's pending reactions.
 */
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent, type DataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import type { BotGroupMessageView } from '../../../shared/botGroupChat';

type Reaction = NonNullable<BotGroupMessageView['reactions']>[number];
export type ReactionRequest = (input: { groupId: string; messageId: string; emoji: string; present: boolean }) => Promise<{ ok: true } | { ok: false; errorCode: string }>;

interface Pending {
  owner: DataOwnerGeneration;
  /** What the actor last asked for; the badge shows this until the server agrees or a request fails. */
  desired: boolean;
  inFlight: boolean;
  /** The last request for `desired` succeeded; the entry waits for a server copy that agrees. */
  settled: boolean;
  expiry: ReturnType<typeof setTimeout> | null;
}

/** After the server accepted, its copy wins at the latest by then, even if no agreeing read arrived. */
export const SETTLED_REACTION_TTL_MS = 15_000;

const pending = new Map<string, Map<string, Pending>>();
const versions = new Map<string, number>();
const listeners = new Set<() => void>();
/** Message copies this module produced; only the server's own copies confirm a pending reaction. */
const overlaid = new WeakSet<BotGroupMessageView>();

const messageKey = (groupId: string, messageId: string) => `${groupId}\u0000${messageId}`;

function emit(key: string) {
  versions.set(key, (versions.get(key) ?? 0) + 1);
  for (const listener of listeners) listener();
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

function currentEntries(key: string) {
  const entries = pending.get(key);
  if (!entries) return null;
  const live = [...entries].filter(([, entry]) => isDataOwnerGenerationCurrent(entry.owner));
  return live.length ? live : null;
}

/** The reactions as the actor should see them: the server's copy with the pending intents applied. */
export function applyPendingReactions<T extends BotGroupMessageView>(groupId: string | undefined, message: T): T {
  if (!groupId) return message;
  const entries = currentEntries(messageKey(groupId, message.id));
  if (!entries) return message;
  const base = message.reactions ?? [];
  let changed = false;
  const next: Reaction[] = base.map(reaction => {
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

/** A server copy that agrees with an accepted intent ends it, so later remote changes show as they are. */
function reconcile(groupId: string, message: BotGroupMessageView) {
  if (overlaid.has(message)) return;
  const key = messageKey(groupId, message.id);
  const entries = pending.get(key);
  if (!entries) return;
  for (const [emoji, entry] of [...entries]) {
    if (!isDataOwnerGenerationCurrent(entry.owner)) { drop(key, emoji); continue; }
    const me = message.reactions?.some(reaction => reaction.emoji === emoji && reaction.me) ?? false;
    if (entry.settled && !entry.inFlight && me === entry.desired) drop(key, emoji);
  }
}

export interface ReactionCallbacks {
  /** The server accepted the last intent: re-read the authoritative message. */
  onChanged: (messageId: string) => void;
  /** The last intent failed and the local change was removed. */
  onFailed: (errorCode: string | null) => void;
}

/** Shows `present` for the current actor at once and saves it; clicks on the same emoji are sent in order. */
export function toggleReaction(request: ReactionRequest, groupId: string, messageId: string, emoji: string, present: boolean, callbacks: ReactionCallbacks) {
  const key = messageKey(groupId, messageId);
  const owner = getDataOwnerGeneration();
  const stale = pending.get(key)?.get(emoji);
  if (stale && !isDataOwnerGenerationCurrent(stale.owner)) drop(key, emoji);
  let entries = pending.get(key);
  if (!entries) { entries = new Map(); pending.set(key, entries); }
  let entry = entries.get(emoji);
  if (entry) {
    entry.desired = present;
    entry.settled = false;
    if (entry.expiry) { clearTimeout(entry.expiry); entry.expiry = null; }
  } else {
    entry = { owner, desired: present, inFlight: false, settled: false, expiry: null };
    entries.set(emoji, entry);
  }
  emit(key);
  if (!entry.inFlight) void send(request, key, groupId, messageId, emoji, entry, callbacks);
  else latestCallbacks.set(`${key}\u0000${emoji}`, callbacks);
}

const latestCallbacks = new Map<string, ReactionCallbacks>();

async function send(request: ReactionRequest, key: string, groupId: string, messageId: string, emoji: string, entry: Pending, callbacks: ReactionCallbacks) {
  const callbackKey = `${key}\u0000${emoji}`;
  latestCallbacks.set(callbackKey, callbacks);
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
    if (!isDataOwnerGenerationCurrent(entry.owner) || pending.get(key)?.get(emoji) !== entry) { latestCallbacks.delete(callbackKey); return; }
    const latest = latestCallbacks.get(callbackKey) ?? callbacks;
    if (entry.desired !== present) {
      // A newer click is waiting: send it whether or not this one landed; the server keeps the last.
      present = entry.desired;
      continue;
    }
    latestCallbacks.delete(callbackKey);
    if (errorCode !== undefined) {
      drop(key, emoji);
      latest.onFailed(errorCode);
      latest.onChanged(messageId);
      return;
    }
    entry.settled = true;
    entry.expiry = setTimeout(() => { if (pending.get(key)?.get(emoji) === entry) drop(key, emoji); }, SETTLED_REACTION_TTL_MS);
    latest.onChanged(messageId);
    return;
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The message with this actor's pending reactions applied; server copies that agree end them. */
export function useOptimisticReactions<T extends BotGroupMessageView>(groupId: string | undefined, message: T): T {
  const key = groupId ? messageKey(groupId, message.id) : '';
  const version = useSyncExternalStore(subscribe, () => (key ? versions.get(key) ?? 0 : 0));
  useEffect(() => { if (groupId) reconcile(groupId, message); }, [groupId, message, version]);
  return useMemo(() => applyPendingReactions(groupId, message), [groupId, message, version]);
}

/** Test-only: forget every pending reaction. */
export function resetOptimisticReactionsForTest() {
  for (const entries of pending.values()) for (const entry of entries.values()) if (entry.expiry) clearTimeout(entry.expiry);
  pending.clear(); versions.clear(); latestCallbacks.clear();
}
