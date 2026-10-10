import type { Session } from '@/lib/ccAgent.types';
import { deviceLinkProjectKey, projectIdentityKey } from '../../../../shared/projectKeys';
import { normalizeWorkingDirForGrouping } from '../../../../shared/workingDir';

type ProjectSession = Pick<Session, 'workingDir' | 'workspaceKind' | 'projectMoveTarget'>;

/** Presentation only: file browsing, messages and running agents still use Session.workingDir. */
export function sidebarSessionProject(session: ProjectSession) {
  const target = session.projectMoveTarget;
  return target
    ? {
        workingDir: target.workingDir,
        workspaceKind: target.workingDir === null ? ('dialogue' as const) : ('project' as const),
      }
    : { workingDir: session.workingDir, workspaceKind: session.workspaceKind };
}

export function sidebarProjectIdentityKeyForSession(
  session: ProjectSession & Pick<Session, 'remoteHostId' | 'deviceLinkDeviceId'>,
): string | null {
  const project = sidebarSessionProject(session);
  if (project.workspaceKind === 'dialogue') return null;
  const workingDir = normalizeWorkingDirForGrouping(project.workingDir);
  if (!workingDir) return null;
  return session.deviceLinkDeviceId
    ? deviceLinkProjectKey(session.deviceLinkDeviceId, workingDir)
    : projectIdentityKey(
        session.remoteHostId ? 'remote' : 'local',
        workingDir,
        session.remoteHostId ?? null,
      );
}
