import type { QueuedRemoteMessage, RemoteMessage } from './types';
import { pendingSendBubbleText } from './pendingSendItems';

/** Page-local transcript slots, never persisted or sent over device-link. */
export interface OptimisticUserMessage {
  message: RemoteMessage;
  precedingClientIds: ReadonlySet<string>;
}

/** Reserve a user row synchronously before enqueue, as Desktop does. */
export function appendOptimisticUserMessage(
  current: readonly OptimisticUserMessage[],
  messages: readonly RemoteMessage[],
  queued: QueuedRemoteMessage,
  sessionId: string,
): readonly OptimisticUserMessage[] {
  if (current.some((entry) => entry.message.clientId === queued.clientId)
    || messages.some((message) => message.clientId === queued.clientId)) return current;
  const source = queued.chatMessage;
  return [...current, {
    message: {
      id: queued.clientId, clientId: queued.clientId, sessionId, role: 'user',
      createdAt: source.createdAt, toolUseId: null, agentMeta: null,
      // This is the pending bubble's visible label, including synthetic-action
      // masking. Its authoritative body replaces it on echo.
      content: { ...source, text: pendingSendBubbleText(queued) },
    },
    precedingClientIds: new Set([
      ...messages.map((message) => message.clientId),
      ...current.map((entry) => entry.message.clientId),
    ]),
  }];
}

/** Preserve observation order; device clocks are not ordering evidence. */
export function projectOptimisticUserMessages(
  messages: readonly RemoteMessage[],
  optimistic: readonly OptimisticUserMessage[],
): readonly RemoteMessage[] {
  if (optimistic.length === 0) return messages;
  const result = [...messages];
  for (const entry of optimistic) {
    const echo = result.findIndex((message) => message.clientId === entry.message.clientId);
    const message = echo < 0 ? entry.message : result.splice(echo, 1)[0];
    let after = -1;
    for (let index = 0; index < result.length; index++) {
      if (entry.precedingClientIds.has(result[index].clientId)) after = index;
    }
    result.splice(after + 1, 0, message);
  }
  return result;
}

/** Queue rollback/failure removes the slot; a durable echo hands it to history. */
export function reconcileOptimisticUserMessages(
  current: readonly OptimisticUserMessage[],
  messages: readonly RemoteMessage[],
  activeClientIds: ReadonlySet<string>,
  confirmedClientIds: ReadonlySet<string>,
): readonly OptimisticUserMessage[] {
  if (current.length === 0) return current;
  const echoed = new Set(messages.map((message) => message.clientId));
  const remaining = current.filter(({ message }) => !confirmedClientIds.has(message.clientId)
    && (activeClientIds.has(message.clientId) || echoed.has(message.clientId)));
  return remaining.length === current.length ? current : remaining;
}
