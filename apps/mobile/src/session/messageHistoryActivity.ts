import { createContext, useContext } from 'react';

export const MessageHistoryActive = createContext<boolean | undefined>(undefined);
export const MessageHistoryPositioning = createContext(true);
export const useMessageHistoryPositioning = () => useContext(MessageHistoryPositioning);
export const useMessageHistoryActive = () => useContext(MessageHistoryActive) ?? true;
