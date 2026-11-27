import { getSessionRowSnapshotStrict, restoreArchivedSessionForSend } from '../localDb/ipc/sessions';
import { workingDirectoryRecovery } from '../maker-ipc/workingDirectoryRecovery.desktop.js';
import { getManagedWorktreeReadinessForSession } from '../worktree/restore';
import { createScheduledTargetRestorer } from './restore-target';
export { isManagedScheduledTarget } from './restore-target';

export const restoreScheduledTarget = createScheduledTargetRestorer({
  getSessionRowSnapshotStrict: (...args) => getSessionRowSnapshotStrict(...args),
  restoreArchivedSessionForSend: (...args) => restoreArchivedSessionForSend(...args),
  getManagedWorktreeReadinessForSession: (...args) => getManagedWorktreeReadinessForSession(...args),
  isWorkingDirectoryFallback: (sessionId, workingDir) =>
    workingDirectoryRecovery.isFallback(sessionId, workingDir),
  recoverUnrestoredWorktree: (sessionId, workingDir) =>
    workingDirectoryRecovery.recover(sessionId, workingDir, undefined, [], 'unrestored-worktree'),
});
