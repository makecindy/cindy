import { createContext } from 'react';

export const MessageContentLongPressContext = createContext<(() => void) | undefined>(undefined);
