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

export interface RestoreScheduledTargetOptions {
  /**
   * Whether a permanently gone managed worktree (`ready === 'gone'`) may fall back to the task's
   * unrestored-worktree conversation workspace (matching interactive send preflight).
   * Defaults to `true`; bound script runs whose own `workingDir` points at the gone worktree
   * pass `false` so shell scripts never execute in an empty conversation workspace.
   */
  allowUnrestoredWorktreeFallback?: boolean;
}

/** Scheduled input uses the ordinary restore boundary, including its managed-task
 * exclusions and multi-device status broadcast. Only a quiet round re-archives the task,
 * outside this restorer (quietRunArchive.ts). */
export function createScheduledTargetRestorer(runtime: {
  getSessionRowSnapshotStrict: typeof import('../localDb/sessionDispatchSnapshot').getSessionRowSnapshotStrict;
  restoreArchivedSessionForSend: typeof import('../localDb/ipc/sessions').restoreArchivedSessionForSend;
  getManagedWorktreeReadinessForSession: typeof getManagedWorktreeReadinessForSession;
  isWorkingDirectoryFallback?: (sessionId: string, workingDir: string) => boolean;
  recoverUnrestoredWorktree?: (sessionId: string, workingDir: string) => Promise<boolean>;
}) {
return async function restoreScheduledTarget(
  sessionId: string,
  target: Pick<SessionRowSnapshot, 'status' | 'workingDir' | 'remoteHostId'> & ScheduledTargetLifecycle,
  signal?: AbortSignal,
  options?: RestoreScheduledTargetOptions,
): Promise<void> {
  signal?.throwIfAborted();
  if (isManagedScheduledTarget(target)) return;
  const dir = target.workingDir;
  const isManagedDir = (candidate: string | null | undefined): boolean =>
    Boolean(!target.remoteHostId && candidate && getManagedWorktreeBasePath(path.resolve(candidate).replace(/\\/g, '/')));
  const managed = isManagedDir(dir);
  if (target.status !== 'archived' && !managed) return;
  await withSessionRouteLock(sessionId, async () => {
    signal?.throwIfAborted();
    let effectiveDir = dir;
    if (target.status === 'archived') {
      await runtime.restoreArchivedSessionForSend(sessionId, { routeLockHeld: true, signal });
    } else {
      const current = await runtime.getSessionRowSnapshotStrict(sessionId);
      if (!current || current.status === 'archived' || current.status === 'deleted') {
        throw new Error('Scheduled target became unavailable during preparation');
      }
      if (current.workingDir !== undefined) effectiveDir = current.workingDir;
    }
    // Hooks run before native session startup. Reuse send-time snapshot recovery
    // before either a hook or an Agent can touch a recycled managed worktree.
    // Match ordinary send preflight for permanently gone worktrees: stay on an
    // active runtime fallback or fall back on `gone`, while keeping `retry` fail-closed.
    if (isManagedDir(effectiveDir) && effectiveDir) {
      const allowFallback = options?.allowUnrestoredWorktreeFallback !== false;
      if (allowFallback && runtime.isWorkingDirectoryFallback?.(sessionId, effectiveDir)) {
        const ok = (await runtime.recoverUnrestoredWorktree?.(sessionId, effectiveDir)) === true;
        if (!ok) throw new Error('Scheduled task worktree could not be restored');
      } else {
        const ready = await runtime.getManagedWorktreeReadinessForSession(sessionId, effectiveDir);
        if (ready !== 'ready') {
          const recovered =
            ready === 'gone' &&
            allowFallback &&
            (await runtime.recoverUnrestoredWorktree?.(sessionId, effectiveDir)) === true;
          if (!recovered) throw new Error('Scheduled task worktree could not be restored');
        }
      }
    }
    signal?.throwIfAborted();
  });
};
}
