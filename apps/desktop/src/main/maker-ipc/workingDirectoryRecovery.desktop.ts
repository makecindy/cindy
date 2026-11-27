import { isAppSessionBoundaryPending, ownerScopedUserDataPath } from '../appSessionState.js';
import { createLogger } from '../logger.js';
import { getUserDataDir } from '../userDataPath.js';
import {
  mkdirWorkingDirectory,
  realpathWorkingDirectory,
  statWorkingDirectory,
} from '../workdir-probe-host/index.js';
import {
  allocateDialogueRecoveryWorkspace,
  findDialogueRecoveryWorkspace,
  requiredDialogueRecoveryRoot,
} from './dialogueRecoveryWorkspace.js';
import {
  canRecreateOwnerWorkingDirectory,
  createWorkingDirectoryRecovery,
} from './workingDirectoryRecovery.js';

const workdirLog = createLogger('workdir-diagnostics');

/**
 * Process-wide Desktop working-directory recovery registry shared by interactive sends,
 * session bootstrap, and bound scheduled runs so an unrestored-worktree fallback stays
 * consistent across all entry points without creating circular imports with register.ts.
 */
export const workingDirectoryRecovery = createWorkingDirectoryRecovery(
  {
    stat: (dir) => statWorkingDirectory(dir),
    mkdir: (dir, opts, isCurrent) => mkdirWorkingDirectory(dir, opts, isCurrent),
    realpath: (dir) => realpathWorkingDirectory(dir),
    requiredRoot: (dir) => requiredDialogueRecoveryRoot(dir),
    findFallback: (sessionId, workingDir) => findDialogueRecoveryWorkspace(sessionId, workingDir),
    canRecreateDirectory: (dir) =>
      !isAppSessionBoundaryPending() &&
      canRecreateOwnerWorkingDirectory(getUserDataDir(), ownerScopedUserDataPath(), dir),
  },
  (sessionId, workingDir, mode) => allocateDialogueRecoveryWorkspace(sessionId, workingDir, mode),
  workdirLog,
);
