/** Shared by personal IM ingress and official hooks; mirrored in both repositories. */
export const CHANNEL_HISTORY_MAX_MESSAGES = 50;
export const CHANNEL_HISTORY_MAX_CHARS = 16_000;
export const CHANNEL_HISTORY_ATTACHMENT_TEXT_MAX_CHARS = 4_000;
export const CHANNEL_HISTORY_ENTRY_MAX_CHARS = 4_000;
export const CHANNEL_HISTORY_TRUNCATED = '[…已截断]';

export function truncateChannelHistory(
  text: string,
  max = CHANNEL_HISTORY_ENTRY_MAX_CHARS,
): string {
  if (text.length <= max) return text;
  if (max <= CHANNEL_HISTORY_TRUNCATED.length)
    return CHANNEL_HISTORY_TRUNCATED.slice(0, Math.max(0, max));
  return text.slice(0, max - CHANNEL_HISTORY_TRUNCATED.length) + CHANNEL_HISTORY_TRUNCATED;
}

/** UTC is explicit: server deployment region must not change message timestamps. */
export function channelHistoryTime(ms: number): string {
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) && ms > 0
    ? date
        .toISOString()
        .replace('T', ' ')
        .replace(/:\d{2}\.\d{3}Z$/, ' UTC')
    : '[时间未知]';
}

/** Input is chronological. Select the quote first, then recent messages; return chronological order. */
export function selectChannelHistory<T>(
  items: readonly T[],
  options: {
    id: (item: T) => string;
    render: (item: T) => string;
    priorityId?: string;
    maxMessages?: number;
    maxChars?: number;
  },
): { entries: Array<{ item: T; text: string }>; truncated: boolean } {
  const maxMessages = Math.max(
    0,
    Math.min(CHANNEL_HISTORY_MAX_MESSAGES, options.maxMessages ?? CHANNEL_HISTORY_MAX_MESSAGES),
  );
  const maxChars = Math.max(
    0,
    Math.min(CHANNEL_HISTORY_MAX_CHARS, options.maxChars ?? CHANNEL_HISTORY_MAX_CHARS),
  );
  const ordered = items.map((item, index) => ({ item, index })).reverse();
  const priority = options.priorityId
    ? ordered.find(({ item }) => options.id(item) === options.priorityId)
    : undefined;
  const candidates = priority
    ? [priority, ...ordered.filter((entry) => entry !== priority)]
    : ordered;
  const seen = new Set<string>();
  const selected: Array<{ item: T; text: string; index: number }> = [];
  let remaining = maxChars;
  let truncated = false;
  for (const { item, index } of candidates) {
    const id = options.id(item);
    if (seen.has(id)) continue;
    seen.add(id);
    if (selected.length >= maxMessages || remaining <= CHANNEL_HISTORY_TRUNCATED.length) {
      truncated = true;
      continue;
    }
    const original = options.render(item);
    const text = truncateChannelHistory(original, remaining);
    truncated ||= text !== original;
    selected.push({ item, text, index });
    remaining -= text.length + 1;
  }
  return {
    entries: selected.sort((a, b) => a.index - b.index).map(({ item, text }) => ({ item, text })),
    truncated,
  };
}
