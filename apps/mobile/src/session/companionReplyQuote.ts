/**
 * 伙伴私聊的引用回复（docs/product-rules/cindy-bots-runtime.md「私聊引用回复」「回复对应的消息」），
 * 与 Desktop 同一份信封字段：长按「回复」先在输入框上方放一条待发引用（按任务记在本次运行中），
 * 发送时随消息写进 `replyQuote`；气泡与「回复对应的消息」都画成群聊同款引用块。
 */
import { useSyncExternalStore } from 'react';
import type { BotGroupQuoteDisplay } from '@cindy/maker-shared/botGroupChat';
import { chatReplyQuoteExcerpt, type ChatReplyQuote } from '@cindy/maker-shared/chat-reply-quote';
import { richAnswerText } from '@cindy/maker-shared/rich-answer';
import type { NormalizedRemoteMessage } from '@/session/messageNormalize';

const pending = new Map<string, ChatReplyQuote>();
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };

export function setPendingCompanionReplyQuote(sessionId: string, quote: ChatReplyQuote | null): void {
  if (quote) pending.set(sessionId, quote);
  else if (!pending.delete(sessionId)) return;
  notify();
}

export function getPendingCompanionReplyQuote(sessionId: string | null | undefined): ChatReplyQuote | null {
  return sessionId ? pending.get(sessionId) ?? null : null;
}

/** Drop the quote that was just sent, unless another one replaced it meanwhile. */
export function clearSentCompanionReplyQuote(sessionId: string, sent: ChatReplyQuote): void {
  if (pending.get(sessionId) === sent) setPendingCompanionReplyQuote(sessionId, null);
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export function usePendingCompanionReplyQuote(sessionId: string | null | undefined): ChatReplyQuote | null {
  return useSyncExternalStore(subscribe, () => getPendingCompanionReplyQuote(sessionId), () => null);
}

export type QuotableMessage = Pick<NormalizedRemoteMessage, 'kind' | 'body' | 'attachments'> & {
  source: Pick<NormalizedRemoteMessage['source'], 'clientId' | 'id'>;
};

/** What the user reads: a companion reply's components as their visible text, not their source. */
function readableText(message: QuotableMessage): string {
  return message.kind === 'assistant' ? richAnswerText(message.body) : message.body;
}

function attachmentSummary(message: QuotableMessage | undefined): { count: number; name: string | null } {
  const names = (message?.attachments ?? []).map(attachment => attachment.name).filter(name => !!name);
  return { count: names.length, name: names[0] ?? null };
}

/** The quote a reply on `message` carries; only owner and companion messages can be quoted. */
export function companionReplyQuoteFor(message: QuotableMessage): ChatReplyQuote | null {
  if (message.kind !== 'user' && message.kind !== 'assistant') return null;
  const clientId = message.source.clientId ?? message.source.id;
  if (!clientId) return null;
  const excerpt = chatReplyQuoteExcerpt(readableText(message));
  return { clientId, role: message.kind, excerpt: excerpt || attachmentSummary(message).name || '' };
}

/** From the original while it is loaded here, otherwise from the snapshot taken when sending. */
export function companionReplyQuoteDisplay(
  quote: ChatReplyQuote,
  original: QuotableMessage | undefined,
  names: { owner: string; companion: string },
): BotGroupQuoteDisplay {
  const authorName = quote.role === 'assistant' ? names.companion : names.owner;
  if (!original) return { state: 'snapshot', authorName, excerpt: quote.excerpt, attachmentCount: 0, attachmentName: null };
  const attachments = attachmentSummary(original);
  return {
    state: 'live',
    authorName,
    excerpt: chatReplyQuoteExcerpt(readableText(original)),
    attachmentCount: attachments.count,
    attachmentName: attachments.name,
  };
}
