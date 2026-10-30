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

/**
 * 群聊时间线的日期分隔：返回每个本地自然日第一条消息的时间。群聊不按五分钟切时间组，
 * 一天只出一条日期线，具体时刻放在消息上（连续消息悬停可见）。
 */
export function collectBotTimelineDateDividers(
  messages: readonly BotTimelineMessage[],
): ReadonlyMap<string, number> {
  const dividers = new Map<string, number>();
  let previous: Date | null = null;
  for (const message of messages) {
    const timestamp = timestampOf(message.createdAt);
    if (timestamp === null) continue;
    const value = new Date(timestamp);
    if (previous === null || !isSameLocalDay(previous, value)) dividers.set(message.clientId, timestamp);
    previous = value;
  }
  return dividers;
}

/** Same local calendar day; invalid input never matches. */
export function isSameBotTimelineDay(left: number, right: number): boolean {
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  return isSameLocalDay(new Date(left), new Date(right));
}

/** 「今天」「昨天」, else a short date (with the year when it is not this year). */
export function formatBotTimelineDate(timestamp: number, locale: string, now = Date.now()): string {
  const value = new Date(timestamp);
  const current = new Date(now);
  const yesterday = new Date(current.getFullYear(), current.getMonth(), current.getDate() - 1);
  const relative = isSameLocalDay(value, current) ? 0 : isSameLocalDay(value, yesterday) ? -1 : null;
  if (relative !== null) {
    const text = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(relative, 'day');
    return text.charAt(0).toLocaleUpperCase(locale) + text.slice(1);
  }
  return new Intl.DateTimeFormat(locale, value.getFullYear() === current.getFullYear()
    ? { month: 'short', day: 'numeric', weekday: 'short' }
    : { year: 'numeric', month: 'short', day: 'numeric' }).format(value);
}

/** Time of day only, for the time beside an author or in a merged line's gutter. */
export function formatBotTimelineClock(timestamp: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(new Date(timestamp));
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
