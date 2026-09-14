import { createContext, useState, type ReactNode, type RefObject } from 'react';

export type MainViewKey = 'cc-agent' | 'issues' | 'plugins' | 'bots';

export interface MainViewHistory {
  lastMatchedKey: MainViewKey;
  paths: Partial<Record<MainViewKey, string>>;
  /** The router entry inherited at an owner change must not seed the new history. */
  ignoredLocationKey?: string;
}

export const MainViewHistoryContext = createContext<RefObject<MainViewHistory> | null>(null);

/** Keep view destinations across sidebar remounts, scoped to the current account's router. */
export function MainViewHistoryProvider({
  children,
  ownerKey = 'default',
  locationKey,
}: {
  children: ReactNode;
  ownerKey?: string;
  locationKey?: string;
}) {
  const [scope, setScope] = useState(() => ({
    ownerKey,
    history: { current: { lastMatchedKey: 'cc-agent', paths: {} } as MainViewHistory },
  }));
  if (scope.ownerKey !== ownerKey) {
    // Reset before descendants render. RouterProvider remounts with the same
    // router instance, so its current entry can still belong to the old owner.
    setScope({
      ownerKey,
      history: {
        current: { lastMatchedKey: 'cc-agent', paths: {}, ignoredLocationKey: locationKey },
      },
    });
  }
  return (
    <MainViewHistoryContext.Provider value={scope.history}>
      {children}
    </MainViewHistoryContext.Provider>
  );
}
