import { getSessionRowSnapshotStrict, restoreArchivedSessionForSend } from '../localDb/ipc/sessions';
import { getManagedWorktreeReadinessForSession } from '../worktree/restore';
import { createScheduledTargetRestorer } from './restore-target';
export { isManagedScheduledTarget } from './restore-target';

export const restoreScheduledTarget = createScheduledTargetRestorer({
  getSessionRowSnapshotStrict: (...args) => getSessionRowSnapshotStrict(...args),
  restoreArchivedSessionForSend: (...args) => restoreArchivedSessionForSend(...args),
  getManagedWorktreeReadinessForSession: (...args) => getManagedWorktreeReadinessForSession(...args),
});
