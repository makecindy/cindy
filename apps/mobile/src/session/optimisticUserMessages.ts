import type { QueuedRemoteMessage, RemoteMessage } from './types';
import { historyViewLeaves, isHistoryViewUnavailable, type HistoryViewSnapshot } from '@cindy/maker-shared/message-window';
import { pendingSendBubbleText } from './pendingSendItems';

function authoritativeHistoryMessages(
  snapshot: HistoryViewSnapshot<RemoteMessage>, rawMessages: readonly RemoteMessage[],
): readonly RemoteMessage[] {
  return isHistoryViewUnavailable(snapshot.error) ? rawMessages
    : snapshot.ready ? historyViewLeaves(snapshot.items)
      .flatMap((item) => item.type === 'messages' ? item.messages : []) : [];
}

/** A raw push is not a handoff: the first history page may still predate it. */
export function confirmedHistoryUserClientIds(
  snapshot: HistoryViewSnapshot<RemoteMessage>, rawMessages: readonly RemoteMessage[],
): ReadonlySet<string> {
  return new Set(authoritativeHistoryMessages(snapshot, rawMessages)
    .filter((message) => message.role === 'user').map((message) => message.clientId));
}

/**
 * 已确认、且其后已出现任何消息(turn 已跑过)的用户消息 clientId。
 *
 * 被控端先落库用户行、再跑派发前钩子,之后才有运行信号;只「已确认」不代表已开跑。
 * 权威历史与实时推送(rawMessages)可能分叉,任一来源里这条后面已有消息就算跑过。
 */
export function repliedHistoryUserClientIds(
  snapshot: HistoryViewSnapshot<RemoteMessage>, rawMessages: readonly RemoteMessage[],
): ReadonlySet<string> {
  const confirmed = confirmedHistoryUserClientIds(snapshot, rawMessages);
  const replied = new Set<string>();
  for (const source of [authoritativeHistoryMessages(snapshot, rawMessages), rawMessages]) {
    source.forEach((message, index) => {
      if (message.role === 'user' && confirmed.has(message.clientId) && index < source.length - 1) {
        replied.add(message.clientId);
      }
    });
  }
  return replied;
}

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
  observedMessages: readonly RemoteMessage[] = [],
): readonly OptimisticUserMessage[] {
  if (current.some((entry) => entry.message.clientId === queued.clientId)
    || messages.some((message) => message.clientId === queued.clientId)
    || observedMessages.some((message) => message.clientId === queued.clientId)) return current;
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
      // History rows may be visible without ever entering the raw push store.
      // Keep both those observed rows and pushes received since the last render.
      ...observedMessages.map((message) => message.clientId),
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
  const echoed = new Map(messages.map((message) => [message.clientId, message]));
  const remaining = current.filter(({ message }) => !confirmedClientIds.has(message.clientId)
    && (activeClientIds.has(message.clientId) || echoed.has(message.clientId))).map((entry) => {
      const echo = echoed.get(entry.message.clientId);
      return echo && echo !== entry.message ? { ...entry, message: echo } : entry;
    });
  return remaining.length === current.length && remaining.every((entry, index) => entry === current[index])
    ? current : remaining;
}
