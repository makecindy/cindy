/**
 * Pure display logic for the Bots list rows (IM-style: name + time on the first
 * line, latest message on the second). Kept out of the component so the
 * fallback chain and the timestamp format are unit-testable without a DOM.
 */

/** Row timestamp: today → `HH:mm`, any older day → `M/D`. */
export function formatBotListTimestamp(at: number | null | undefined, now: number): string {
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return '';
  const stamp = new Date(at);
  const today = new Date(now);
  const sameDay =
    stamp.getFullYear() === today.getFullYear() &&
    stamp.getMonth() === today.getMonth() &&
    stamp.getDate() === today.getDate();
  if (sameDay) {
    return `${String(stamp.getHours()).padStart(2, '0')}:${String(stamp.getMinutes()).padStart(2, '0')}`;
  }
  return `${stamp.getMonth() + 1}/${stamp.getDate()}`;
}

/**
 * Unread badge label. Main counts at most 100 rows per Bot, so anything at or
 * above the cap reads as `99+` — the exact number stops being useful long
 * before then, and an unbounded count would stretch the row's trailing edge.
 */
export function formatBotUnreadBadge(count: number): string {
  return count > 99 ? '99+' : String(count);
}

export type BotListSubtitleKind = 'message' | 'description' | 'placeholder';

export interface BotListSubtitle {
  kind: BotListSubtitleKind;
  /** Empty for 'placeholder' — the caller supplies the localized prompt. */
  text: string;
}

/**
 * Second-line fallback chain: latest message → Bot description → "start the
 * conversation" prompt. The channel label deliberately does not appear here;
 * a chat list shows conversation content, not transport metadata.
 */
export function botListSubtitle(bot: {
  lastMessagePreview?: string | null;
  description?: string | null;
}): BotListSubtitle {
  const preview = (bot.lastMessagePreview ?? '').replace(/\s+/g, ' ').trim();
  if (preview) return { kind: 'message', text: preview };
  const description = (bot.description ?? '').replace(/\s+/g, ' ').trim();
  if (description) return { kind: 'description', text: description };
  return { kind: 'placeholder', text: '' };
}
