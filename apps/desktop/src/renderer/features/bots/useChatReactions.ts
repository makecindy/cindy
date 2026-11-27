import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import type { BotGroupMessageView } from '../../../shared/botGroupChat';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent, subscribeDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';

type Reactions = NonNullable<BotGroupMessageView['reactions']>;
const empty: Reactions = [];
// A successful write can beat an older timeline read. Hold the local choice until
// the echo arrives, but let another device's conflicting choice win if it never does.
const ECHO_TIMEOUT_MS = 10_000;
export type ReactionGesture = { emoji: string; from?: { x: number; y: number } };
type Edit = { desired: boolean; writing: boolean; expiresAt?: number; stopWaiting?: () => void };

type ReactionRow = Pick<BotGroupMessageView, 'id' | 'reactions'>;
type SettleRead = (row: ReactionRow) => boolean;

/** Only reads started after the write may settle its local choice. */
export class ChatReactionReads {
  private readonly waiting = new Map<SettleRead, string>();

  afterNextRead(messageId: string, settle: SettleRead) {
    this.waiting.set(settle, messageId);
    return () => { this.waiting.delete(settle); };
  }

  beginRead() {
    const waiting = [...this.waiting];
    return (messages: readonly ReactionRow[]) => {
      for (const [settle, id] of waiting) {
        if (!this.waiting.has(settle)) continue;
        const row = messages.find(message => message.id === id);
        if (row && settle(row)) this.waiting.delete(settle);
      }
    };
  }
}

type ReactionView = (emoji: string, desired: boolean, accepted?: boolean) => void;
type MessageWrites = {
  pending: Map<string, { desired: boolean; sent: boolean }>;
  views: Set<ReactionView>;
};
const messageWrites = new Map<string, MessageWrites>();

export function useChatReactions(groupId: string | undefined, message: BotGroupMessageView,
  onChanged: (id: string) => void, reads?: ChatReactionReads) {
  const owner = useSyncExternalStore(subscribeDataOwnerGeneration, getDataOwnerGeneration);
  const messageId = message.id;
  const server = message.reactions ?? empty;
  const edits = useMemo(() => new Map<string, Edit>(), [groupId, messageId, owner, reads]);
  const displayOrder = useMemo(() => ({ emojis: [] as string[] }), [edits]);
  const [version, redraw] = useReducer((version: number) => version + 1, 0);

  const [gesture, setGesture] = useState<(ReactionGesture & { scope: typeof edits }) | null>(null);
  const finishGesture = useCallback((finished: ReactionGesture) => {
    setGesture(current => current === finished ? null : current);
  }, []);

  const scope = JSON.stringify([owner.dataOwnerId, owner.generation, groupId, messageId]);
  const refresh = useRef(onChanged);
  useLayoutEffect(() => { refresh.current = onChanged; }, [onChanged]);

  useLayoutEffect(() => {
    if (!groupId) return;
    const writes: MessageWrites = messageWrites.get(scope) ?? { pending: new Map(), views: new Set() };
    messageWrites.set(scope, writes);
    const update: ReactionView = (emoji, desired, accepted) => {
      edits.get(emoji)?.stopWaiting?.();
      const edit: Edit = { desired, writing: accepted === undefined };
      edits.set(emoji, edit);
      if (accepted === undefined) {
        if (desired) displayOrder.emojis = [emoji, ...displayOrder.emojis.filter(item => item !== emoji)];
      } else {
        edit.stopWaiting = reads?.afterNextRead(messageId, row => {
          if (accepted && desired !== Boolean(row.reactions?.some(r => r.emoji === emoji && r.me))) return false;
          edits.delete(emoji);
          redraw();
          return true;
        });
        if (accepted) {
          edit.expiresAt = Date.now() + ECHO_TIMEOUT_MS;
          refresh.current(messageId);
        }
      }
      redraw();
    };
    writes.views.add(update);
    for (const [emoji, write] of writes.pending) update(emoji, write.desired);
    return () => {
      writes.views.delete(update);
      if (!writes.views.size) {
        // Discard unsent choices on navigation, but serialize with a remount while the request is in flight.
        for (const write of writes.pending.values()) write.desired = write.sent;
        if (!writes.pending.size) messageWrites.delete(scope);
      }
      for (const edit of edits.values()) edit.stopWaiting?.();
      edits.clear();
    };
  }, [displayOrder, edits, groupId, messageId, reads, scope]);

  useEffect(() => {
    let nextExpiry = Infinity;
    for (const [emoji, edit] of edits) {
      if (edit.writing || edit.expiresAt === undefined) continue;
      const echoedWithoutReader = !reads && edit.desired === server.some(r => r.emoji === emoji && r.me);
      if (echoedWithoutReader || Date.now() >= edit.expiresAt) {
        edit.stopWaiting?.();
        edits.delete(emoji);
        redraw();
      } else {
        nextExpiry = Math.min(nextExpiry, edit.expiresAt);
      }
    }
    if (Number.isFinite(nextExpiry)) {
      const timer = setTimeout(redraw, Math.max(0, nextExpiry - Date.now()));
      return () => clearTimeout(timer);
    }
  }, [edits, reads, server, version]);

  async function toggle(emoji: string, from?: ReactionGesture['from']) {
    if (!groupId || !isDataOwnerGenerationCurrent(owner)) return;
    const writes = messageWrites.get(scope);
    if (!writes) return;
    const pending = writes.pending.get(emoji);
    const mine = pending?.desired ?? edits.get(emoji)?.desired ?? server.some(r => r.emoji === emoji && r.me);
    const write = pending ?? { desired: !mine, sent: !mine };
    write.desired = !mine;
    writes.pending.set(emoji, write);
    setGesture(mine ? null : { emoji, from, scope: edits });
    for (const view of writes.views) view(emoji, write.desired);
    if (pending) return;

    let accepted: boolean;
    do {
      write.sent = write.desired;
      try {
        const result = await window.electronAPI.maker.chatServer.react({ groupId, messageId, emoji, present: write.sent });
        accepted = result.ok;
      } catch {
        accepted = false;
      }
    } while (write.sent !== write.desired && isDataOwnerGenerationCurrent(owner));

    writes.pending.delete(emoji);
    if (!writes.views.size && !writes.pending.size) messageWrites.delete(scope);
    if (isDataOwnerGenerationCurrent(owner)) {
      for (const view of writes.views) view(emoji, write.sent, accepted);
    }
  }

  let reactions = server;
  for (const [emoji, edit] of edits) {
    const existing = server.find(r => r.emoji === emoji);
    if (edit.desired === (existing?.me ?? false)) continue;
    if (reactions === server) reactions = [...server];
    const count = (existing?.count ?? 0) + (edit.desired ? 1 : -1);
    const index = reactions.findIndex(r => r.emoji === emoji);
    const next = { emoji, count, me: edit.desired };
    if (index === -1) reactions.push(next);
    else if (count === 0) reactions.splice(index, 1);
    else reactions[index] = next;
  }
  // Snapshots carry counts and ownership, but no reaction timestamps.
  if (reactions.length > 1 && displayOrder.emojis.length && reactions.some((r, i) => r.emoji !== displayOrder.emojis[i])) {
    const positions = new Map(displayOrder.emojis.map((emoji, i) => [emoji, i]));
    reactions = [...reactions].sort((a, b) => (positions.get(a.emoji) ?? -1) - (positions.get(b.emoji) ?? -1));
  }
  useLayoutEffect(() => {
    displayOrder.emojis = reactions.map(r => r.emoji);
  }, [displayOrder, reactions]);
  return { owner, reactions, toggle, gesture: gesture?.scope === edits ? gesture : null, finishGesture };
}
