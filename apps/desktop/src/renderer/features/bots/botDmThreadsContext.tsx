/**
 * 私聊话题在消息气泡这一侧的上下文（docs/product-rules/cindy-bots-runtime.md「私聊话题」）：
 * 气泡据此显示「话题」按钮与根消息下的入口行。只依赖 React，气泡引用它不会顺带引入聊天 store；
 * 话题列表的读取见 botDmThreads.tsx，面板见 BotDmThreadViews。
 */
import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';

import type { BotDmThreadSummary } from '../../../shared/botDmThread';
import type { BotChatIdentity } from './BotSessionContentHeader';

export interface BotDmThreadsValue {
  /** The private chat's companion. */
  botId: string;
  botName: string;
  bot: BotChatIdentity;
  /** The main Chat whose messages carry topics; bubbles of any other Session show none. */
  rootSessionId: string;
  /** Topics by the clientId of the main-chat message they were opened on. */
  threads: ReadonlyMap<string, BotDmThreadSummary>;
  /** The root whose topic panel is open, if any. */
  openRootClientId: string | null;
  isUnread: (thread: BotDmThreadSummary) => boolean;
  openThread: (rootClientId: string) => void;
}

const BotDmThreadsContext = createContext<BotDmThreadsValue | null>(null);

export function BotDmThreadsProvider({ value, children }: { value: BotDmThreadsValue | null; children: ReactNode }) {
  return <BotDmThreadsContext.Provider value={value}>{children}</BotDmThreadsContext.Provider>;
}

/** The private-chat topics around one message bubble; null outside a local companion chat. */
export function useBotDmThreads(): BotDmThreadsValue | null {
  return useContext(BotDmThreadsContext);
}

/** Topic actions for one bubble: only messages of the main Chat itself, never inside a topic. */
export function useBotDmThreadForMessage(sessionId: string | undefined, clientId: string | undefined) {
  const value = useBotDmThreads();
  if (!value || !sessionId || !clientId || sessionId !== value.rootSessionId) return null;
  const thread = value.threads.get(clientId) ?? null;
  return {
    bot: value.bot,
    thread,
    unread: thread ? value.isUnread(thread) : false,
    isOpen: value.openRootClientId === clientId,
    open: () => value.openThread(clientId),
  };
}
