import type { ChatMessage } from '@/lib/makerChatStore';
import type { RenderItem } from './messageWorkGroups';

/** Append after grouping: queued input must never close the current assistant turn. */
export function appendPendingQueueItems(
  rendered: RenderItem[],
  pending: readonly ChatMessage[],
  history: readonly ChatMessage[],
): RenderItem[] {
  const seen = new Set(history.map((message) => message.clientId));
  for (const item of rendered) if (item.type === 'message') seen.add(item.message.clientId);
  const extra: RenderItem[] = [];
  for (const message of pending) {
    if (seen.has(message.clientId)) continue;
    seen.add(message.clientId);
    extra.push({ type: 'message', key: `msg-${message.clientId}`, message, pending: true });
  }
  return extra.length ? [...rendered, ...extra] : rendered;
}
