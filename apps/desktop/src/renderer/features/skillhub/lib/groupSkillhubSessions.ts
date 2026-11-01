import { groupSessions, type GroupSessionsOptions } from '@/features/cc-agent/lib/projectGrouping';
import type { Session } from '@/lib/ccAgent.types';
import { normalizeWorkingDirForStorage } from '../../../../shared/workingDir';

/** Keep the original spelling that identifies a SkillHub project independent of activity order. */
export function groupSkillhubSessions(sessions: readonly Session[], options: GroupSessionsOptions) {
  if (options.localPlatform !== 'win32') return groupSessions(sessions, options);

  // groupSessions takes its representative path from the first session. Pick a
  // deterministic original spelling before grouping; that function still orders
  // projects and their sessions by activity. Do not lowercase paths used for IO.
  const stableSessions = sessions
    .map((session) => ({ session, path: normalizeWorkingDirForStorage(session.workingDir) ?? '' }))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    .map(({ session }) => session);
  return groupSessions(stableSessions, options);
}
