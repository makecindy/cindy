import type { Session } from '@/lib/ccAgent.types';
import {
  compareSessionsBySortTimeDesc,
  extractDisplayName,
  normalizeWorkingDir,
  projectIdentityKeyForSession,
  type ProjectNode,
} from '../../lib/projectGrouping';

export interface DocModeSwitchProject {
  projectKey: string;
  displayName: string;
  sessionId: string;
  activeSessionCount: number;
}

/**
 * Builds the doc-mode project switcher from active local sessions.
 * Pinned sessions are included here because the switcher is project-scoped,
 * not sidebar-bucket-scoped.
 */
export function buildDocModeSwitchProjects(
  sessions: readonly Session[],
): DocModeSwitchProject[] {
  const groups = new Map<string, Session[]>();
  const workingDirByKey = new Map<string, string>();

  for (const session of sessions) {
    if (session.status !== 'active') continue;
    if (session.workspaceKind !== 'project') continue;
    if (session.remoteHostId) continue;
    const workingDir = normalizeWorkingDir(session.projectDir ?? session.workingDir);
    if (!workingDir) continue;
    const projectKey = projectIdentityKeyForSession(session);
    if (!projectKey) continue;
    const list = groups.get(projectKey);
    if (list) list.push(session);
    else groups.set(projectKey, [session]);
    if (!workingDirByKey.has(projectKey)) {
      workingDirByKey.set(projectKey, workingDir);
    }
  }

  const allWorkingDirs = Array.from(workingDirByKey.values());
  return Array.from(groups.entries())
    .map(([projectKey, projectSessions]) => {
      const sortedSessions = projectSessions.slice().sort(compareSessionsBySortTimeDesc);
      const workingDir = workingDirByKey.get(projectKey) ?? '';
      return {
        projectKey,
        displayName: extractDisplayName(workingDir, allWorkingDirs).name,
        sessionId: sortedSessions[0]?.id ?? '',
        activeSessionCount: projectSessions.length,
      };
    })
    .filter((project) => project.sessionId !== '');
}

export function shouldIgnoreDocModeProjectSwitch(
  project: DocModeSwitchProject,
  currentProjectKey: string | null,
  currentSessionId: string,
): boolean {
  return project.projectKey === currentProjectKey || project.sessionId === currentSessionId;
}

export function hasSwitchableDocModeProject(
  projects: readonly DocModeSwitchProject[],
  currentProjectKey: string | null,
  currentSessionId: string,
): boolean {
  return projects.some(
    (project) => !shouldIgnoreDocModeProjectSwitch(project, currentProjectKey, currentSessionId),
  );
}

/** Open the active task's workspace if it belongs to this project, otherwise a project member's. */
export function projectFilesRoute(
  project: Pick<ProjectNode, 'projectKey' | 'sessions'>,
  activeSessionId: string | undefined,
  sessions: readonly Session[],
): string | null {
  const inProject = (s: Session) =>
    !!s.workingDir && s.status !== 'deleted' && projectIdentityKeyForSession(s) === project.projectKey;
  const active = (s: Session) => s.id === activeSessionId && inProject(s);
  const target =
    sessions.find(active) ?? project.sessions.find(active) ??
    sessions.find(inProject) ?? project.sessions.find(inProject);
  if (!target) return null;
  const query = target.deviceLinkDeviceId ? `?device=${encodeURIComponent(target.deviceLinkDeviceId)}` : '';
  return `/cc-agent/files/${encodeURIComponent(target.id)}${query}`;
}

export function resolveDocModeFilesSession(
  sessions: readonly Session[],
  sessionId: string | undefined,
  remoteSessions: readonly Session[] = [],
  deviceId: string | null = null,
): Session | null {
  if (!sessionId) return null;
  // An explicitly targeted device must never fall back to the controller or a
  // different mirror while its task list is reconnecting.
  if (deviceId) {
    return remoteSessions.find((s) => s.id === sessionId && s.deviceLinkDeviceId === deviceId) ?? null;
  }
  return sessions.find((s) => s.id === sessionId) ?? remoteSessions.find((s) => s.id === sessionId) ?? null;
}
