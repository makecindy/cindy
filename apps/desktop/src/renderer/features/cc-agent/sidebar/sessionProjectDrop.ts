import { isSharedTaskPeer } from '@cindy/device-link';
import type { Session } from '@/lib/ccAgent.types';
import { isCindyMakeFamilySource } from '../../../../shared/cindyMakeMerge';
import { isEmptyDraftSession } from '../lib/sessionDisplayTitle';
import { isRemoteSessionWriteBlocked } from '../lib/remoteSessionWriteGuard';
import { normalizeWorkingDir, type ProjectNode } from '../lib/projectGrouping';
import type { SessionMoveTarget } from './sessionMoveTarget';
import { sidebarSessionProject } from '../lib/sidebarSessionProject';

/** The menu and drag affordance share availability; the host remains the authority for moves. */
export function canOfferSessionProjectMove(session: Session): boolean {
  return (
    session.status === 'active' &&
    !isEmptyDraftSession(session) &&
    !session.remoteHostId &&
    !session.agentDeviceId &&
    session.source !== 'review' &&
    session.source !== 'bot' &&
    !isCindyMakeFamilySource(session.source) &&
    session.orcaRole !== 'worker' &&
    !isSharedTaskPeer(session.deviceLinkDeviceId ?? '')
  );
}

export type SessionProjectDropTarget =
  | { kind: 'project'; project: ProjectNode }
  // undefined means the combined dialogue group: retain the dragged task's owner.
  | { kind: 'dialogue'; deviceId?: string | null };

/** A drag reorganizes one computer's tasks. Moving between computers stays in the migration menu. */
export function resolveSessionProjectDrop(
  session: Session,
  target: SessionProjectDropTarget,
): SessionMoveTarget | null {
  if (!canOfferSessionProjectMove(session) || isRemoteSessionWriteBlocked(session)) return null;
  const sourceDevice = session.deviceLinkDeviceId ?? null;
  const currentProject = sidebarSessionProject(session);
  if (target.kind === 'dialogue') {
    if (currentProject.workspaceKind === 'dialogue') return null;
    if (target.deviceId !== undefined && target.deviceId !== sourceDevice) return null;
    return { kind: 'dialogue' };
  }
  const project = target.project;
  if (project.remoteHostId || project.deviceLinkConnectionStatus === 'disconnected') return null;
  if ((project.deviceLinkDeviceId ?? null) !== sourceDevice) return null;
  if (
    currentProject.workspaceKind !== 'dialogue' &&
    normalizeWorkingDir(currentProject.workingDir) === normalizeWorkingDir(project.workingDir)
  )
    return null;
  return { kind: 'project', workingDir: project.workingDir };
}
