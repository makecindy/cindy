import { createContext, useRef, type ReactNode, type RefObject } from 'react';

export type MainViewKey = 'cc-agent' | 'issues' | 'plugins' | 'bots';

export interface MainViewHistory {
  lastMatchedKey: MainViewKey;
  paths: Partial<Record<MainViewKey, string>>;
}

export const MainViewHistoryContext = createContext<RefObject<MainViewHistory> | null>(null);

/** Keep view destinations across sidebar remounts, scoped to the current account's router. */
export function MainViewHistoryProvider({ children }: { children: ReactNode }) {
  const history = useRef<MainViewHistory>({ lastMatchedKey: 'cc-agent', paths: {} });
  return <MainViewHistoryContext.Provider value={history}>{children}</MainViewHistoryContext.Provider>;
}
