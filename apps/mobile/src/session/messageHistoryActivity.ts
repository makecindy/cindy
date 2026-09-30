import { createContext, useContext } from 'react';

export const MessageHistoryActive = createContext(true);
export const MessageHistoryPositioning = createContext(true);
export const useMessageHistoryPositioning = () => useContext(MessageHistoryPositioning);
export const useMessageHistoryActive = () => useContext(MessageHistoryActive);
