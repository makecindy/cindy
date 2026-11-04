/**
 * 伙伴私聊的「引用回复」（docs/product-rules/cindy-bots-runtime.md「私聊引用回复」），Desktop 与 Mobile 共用。
 *
 * 主人引用私聊里的某条消息回复：用户消息的内容信封带上 `replyQuote`，气泡在正文上方显示引用块，
 * 宿主把原消息作为背景附在发给伙伴的这一条 wire 消息前。引用只指向同一任务里的消息。
 * `excerpt` 是发送时的摘要快照：原消息不在已加载记录里时按它显示，模型侧一律按 clientId 从库里重读。
 */
export interface ChatReplyQuote {
  /** The quoted message, in the same Session. */
  clientId: string;
  role: 'user' | 'assistant';
  /** Display snapshot taken when the quote was sent. */
  excerpt: string;
}

export const CHAT_REPLY_QUOTE_EXCERPT_MAX = 280;

export function chatReplyQuoteExcerpt(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > CHAT_REPLY_QUOTE_EXCERPT_MAX
    ? `${line.slice(0, CHAT_REPLY_QUOTE_EXCERPT_MAX - 1)}…`
    : line;
}

/** Field-by-field validation of a persisted or received quote; anything malformed is no quote. */
export function readChatReplyQuote(value: unknown): ChatReplyQuote | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.clientId !== 'string' || !raw.clientId || raw.clientId.length > 256) return null;
  if (raw.role !== 'user' && raw.role !== 'assistant') return null;
  if (typeof raw.excerpt !== 'string') return null;
  return { clientId: raw.clientId, role: raw.role, excerpt: chatReplyQuoteExcerpt(raw.excerpt) };
}
