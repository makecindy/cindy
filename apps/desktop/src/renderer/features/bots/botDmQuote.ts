/**
 * 伙伴私聊的引用回复（docs/product-rules/cindy-bots-runtime.md「私聊引用回复」）：输入框上方等待发出的
 * 引用（按任务保存在本次运行中，切换任务再回来仍在），以及把引用落成与群聊同一个引用块的显示数据。
 */
import { useSyncExternalStore } from 'react';
import { richAnswerText } from '@cindy/maker-shared/rich-answer';
import { forwardedRequestDisplayText } from '@cindy/maker-shared/message-source';

import type { ChatMessage } from '@/lib/makerChatStore';
import type { BotGroupQuoteDisplay } from '../../../shared/botGroupChat';
import { chatReplyQuoteExcerpt, type ChatReplyQuote } from '../../../shared/chatReplyQuote';

const pending = new Map<string, ChatReplyQuote>();
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };

export function setPendingBotReplyQuote(sessionId: string, quote: ChatReplyQuote | null): void {
  if (quote) pending.set(sessionId, quote);
  else if (!pending.delete(sessionId)) return;
  notify();
}

export function getPendingBotReplyQuote(sessionId: string | null | undefined): ChatReplyQuote | null {
  return sessionId ? pending.get(sessionId) ?? null : null;
}

/** Drop the quote that was just sent, unless another one replaced it meanwhile. */
export function clearSentBotReplyQuote(sessionId: string, sent: ChatReplyQuote): void {
  if (pending.get(sessionId) === sent) setPendingBotReplyQuote(sessionId, null);
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export function usePendingBotReplyQuote(sessionId: string | null | undefined): ChatReplyQuote | null {
  return useSyncExternalStore(subscribe, () => getPendingBotReplyQuote(sessionId), () => null);
}

type QuotableMessage = Pick<ChatMessage, 'clientId' | 'role' | 'content' | 'images' | 'files' | 'automationOrigin' | 'hookSource'>;

/** The text the user reads: a companion reply's components as their visible text, not their source. */
function readableText(message: QuotableMessage): string {
  if (message.role === 'assistant') return richAnswerText(message.content);
  return message.automationOrigin?.kind === 'session' && !message.hookSource
    ? forwardedRequestDisplayText(message.content) : message.content;
}

function attachmentSummary(message: QuotableMessage | undefined): { count: number; name: string | null } {
  const names = [
    ...(message?.images ?? []).map((image) => ('originalName' in image ? image.originalName : undefined)),
    ...(message?.files ?? []).map((file) => file.name),
  ].filter((name): name is string => typeof name === 'string' && name.length > 0);
  return { count: names.length, name: names[0] ?? null };
}

/** The quote a reply on `message` carries; only user and companion messages can be quoted. */
export function botReplyQuoteFor(message: QuotableMessage): ChatReplyQuote | null {
  if (message.role !== 'user' && message.role !== 'assistant') return null;
  const excerpt = chatReplyQuoteExcerpt(readableText(message));
  const attachments = attachmentSummary(message);
  return { clientId: message.clientId, role: message.role, excerpt: excerpt || attachments.name || '' };
}

/**
 * How a private-chat quote reads now: from the original while it is loaded in this chat,
 * otherwise from the snapshot taken when the quote was sent.
 */
export function botReplyQuoteDisplay(
  quote: ChatReplyQuote,
  original: QuotableMessage | undefined,
  names: { owner: string; companion: string },
): BotGroupQuoteDisplay {
  const authorName = quote.role === 'assistant' ? names.companion : names.owner;
  if (!original) {
    return { state: 'snapshot', authorName, excerpt: quote.excerpt, attachmentCount: 0, attachmentName: null };
  }
  const attachments = attachmentSummary(original);
  return {
    state: 'live',
    authorName,
    excerpt: chatReplyQuoteExcerpt(readableText(original)),
    attachmentCount: attachments.count,
    attachmentName: attachments.name,
  };
}
