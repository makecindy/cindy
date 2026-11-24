import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useState } from 'react';
import type { BotGroupMessageView } from '../../../shared/botGroupChat';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';

type Reactions = NonNullable<BotGroupMessageView['reactions']>;
const empty: Reactions = [];
// A successful write can beat an older timeline read. Hold the local choice until
// the echo arrives, but let another device's conflicting choice win if it never does.
const ECHO_TIMEOUT_MS = 10_000;
export type ReactionGesture = { emoji: string; from?: { x: number; y: number } };
type Edit = { desired: boolean; writing: boolean; expiresAt?: number; stopWaiting?: () => void };

/** A view's existing history reads settle failed reactions, even if the server returns an
 * unchanged row. Capture waiters at read start so an older response cannot undo a later tap. */
export class ChatReactionReads {
  private readonly waiting = new Map<() => void, string>();

  afterNextRead(messageId: string, settle: () => void) {
    this.waiting.set(settle, messageId);
    return () => { this.waiting.delete(settle); };
  }

  beginRead() {
    const waiting = [...this.waiting];
    return (messages: readonly { id: string }[]) => {
      for (const [settle, id] of waiting) {
        if (this.waiting.has(settle) && messages.some(message => message.id === id)) {
          this.waiting.delete(settle);
          settle();
        }
      }
    };
  }
}

export function useChatReactions(groupId: string | undefined, message: BotGroupMessageView,
  onChanged: (id: string) => void, reads?: ChatReactionReads) {
  const owner = getDataOwnerGeneration();
  const messageId = message.id;
  const server = message.reactions ?? empty;
  const edits = useMemo(() => new Map<string, Edit>(), [groupId, messageId, owner, reads]);
  const [version, redraw] = useReducer((version: number) => version + 1, 0);

  const [gesture, setGesture] = useState<(ReactionGesture & { scope: typeof edits }) | null>(null);
  const finishGesture = useCallback((finished: ReactionGesture) => {
    setGesture(current => current === finished ? null : current);
  }, []);

  useLayoutEffect(() => () => {
    for (const edit of edits.values()) edit.stopWaiting?.();
    edits.clear();
  }, [edits]);

  useEffect(() => {
    let nextExpiry = Infinity;
    for (const [emoji, edit] of edits) {
      if (edit.writing || edit.expiresAt === undefined) continue;
      if (edit.desired === server.some(r => r.emoji === emoji && r.me) || Date.now() >= edit.expiresAt) {
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
  }, [edits, server, version]);

  async function toggle(emoji: string, from?: ReactionGesture['from']) {
    if (!groupId || !isDataOwnerGenerationCurrent(owner)) return;
    const previous = edits.get(emoji);
    const mine = previous?.desired ?? server.some(r => r.emoji === emoji && r.me);
    const edit = previous ?? { desired: mine, writing: false };
    edit.stopWaiting?.();
    edit.stopWaiting = undefined;
    edit.expiresAt = undefined;
    edit.desired = !mine;
    setGesture(mine ? null : { emoji, from, scope: edits });
    edits.set(emoji, edit);
    redraw();
    if (edit.writing) return;
    edit.writing = true;

    // A new user choice during the write is the only reason to send again.
    // One failed write by itself schedules neither another write nor a refresh.
    let sent: boolean;
    let accepted: boolean;
    do {
      sent = edit.desired;
      try {
        const result = await window.electronAPI.maker.chatServer.react({ groupId, messageId, emoji, present: sent });
        accepted = result.ok;
      } catch {
        accepted = false;
      }
      if (edits.get(emoji) !== edit || !isDataOwnerGenerationCurrent(owner)) return;
    } while (sent !== edit.desired);

    edit.writing = false;
    if (accepted) {
      edit.expiresAt = Date.now() + ECHO_TIMEOUT_MS;
      onChanged(messageId);
    } else {
      edit.stopWaiting = reads?.afterNextRead(messageId, () => {
        edits.delete(emoji);
        redraw();
      });
    }
    redraw();
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
  return { reactions, toggle, gesture: gesture?.scope === edits ? gesture : null, finishGesture };
}
