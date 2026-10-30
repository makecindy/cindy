import { resolveProjectAliasForSessions, type ProjectAliasesByDevice } from '@cindy/maker-shared/project-alias-sync';
import { collapseWorktreeDirForGrouping } from '@cindy/maker-shared/worktree-paths';
import { stripTrailingPathSeparators } from '@cindy/maker-shared/path-text';
import type { RemoteSession } from './types';

/** Route names are only a first-paint hint, never authority after a host snapshot arrives. */
export function resolveMobileProjectRouteTitle(input: {
  deviceId: string;
  workingDir: string | null;
  routeTitle: string | null;
  sessions: readonly RemoteSession[];
  projectAliases: ProjectAliasesByDevice;
}): string | null {
  if (!input.workingDir) return input.routeTitle;
  const alias = resolveProjectAliasForSessions(input.sessions, input.projectAliases, input.deviceId);
  if (alias) return alias;
  const known = input.projectAliases.has(input.deviceId)
    || input.sessions.some((session) => input.projectAliases.has(session.deviceLinkDeviceId ?? input.deviceId));
  if (!known && input.routeTitle) return input.routeTitle;
  const dir = collapseWorktreeDirForGrouping(stripTrailingPathSeparators(input.workingDir));
  return dir.split(/[\\/]/).filter(Boolean).at(-1) || dir;
}
