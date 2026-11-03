/**
 * 伙伴私聊里与引用有关的气泡上下文（docs/product-rules/cindy-bots-runtime.md「私聊引用回复」
 * 「回复对应的消息」）：气泡据此把「回复」变成引用回复、在正文上方画引用块、按偏好标出伙伴回复对应的消息。
 * 只依赖 React：气泡引用它不会顺带引入聊天 store。消息查找走调用方给的稳定读取函数，
 * 流式输出不会让每个气泡跟着重渲染。
 */
import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';

import type { ChatMessage } from '@/lib/makerChatStore';
import type { ChatReplyQuote } from '../../../shared/chatReplyQuote';

export interface BotChatQuoteValue {
  sessionId: string;
  names: { owner: string; companion: string };
  /** The message as this chat has it loaded. */
  getMessage: (clientId: string) => ChatMessage | undefined;
  /** Whether `assistantClientId` is the first loaded reply of the turn that answers `replyToClientId`. */
  isFirstReplyFor: (assistantClientId: string, replyToClientId: string) => boolean;
  /** 「显示回复对应的消息」. */
  showReplyTargets: boolean;
  /** Put a quote of this message above the composer. */
  quote: (quote: ChatReplyQuote) => void;
  /** Scroll to and highlight a message of this chat, loading it first when needed. */
  locate: (clientId: string) => void;
}

const BotChatQuoteContext = createContext<BotChatQuoteValue | null>(null);

export function BotChatQuoteProvider({ value, children }: { value: BotChatQuoteValue | null; children: ReactNode }) {
  return <BotChatQuoteContext.Provider value={value}>{children}</BotChatQuoteContext.Provider>;
}

/** The quote context of the companion chat a bubble is in; null in ordinary tasks. */
export function useBotChatQuote(sessionId: string | undefined): BotChatQuoteValue | null {
  const value = useContext(BotChatQuoteContext);
  return value && sessionId && value.sessionId === sessionId ? value : null;
}
