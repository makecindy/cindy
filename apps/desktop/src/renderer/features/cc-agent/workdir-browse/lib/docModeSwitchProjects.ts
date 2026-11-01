import type { Session } from '@/lib/ccAgent.types';
import {
  compareSessionsBySortTimeDesc,
  extractDisplayName,
  normalizeWorkingDir,
  projectIdentityKeyForSession,
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

export function resolveDocModeFilesSession(
  sessions: readonly Session[],
  sessionId: string | undefined,
): Session | null {
  if (!sessionId) return null;
  return sessions.find((session) => session.id === sessionId) ?? null;
}
