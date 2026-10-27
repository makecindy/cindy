import { createContext } from 'react';

/** Optional capability supplied only by a local companion view, not ordinary task messages. */
export type MessageReadAloud = {
  sessionId: string;
  available: boolean;
  disabled: boolean;
  messageId: string | null;
  phase: 'idle' | 'preparing' | 'playing' | 'error';
  canRead(text: string): boolean;
  toggle(messageId: string, text: string): void;
};
export const MessageReadAloudContext = createContext<MessageReadAloud | null>(null);
