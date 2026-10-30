import { createContext, useContext } from 'react';
import type { RichMessageSender } from '@cindy/maker-shared/rich-answer';

/** Only writable conversation surfaces supply a sender. Previews and cloud history do not. */
const SessionQuickSendContext = createContext<RichMessageSender | null>(null);
export const SessionQuickSendProvider = SessionQuickSendContext.Provider;
export const useSessionQuickSend = () => useContext(SessionQuickSendContext);
