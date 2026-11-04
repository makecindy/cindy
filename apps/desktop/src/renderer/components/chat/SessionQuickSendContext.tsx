// Lets a message-level control send text as the user through the session's own send path; null outside the session view.
import { createContext, useContext } from 'react';

export interface SessionQuickSend {
  /** Resolves false when the session refused the message (read-only, locked, failed). */
  send(text: string, options?: { literalText?: boolean; independent?: boolean }): Promise<boolean>;
}

const SessionQuickSendContext = createContext<SessionQuickSend | null>(null);

export const SessionQuickSendProvider = SessionQuickSendContext.Provider;
export function useSessionQuickSend(): SessionQuickSend | null {
  return useContext(SessionQuickSendContext);
}
