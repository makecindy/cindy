import fs from 'node:fs/promises';
import path from 'node:path';
import { canRecreateOwnerWorkingDirectory, createWorkingDirectoryRecovery, isUnavailableFilesystemError } from '../../../desktop/src/main/maker-ipc/workingDirectoryRecovery.ts';
import { isAppSessionBoundaryPending } from '../../../desktop/src/main/appSessionState.ts';
import { ownerScopedPath } from '../../../desktop/src/main/ownerContext.ts';
import { createWorkingDirectoryPreflight } from '../../../desktop/src/main/maker-ipc/workingDirectoryPreflight.ts';
import {
  allocateDialogueRecoveryWorkspace, findDialogueRecoveryWorkspace, requiredDialogueRecoveryRoot,
} from '../../../desktop/src/main/maker-ipc/dialogueRecoveryWorkspace.ts';
import { dialogueWorkspaceRoots } from '../../../desktop/src/main/dialogue-workspace-settings.ts';
import {
  findSimilarWorkingDirectory, mkdirWorkingDirectory, realpathWorkingDirectory, statWorkingDirectory,
} from '../../../desktop/src/main/workdir-probe-host/index.ts';
import { getManagedWorktreeBasePath } from '../../../desktop/src/shared/managedWorktreePaths.ts';
import { isCindyMakeWorktreePath } from '../../../desktop/src/main/cindy-make/sourcePaths.ts';
import { getUserDataDir } from '../../../desktop/src/main/userDataPath.ts';
import { throwIpcError } from '../../../desktop/src/main/utils/ipcValidate.ts';
import { createLogger, type Logger } from '../../../desktop/src/main/logger.ts';
import { explicitPorts } from './explicit-ports.ts';

type Stat = Parameters<typeof createWorkingDirectoryPreflight>[0]['statWorkingDirectory'];

/**
 * A task's working directory before a send, with the desktop's shared check and recovery
 * (register.ts `checkWorkDirExists` and `workingDirectoryRecovery`): the same preflight factory, the
 * same recovery, the same conversation recovery directories in the profile, the same directory probes
 * (workdir-probe-host, bounded and with a deadline). An ordinary directory that is gone continues in
 * a recovery directory, and the next send carries the recovery note once.
 *
 * Two ports differ:
 * - Managed worktree readiness: the desktop restores a missing worktree with Git and turns to a
 *   recovery directory only when it cannot (`gone`). The Host does not restore worktrees: a managed
 *   worktree directory that exists is ready, anything else is `retry`, so the send fails as it did
 *   before. The Host must not answer `gone` until worktree restoration is on the Host: that would move
 *   the task to a recovery directory where the desktop would have restored the worktree.
 * - A Cindy Make workspace is refused, as the Host refuses Cindy Make input.
 * A missing directory is logged; the send's failure (`WORKDIR_MISSING`) reaches the client as before.
 */
export function createHostWorkingDirectory(deps: {
  stat?: Stat;
  readBoundWorkingDir(sessionId: string): Promise<readonly (string | null)[]>;
  listActiveSessions(): { id: string; workDir: string; remoteHostId?: string | null }[];
  log: Pick<Logger, 'debug' | 'info' | 'warn'>;
}) {
  const stat = deps.stat ?? statWorkingDirectory;
  const workdirLog = createLogger('workdir-diagnostics');
  const recovery = createWorkingDirectoryRecovery(explicitPorts<Parameters<typeof createWorkingDirectoryRecovery>[0]>({
    stat, mkdir: mkdirWorkingDirectory, realpath: realpathWorkingDirectory,
    requiredRoot: requiredDialogueRecoveryRoot, findFallback: findDialogueRecoveryWorkspace,
    // As the desktop (register.ts, main e322628568): only the active owner's namespace is recreated,
    // and nothing during an account switch.
    canRecreateDirectory: (dir: string) => !isAppSessionBoundaryPending()
      && canRecreateOwnerWorkingDirectory(getUserDataDir(), ownerScopedPath(), dir),
  }), allocateDialogueRecoveryWorkspace, workdirLog);
  const checkWorkDirExists = createWorkingDirectoryPreflight(explicitPorts<Parameters<typeof createWorkingDirectoryPreflight>[0]>({
    workingDirectoryRecovery: recovery,
    statWorkingDirectory: stat,
    readBoundWorkingDir: deps.readBoundWorkingDir,
    getUserDataPath: getUserDataDir,
    isCindyMakeWorktreePath,
    assertCindyMakeWorkspace: async () => {
      throwIpcError('UNSUPPORTED_CAPABILITY', 'Host does not yet support managed product tasks');
    },
    getManagedWorktreeBasePath,
    getManagedWorktreeReadinessForSession: async (_sessionId, workingDir) => {
      try { return (await fs.stat(workingDir)).isDirectory() ? 'ready' : 'retry'; }
      catch { return 'retry'; }
    },
    findSimilarDirOnDisk: dir => findSimilarWorkingDirectory(dir).catch((error) => {
      if (isUnavailableFilesystemError(error)) throw error;
      return null;
    }),
    listActiveSessions: deps.listActiveSessions,
    emitWorkDirMissingError: (sessionId, workingDir, _source, reason, similarPath) => {
      deps.log.warn('send aborted: workdir missing', { sessionId, workingDir, reason, similarPath: similarPath ?? undefined });
    },
    workdirLog,
    log: deps.log,
  }));
  return {
    checkWorkDirExists,
    statDirectory: stat,
    // The send transaction's ports, as register.ts passes them.
    resolveRecoveredWorkingDir: (sessionId: string, dir: string) => recovery.resolve(sessionId, dir),
    isPersistedWorktreeFallback: (dir: string) => dialogueWorkspaceRoots().some(root =>
      path.dirname(path.resolve(dir)) === path.join(root, 'worktree-recovery')),
    peekWorkingDirectoryRecoveryNote: (sessionId: string, workingDir: string) => recovery.peek(sessionId, workingDir),
    consumeWorkingDirectoryRecoveryNote: (sessionId: string, note: string) => recovery.consume(sessionId, note),
    /** At a task's archive or delete (the runtime cleanup, as register.ts's workingDirectoryRecovery.discard). */
    discardWorkingDirectoryRecovery: (sessionId: string) => recovery.discard(sessionId),
  };
}
