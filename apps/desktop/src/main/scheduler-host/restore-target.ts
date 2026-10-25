import { createScheduledTargetRestore } from '@cindy/app-runtime/scheduledTargetRestore';
import {
  getSessionRowSnapshotStrict,
  restoreArchivedSessionForSend,
} from '../localDb/ipc/sessions';
import { withSessionRouteLock } from '../localDb/sessionRouteLock';
export { isManagedScheduledTarget } from '@cindy/app-runtime/scheduledTargetRestore';
export const restoreScheduledTarget = createScheduledTargetRestore({
  getSessionRowSnapshotStrict: (...args) => getSessionRowSnapshotStrict(...args),
  restoreArchivedSessionForSend: (...args) => restoreArchivedSessionForSend(...args),
  withSessionRouteLock: (...args) => withSessionRouteLock(...args),
  getManagedWorktreeReadinessForSession: async (...args) =>
    (await import('../worktree/restore')).getManagedWorktreeReadinessForSession(...args),
});
