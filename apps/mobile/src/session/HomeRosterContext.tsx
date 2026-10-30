import { createContext, useContext, type ReactNode } from 'react';
import { useIsFocused } from 'expo-router';
import { RemoteSessionStoreSubscriptionGate } from './remoteSessionStore';
import { useTeammateRoster } from './useTeammateRoster';
import { useBotGroupRoster } from './useBotGroupRoster';

const RosterContext = createContext<{
  roster: ReturnType<typeof useTeammateRoster>; groups: ReturnType<typeof useBotGroupRoster>;
} | null>(null);

/** One teammate and group-chat roster for the home, read while the home is in front. */
export function HomeRosterProvider({ children }: { children: ReactNode }) {
  const focused = useIsFocused();
  return <RemoteSessionStoreSubscriptionGate enabled={focused}>
    <HomeRosterContent>{children}</HomeRosterContent>
  </RemoteSessionStoreSubscriptionGate>;
}

function HomeRosterContent({ children }: { children: ReactNode }) {
  const focused = useIsFocused();
  const roster = useTeammateRoster(focused);
  const groups = useBotGroupRoster(roster.groupTargets, focused);
  return <RosterContext.Provider value={{ roster, groups }}>{children}</RosterContext.Provider>;
}
export const useHomeRoster = () => useContext(RosterContext);
