/**
 * 伙伴私聊的引用块（docs/product-rules/cindy-bots-runtime.md「私聊引用回复」「回复对应的消息」），
 * 与群聊引用回复同一组件：主人消息里的引用、伙伴回复上方「回复对应的消息」、输入框上方等待发出的引用。
 */
import type { ChatMessage } from '@/lib/makerChatStore';
import type { ChatReplyQuote } from '../../../shared/chatReplyQuote';
import { BotGroupQuoteBlock, BotGroupQuotePreview } from './BotGroupQuote';
import type { BotChatQuoteValue } from './botChatQuoteContext';
import { botReplyQuoteDisplay, botReplyQuoteFor, setPendingBotReplyQuote } from './botDmQuote';

/** The quote an owner message carries, above its text; clicking goes to the original. */
export function BotChatQuoteInBubble({ quote, context, align = 'right' }: {
  quote: ChatReplyQuote;
  context: BotChatQuoteValue;
  align?: 'left' | 'right';
}) {
  const display = botReplyQuoteDisplay(quote, context.getMessage(quote.clientId), context.names);
  return <BotGroupQuoteBlock display={display} align={align} onLocate={() => context.locate(quote.clientId)} />;
}

/** A message the companion's reply can point back to: a visible message the owner typed. */
function isOwnerMessage(message: ChatMessage | undefined): message is ChatMessage {
  return !!message && message.role === 'user' && !message.isSyntheticTrigger && !message.automationOrigin
    && !message.hookSource && !message.blockedByGhost;
}

/**
 * 「回复对应的消息」: above the first reply of a turn, the owner message that turn answers.
 * Only with the setting on, only when that message is loaded here; nothing for older replies
 * that never recorded it.
 */
export function BotChatReplyTarget({ message, context }: {
  message: Pick<ChatMessage, 'clientId' | 'replyToClientId'>;
  context: BotChatQuoteValue;
}) {
  const target = message.replyToClientId;
  if (!context.showReplyTargets || !target) return null;
  const original = context.getMessage(target);
  if (!isOwnerMessage(original) || !context.isFirstReplyFor(message.clientId, target)) return null;
  const quote = botReplyQuoteFor(original);
  if (!quote) return null;
  return (
    <div data-bot-reply-target={target} className="mb-1.5 flex min-w-0 max-w-full">
      <BotGroupQuoteBlock display={botReplyQuoteDisplay(quote, original, context.names)}
        onLocate={() => context.locate(target)} />
    </div>
  );
}

/** The quote waiting above the composer; removing it keeps whatever was typed. */
export function BotChatQuoteComposerPreview({ sessionId, quote, getMessage, names }: {
  sessionId: string;
  quote: ChatReplyQuote;
  getMessage: (clientId: string) => ChatMessage | undefined;
  names: BotChatQuoteValue['names'];
}) {
  return (
    <div className="px-3 py-2">
      <BotGroupQuotePreview display={botReplyQuoteDisplay(quote, getMessage(quote.clientId), names)}
        onRemove={() => setPendingBotReplyQuote(sessionId, null)} />
    </div>
  );
}
