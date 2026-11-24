import { useEffect, useMemo, useReducer } from 'react';
import { useTranslation } from 'react-i18next';
import type { BotGroupMessageView } from '../../../shared/botGroupChat';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { toast } from '@/lib/toast';
import { chatErrorKey } from './chatError';

type Reactions = NonNullable<BotGroupMessageView['reactions']>;
const empty: Reactions = [];
// A successful write can beat an older timeline read. Hold the local choice until
// the echo arrives, but let another device's conflicting choice win if it never does.
const ECHO_TIMEOUT_MS = 10_000;
type Edit = { desired: boolean; writing: boolean; confirmed?: boolean; expiresAt?: number };

export function useChatReactions(groupId: string | undefined, message: BotGroupMessageView, onChanged: (id: string) => void) {
  const { t } = useTranslation();
  const owner = getDataOwnerGeneration();
  const messageId = message.id;
  const server = message.reactions ?? empty;
  const edits = useMemo(() => new Map<string, Edit>(), [groupId, messageId, owner]);
  const [version, redraw] = useReducer((version: number) => version + 1, 0);

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

  async function toggle(emoji: string) {
    if (!groupId || !isDataOwnerGenerationCurrent(owner)) return;
    const previous = edits.get(emoji);
    const mine = previous?.desired ?? server.some(r => r.emoji === emoji && r.me);
    const edit = previous ?? { desired: mine, writing: false };
    edit.desired = !mine;
    edits.set(emoji, edit);
    redraw();
    if (edit.writing) return;
    edit.writing = true;
    // Each write sets one emoji. Serialize just that emoji and send the latest choice
    // if it changed while awaiting the first write. Other emoji remain independent.
    try {
      let sent: boolean;
      do {
        sent = edit.desired;
        const result = await window.electronAPI.maker.chatServer.react({ groupId, messageId, emoji, present: sent });
        if (!isDataOwnerGenerationCurrent(owner)) return;
        if (!result.ok) {
          toast.error(t(chatErrorKey(result.errorCode)));
          break;
        }
        edit.confirmed = sent;
      } while (sent !== edit.desired);
    } catch {
      if (isDataOwnerGenerationCurrent(owner)) toast.error(t(chatErrorKey('REQUEST_FAILED')));
    } finally {
      edit.writing = false;
      if (edit.confirmed === undefined) edits.delete(emoji);
      else {
        edit.desired = edit.confirmed;
        edit.expiresAt = Date.now() + ECHO_TIMEOUT_MS;
      }
      if (isDataOwnerGenerationCurrent(owner)) {
        redraw();
        onChanged(messageId);
      }
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
  return { reactions, toggle };
}
