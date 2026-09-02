/**
 * Pure display logic for the Bots list rows (IM-style: name + time on the first
 * line, latest message on the second). Kept out of the component so the
 * fallback chain and the timestamp format are unit-testable without a DOM.
 */

/**
 * 行上该显示哪一刻。
 *
 * 只看最后一条消息的时间是不够的:伙伴接了一个跑二十分钟的委派时,一条消息都不会
 * 产生,于是列表里它显示成「20 分钟前」——看起来像闲着,其实正忙。第二行已经让位给
 * 「正在输入…」了,时间列却还在说旧话,两者互相打架。
 *
 * 正在干活就取此刻:它现在确实是活的。活干完自然落回最后一条消息的时间,不留痕。
 *
 * 判据同 Hermes 的名单行(hermes-agent plugin.js 7832+):
 * `rowAgeTs = working ? max(聊天活动, 工人活动) : 聊天活动` —— 它的注释记着
 * 「工人不出现在会话列表里,没有这一条的话,一个磨了 30 分钟看板任务的伙伴,
 * 全程显示『3 小时前』」。
 */
export function botListTimestampAt(
  bot: { lastMessageAt?: number | null; working?: boolean },
  now: number,
): number | null {
  if (bot.working) return now;
  return typeof bot.lastMessageAt === 'number' && Number.isFinite(bot.lastMessageAt)
    ? bot.lastMessageAt
    : null;
}

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
