import { createContext, useCallback, useContext, useId, useLayoutEffect, useState, type ReactNode } from 'react';
import { useIsFocused } from 'expo-router';
import { RemoteSessionStoreSubscriptionGate } from './remoteSessionStore';
import { useTeammateRoster } from './useTeammateRoster';
import { useBotGroupRoster } from './useBotGroupRoster';

const RosterContext = createContext<{
  roster: ReturnType<typeof useTeammateRoster>; groups: ReturnType<typeof useBotGroupRoster>;
} | null>(null);

const ReadersContext = createContext<((owner: string, active: boolean) => void) | null>(null);

/** Account-scoped data, independent of native screen ownership. Moving between
 * task/private/group screens must not rediscover capabilities or discard the
 * current-epoch collection receipts that authorize legacy group rows. */
export function HomeRosterStoreProvider({ children }: { children: ReactNode }) {
  const [readers, setReaders] = useState<ReadonlySet<string>>(() => new Set());
  const setReader = useCallback((owner: string, active: boolean) => {
    setReaders(old => {
      if (old.has(owner) === active) return old;
      const next = new Set(old);
      if (active) next.add(owner); else next.delete(owner);
      return next;
    });
  }, []);
  const enabled = readers.size > 0;
  return <ReadersContext.Provider value={setReader}>
    <HomeRosterContent enabled={enabled}>{children}</HomeRosterContent>
  </ReadersContext.Provider>;
}

/** Visible Homes share one reader; hidden drawers keep data without polling. */
export function HomeRosterProvider({ children }: { children: ReactNode }) {
  const focused = useIsFocused();
  const setReader = useContext(ReadersContext);
  const owner = useId();
  useLayoutEffect(() => {
    setReader?.(owner, focused);
    return () => setReader?.(owner, false);
  }, [setReader, owner, focused]);
  if (setReader) return children;
  // Standalone surfaces and component previews retain their own reader.
  return <RemoteSessionStoreSubscriptionGate enabled={focused}>
    <HomeRosterContent enabled={focused}>{children}</HomeRosterContent>
  </RemoteSessionStoreSubscriptionGate>;
}

function HomeRosterContent({ children, enabled }: { children: ReactNode; enabled: boolean }) {
  const roster = useTeammateRoster(enabled);
  const groups = useBotGroupRoster(roster.groupTargets, enabled);
  return <RosterContext.Provider value={{ roster, groups }}>{children}</RosterContext.Provider>;
}
export const useHomeRoster = () => useContext(RosterContext);
