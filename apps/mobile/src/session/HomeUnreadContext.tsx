import { createContext, useContext, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useIsFocused } from 'expo-router';
import { useAuth } from '@/auth/AuthContext';
import { isRemoteResourceUnread, remoteResourceCacheRevision, subscribeRemoteResourceCache } from '@/device-link/remoteResourceCache';
import { remoteSessionStore } from './remoteSessionStore';
import { resolveMobileSessionRightStatus } from './sessionRightStatus';
import { useTeammateRoster } from './useTeammateRoster';
import { useBotGroupRoster } from './useBotGroupRoster';

const ScheduleUnreadContext = createContext<(ids: ReadonlySet<string>) => void>(() => {});
export const usePublishHomeScheduleUnread = () => useContext(ScheduleUnreadContext);

const CountsContext = createContext({ tasks: 0, teammates: 0 });
const RosterContext = createContext<{
  roster: ReturnType<typeof useTeammateRoster>; groups: ReturnType<typeof useBotGroupRoster>;
} | null>(null);

/** The same mirrors as the rows, including while the other home section is active. */
export function HomeUnreadProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [scheduleUnread, setScheduleUnread] = useState<ReadonlySet<string>>(new Set());
  const focused = useIsFocused();
  const roster = useTeammateRoster(focused);
  const groups = useBotGroupRoster(roster.groupTargets, focused);
  useSyncExternalStore(subscribeRemoteResourceCache, remoteResourceCacheRevision);
  const tasks = useSyncExternalStore(remoteSessionStore.subscribe, () => {
    let count = 0;
    for (const session of remoteSessionStore.getSessions()) {
      if (session.status !== 'active' || session.orcaRole === 'worker' || session.source === 'bot' || session.source === 'scheduler' || session.source === 'learn'
        || session.title?.startsWith('[Schedule] ')) continue;
      const activity = remoteSessionStore.getSessionLiveActivity(session.id);
      const status = resolveMobileSessionRightStatus({ interruption: session, livePhase: activity?.phase,
        liveAttention: activity?.attention === true,
        pendingInteractionCount: remoteSessionStore.getPendingInteractions(session.id).length,
        running: remoteSessionStore.isSessionRunning(session.id), scheduleUnreadCount: 0 });
      if (status === 'done' && scheduleUnread.has(session.id)) continue;
      if (status === 'done' || status === 'awaiting' || status === 'error') count += 1;
    }
    return count;
  });
  const teammates = [...roster.items, ...groups.items].filter(row =>
    isRemoteResourceUnread(user?.id ?? '', row.host.deviceId, row.item.ref.id, row.item.display.lastReplyAt)).length;
  return <ScheduleUnreadContext.Provider value={setScheduleUnread}><RosterContext.Provider value={{ roster, groups }}><CountsContext.Provider value={{ tasks, teammates }}>{children}</CountsContext.Provider></RosterContext.Provider></ScheduleUnreadContext.Provider>;
}
export const useHomeUnreadCounts = () => useContext(CountsContext);
export const useHomeRoster = () => useContext(RosterContext);
