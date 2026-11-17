import path from 'node:path';

import { getManagedWorktreeBasePath } from '../../shared/managedWorktreePaths';
import type { SessionRowSnapshot } from '../localDb/sessionDispatchSnapshot';
import { withSessionRouteLock } from '../localDb/sessionRouteLock';
import type { getManagedWorktreeReadinessForSession } from '../worktree/restore';

type ScheduledTargetLifecycle = Pick<SessionRowSnapshot, 'source' | 'orcaRole' | 'orcaRemoteLead'>;

/** Service-owned tasks keep their existing archive/retirement lifecycle. */
export function isManagedScheduledTarget(target: ScheduledTargetLifecycle): boolean {
  return target.source === 'bot' || target.source === 'review'
    || target.orcaRole === 'worker' || !!target.orcaRemoteLead;
}

/** Scheduled input uses the ordinary restore boundary, including its managed-task
 * exclusions and multi-device status broadcast. Never archive again after a run. */
export function createScheduledTargetRestorer(runtime: {
  getSessionRowSnapshotStrict: typeof import('../localDb/sessionDispatchSnapshot').getSessionRowSnapshotStrict;
  restoreArchivedSessionForSend: typeof import('../localDb/ipc/sessions').restoreArchivedSessionForSend;
  getManagedWorktreeReadinessForSession: typeof getManagedWorktreeReadinessForSession;
}) {
return async function restoreScheduledTarget(
  sessionId: string,
  target: Pick<SessionRowSnapshot, 'status' | 'workingDir' | 'remoteHostId'> & ScheduledTargetLifecycle,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  if (isManagedScheduledTarget(target)) return;
  const dir = target.workingDir;
  const managed = !target.remoteHostId && dir && getManagedWorktreeBasePath(path.resolve(dir).replace(/\\/g, '/'));
  if (target.status !== 'archived' && !managed) return;
  await withSessionRouteLock(sessionId, async () => {
    signal?.throwIfAborted();
    if (target.status === 'archived') {
      await runtime.restoreArchivedSessionForSend(sessionId, { routeLockHeld: true, signal });
    } else {
      const current = await runtime.getSessionRowSnapshotStrict(sessionId);
      if (!current || current.status === 'archived' || current.status === 'deleted') {
        throw new Error('Scheduled target became unavailable during preparation');
      }
    }
    // Hooks run before native session startup. Reuse send-time snapshot recovery
    // before either a hook or an Agent can touch a recycled managed worktree.
    if (managed && dir) {
      const ready = await runtime.getManagedWorktreeReadinessForSession(sessionId, dir);
      if (ready !== 'ready') throw new Error('Scheduled task worktree could not be restored');
    }
    signal?.throwIfAborted();
  });
};
}
