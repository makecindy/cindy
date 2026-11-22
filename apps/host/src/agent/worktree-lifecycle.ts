import fs from 'node:fs';
import path from 'node:path';
import { createPrecreatedCancellation } from '../../../desktop/src/main/worktree/precreatedCancellationCore.js';
import { configureWorktreeManagerPorts } from '../../../desktop/src/main/worktree/WorktreeManagerPorts.js';
import {
  cancelPrecreatedWorktree,
  createWorktree,
  discardPrecreatedWorktree,
  discardPrecreatedWorktreeByRecoveryKey,
  detectCwd,
  getForSession,
  listBranches,
  reconcilePendingSafeDirectoryCleanups,
  suggestName,
} from '../../../desktop/src/main/worktree/WorktreeManager.js';
import { readOriginDefaultBranch } from '../../../desktop/src/main/worktree/branchSync.js';
import { configureWorktreeStoreDbSync } from '../../../desktop/src/main/worktree/worktreeStoreCore.js';
import { getDbClient } from '../../../desktop/src/main/localDb/client/current.js';
import { sessions } from '../../../desktop/src/main/localDb/schema.js';
import { eq } from 'drizzle-orm';
import { throwIpcError } from '../../../desktop/src/main/utils/ipcValidate.js';

/**
 * Bind the shared Git lifecycle to this Host's profile. The general archive/recovery
 * recycler remains Desktop-only; the narrow precreated flow uses preserveDirty and
 * never enters that port.
 */
export function createHostWorktreeLifecycle(profileDir: string) {
  // runtimeLeases.readWorktreeRuntimePaths requires the registry directory even
  // when this Host has no Desktop instance record of its own.
  fs.mkdirSync(path.join(profileDir, '.dev-instances'), { recursive: true });
  const cancellation = createPrecreatedCancellation({
    app: { getPath: () => profileDir },
  });
  const syncWorktreePath = async (sessionId: string, worktreePath: string | null) => {
    await getDbClient().drizzle.update(sessions).set({ worktreePath })
      .where(eq(sessions.id, sessionId));
  };
  configureWorktreeStoreDbSync(syncWorktreePath);
  configureWorktreeManagerPorts({
    ...cancellation,
    recycleManagedWorktree: async () => {
      throwIpcError('UNSUPPORTED_CAPABILITY', 'General Worktree archive recovery is not available in the Node Host');
    },
  });

  return {
    async detect(cwd: string) {
      const result = await detectCwd(cwd);
      // The Host does not expose the main-checkout switch invoked by this flag.
      return { ...result, supportsRecoveryKeyDiscard: true, supportsCheckout: false };
    },
    async listBranches(baseRepo: string) {
      const branches = await listBranches(baseRepo);
      const remoteDefaultBranch = await readOriginDefaultBranch(baseRepo).catch(() => undefined);
      return { ...branches, remoteDefaultBranch };
    },
    suggestName,
    reconcilePendingSafeDirectoryCleanups,
    createWorktree,
    discardPrecreatedWorktree,
    discardPrecreatedWorktreeByRecoveryKey,
    cancelPrecreatedWorktree,
    /** A precreated Worktree is registered before its session row exists. */
    async backfillWorktreePath(sessionId: string): Promise<void> {
      const meta = getForSession(sessionId);
      if (meta?.path) await syncWorktreePath(sessionId, meta.path);
    },
  };
}

export type HostWorktreeLifecycle = ReturnType<typeof createHostWorktreeLifecycle>;
