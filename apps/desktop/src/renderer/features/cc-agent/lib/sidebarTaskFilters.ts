import { matchesTaskCreators } from '@/features/bots/botFollowScopes';
import type { Session } from '@/lib/ccAgent.types';
import type { UseSidebarFilterReturn } from '../hooks/useSidebarFilter';
import { isAutomationSidebarSession } from './automationSidebarGrouping';
import { sessionActivityMs } from './dateSessionGrouping';

type TaskContentFilters = Pick<UseSidebarFilterReturn, 'lastActivity' | 'creators' | 'hideAutomations'> & {
  hideTaskCreated?: boolean;
};

const LAST_ACTIVITY_DAY_COUNTS: Record<Exclude<TaskContentFilters['lastActivity'], 'all'>, number> = {
  '1d': 1,
  '3d': 3,
  '7d': 7,
  '30d': 30,
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function cutoffForLastActivity(lastActivity: TaskContentFilters['lastActivity']): number | null {
  if (lastActivity === 'all') return null;
  return Date.now() - LAST_ACTIVITY_DAY_COUNTS[lastActivity] * DAY_MS;
}

/** Both modes narrow individual tasks before grouping. Pinned rows use their own unfiltered catalogue. */
export function filterSidebarTasks(
  sessions: Session[],
  { hideAutomations, hideTaskCreated = false, creators, lastActivity }: TaskContentFilters,
  creatorIndex: ReadonlyMap<string, ReadonlySet<string>>,
): Session[] {
  const cutoff = cutoffForLastActivity(lastActivity);
  if (!hideAutomations && !hideTaskCreated && creators === 'all' && cutoff === null) return sessions;
  return sessions.filter(session =>
    (!hideAutomations || !isAutomationSidebarSession(session))
    && (!hideTaskCreated || !session.createdBySession)
    && (cutoff === null || sessionActivityMs(session) >= cutoff)
    && matchesTaskCreators(session, creators, creatorIndex));
}
