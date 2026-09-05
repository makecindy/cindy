export const BOT_MESSAGE_TIME_GROUP_MS = 5 * 60 * 1_000;

export interface BotTimelineMessage {
  clientId: string;
  createdAt?: string | number | null;
}

export interface BotReplyTimelineMessage extends BotTimelineMessage {
  role: string;
  systemCardType?: string;
  botPrivateReply?: boolean;
}

function timestampOf(value: BotTimelineMessage['createdAt']): number | null {
  const timestamp = typeof value === 'number' ? value : Date.parse(value ?? '');
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
}

/**
 * 返回每个时间组第一条可见消息的时间。工具调用与思考块应在调用前被排除，
 * 因为它们不是伙伴对话时间线里的消息，也不能偷偷切开一个五分钟分组。
 */
export function collectBotMessageTimeGroups(
  messages: readonly BotTimelineMessage[],
  windowMs = BOT_MESSAGE_TIME_GROUP_MS,
): ReadonlyMap<string, number> {
  const groups = new Map<string, number>();
  let groupStartTimestamp: number | null = null;
  for (const message of messages) {
    const timestamp = timestampOf(message.createdAt);
    if (timestamp === null) continue;
    if (groupStartTimestamp === null || timestamp - groupStartTimestamp >= windowMs) {
      groups.set(message.clientId, timestamp);
      groupStartTimestamp = timestamp;
    }
  }
  return groups;
}

/**
 * Find the first visible Bot reply after the read position captured on entry.
 * The caller only supplies already-simplified render items, so hidden work rows
 * cannot steal the divider from the first reply the user can actually see.
 */
export function findFirstUnreadBotReplyClientId(
  messages: readonly BotReplyTimelineMessage[],
  boundaryAt: number | null | undefined,
): string | null {
  if (boundaryAt === null || boundaryAt === undefined || !Number.isFinite(boundaryAt)) return null;
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    // Bot-to-Bot stamps are internal conversation traces. The unread divider
    // belongs on the Bot's next real reply/result, not on the message it received.
    if (message.systemCardType === 'bot-direct-message' || message.botPrivateReply) continue;
    const timestamp = timestampOf(message.createdAt);
    if (timestamp !== null && timestamp > boundaryAt) return message.clientId;
  }
  return null;
}

function isSameLocalDay(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

export function formatBotMessageGroupTime(
  timestamp: number,
  locale: string,
  now = Date.now(),
): string {
  const value = new Date(timestamp);
  const current = new Date(now);
  const dateFields: Intl.DateTimeFormatOptions = isSameLocalDay(value, current)
    ? {}
    : value.getFullYear() === current.getFullYear()
      ? { month: 'short', day: 'numeric' }
      : { year: 'numeric', month: 'short', day: 'numeric' };
  return new Intl.DateTimeFormat(locale, {
    ...dateFields,
    hour: '2-digit',
    minute: '2-digit',
  }).format(value);
}
