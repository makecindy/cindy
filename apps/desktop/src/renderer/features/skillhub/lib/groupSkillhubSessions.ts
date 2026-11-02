import { groupSessions, type GroupSessionsOptions } from '@/features/cc-agent/lib/projectGrouping';
import type { Session } from '@/lib/ccAgent.types';
import { sessionProjectDirectory } from '@cindy/maker-shared/worktree-paths';
import { normalizeWorkingDirForStorage } from '../../../../shared/workingDir';

/** Keep the original spelling that identifies a SkillHub project independent of activity order. */
export function groupSkillhubSessions(sessions: readonly Session[], options: GroupSessionsOptions) {
  if (options.localPlatform !== 'win32') return groupSessions(sessions, options);

  // groupSessions takes its representative path from the first session. Pick a
  // deterministic original spelling before grouping; that function still orders
  // projects and their sessions by activity. Sort by the same project directory
  // groupSessions groups on (explicit projectDir wins over cwd), so an alias set
  // sharing one cwd stays stable too. Do not lowercase paths used for IO.
  const stableSessions = sessions
    .map((session) => ({ session, path: normalizeWorkingDirForStorage(sessionProjectDirectory(session)) ?? '' }))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    .map(({ session }) => session);
  return groupSessions(stableSessions, options);
}
