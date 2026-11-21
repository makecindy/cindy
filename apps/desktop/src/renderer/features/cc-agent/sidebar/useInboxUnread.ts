import { useEffect, useMemo, useState } from 'react';
import { LIVE_TASK_PRIORITY, taskInboxSection, taskSnoozeUntil, teammateInboxSection } from '@cindy/maker-shared/live-task-priority';
import type { Session } from '@/lib/ccAgent.types';
import type { TeammateInboxEntry } from '@/features/bots/teammateInbox';
import { getRemoteSessionActivity, useRemoteSessionActivityRevision } from '@/features/device-link/remoteSessionActivityStore';
import { sessionNaturalPriorityRank, type MainListPriorityContext } from '../lib/mainListModel';
import { getStartingSessionIds } from '@/lib/sessionStartingStore';
import { remoteSidebarPriorityRank } from '../lib/sidebarPriorityContext';

/** The button and inbox rows wake together when a snooze expires. */
export function useInboxUnread(
  sessions: readonly Session[],
  teammates: readonly TeammateInboxEntry[],
  priority: MainListPriorityContext,
  isTeammateTask: (session: Session) => boolean,
) {
  const remoteRevision = useRemoteSessionActivityRevision();
  const [now, setNow] = useState(Date.now);
  // Only the nearest expiry needs a timer; a focus reconciles time after sleep.
  useEffect(() => {
    const refresh = () => setNow(Date.now());
    const next = Math.min(...[...sessions.map(taskSnoozeUntil),
      ...teammates.map((entry) => taskSnoozeUntil(entry.snooze ?? {}))].filter((at) => at > now));
    const timer = Number.isFinite(next)
      ? setTimeout(refresh, Math.min(2_147_483_647, Math.max(1, next - Date.now())))
      : undefined;
    window.addEventListener('focus', refresh);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [sessions, teammates, now]);
  const hasUnread = useMemo(() => {
    if (teammates.some(entry =>
      (entry.status === 'done' || entry.status === 'unread')
      && teammateInboxSection(entry.status, entry.snooze, now) === 'inbox',
    )) return true;

    const starting = getStartingSessionIds();
    return sessions.some(session => {
      if (session.status === 'deleted') return false;
      const rank = session.deviceLinkDeviceId
        ? remoteSidebarPriorityRank(session, getRemoteSessionActivity(session.id, session.deviceLinkDeviceId)?.phase, priority, starting)
        : sessionNaturalPriorityRank(session, priority);
      const unread = rank === LIVE_TASK_PRIORITY.unread;
      return unread && taskInboxSection(session, {
        unread, waiting: false, running: false, teammate: isTeammateTask(session),
      }, now) === 'inbox';
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- remoteRevision tracks the activity read above.
  }, [sessions, teammates, priority, isTeammateTask, now, remoteRevision]);
  return { hasUnread, now };
}
