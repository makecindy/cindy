import { createContext } from 'react';

/** Detached sidebar receives only the linked identity, not the full Bot profile list. */
export const DetachedBotMenuOwnerContext = createContext<{
  sessionId: string;
  botId: string;
  canonical: boolean;
} | null>(null);
