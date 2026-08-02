import type { Session } from '@/lib/ccAgent.types';

import { projectIdentityKeyForSession, type ProjectNode } from './projectGrouping';

type SidebarProjectSession = Pick<
  Session,
  'workingDir' | 'remoteHostId' | 'deviceLinkDeviceId' | 'workspaceKind'
>;

/**
 * Sidebar-only project visibility.
 *
 * Hidden project keys are a negative overlay on top of the session-derived
 * project catalogue. Session state and project membership remain untouched.
 */
export function isProjectHidden(
  projectKey: string,
  hiddenProjectKeys: ReadonlySet<string>,
): boolean {
  return hiddenProjectKeys.has(projectKey);
}

export function isSessionInHiddenProject(
  session: SidebarProjectSession,
  hiddenProjectKeys: ReadonlySet<string>,
): boolean {
  // Dialogue tasks own a working directory too, but that directory is not a
  // user-added project and must never be hidden by a project tombstone.
  if (session.workspaceKind === 'dialogue') return false;
  const projectKey = projectIdentityKeyForSession(session);
  return projectKey != null && hiddenProjectKeys.has(projectKey);
}

export function visibleSidebarProjects(
  projects: readonly ProjectNode[],
  hiddenProjectKeys: ReadonlySet<string>,
): ProjectNode[] {
  if (hiddenProjectKeys.size === 0) return Array.from(projects);
  return projects.filter((project) => !isProjectHidden(project.projectKey, hiddenProjectKeys));
}

/**
 * Build the sidebar presentation without mutating the persisted session.
 *
 * A removed project's tasks stay associated with their working directory so
 * re-adding that directory can restore the original grouping. While the
 * project is hidden, present those tasks as ordinary Chat entries instead of
 * dropping them from the sidebar altogether.
 */
export function sidebarSessionsWithHiddenProjectsAsDialogues(
  sessions: readonly Session[],
  hiddenProjectKeys: ReadonlySet<string>,
): Session[] {
  if (hiddenProjectKeys.size === 0) return Array.from(sessions);
  return sessions.map((session) =>
    isSessionInHiddenProject(session, hiddenProjectKeys)
      ? { ...session, workspaceKind: 'dialogue' }
      : session,
  );
}
