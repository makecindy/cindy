import { GitExecError, type GitExecResult, type GitExecOpts } from '@cindy/worktree-core/gitTypes';

import { killProcessTree } from '../scheduler-host/proc-util';

import { withCrossProcessLock } from '../device-link/crossProcessLock';

import { createLogger } from '../logger';

import { beginExecFileDiagnostic, execFileWithDiagnostics } from '../utils/execFileDiagnostics';

export { GitExecError };

export type { GitExecResult, GitExecOpts };
import { createGitExecutor } from '@cindy/worktree-core/gitExec';
const service = createGitExecutor({
  log: createLogger('gitExec'),
  withCrossProcessLock,
  killProcessTree,
  beginExecFileDiagnostic,
  execFileWithDiagnostics,
});
export const {
  KILL_CLEANUP_BUDGET_MS,
  isGitProcessTreeAlive,
  globalSafeDirectoryLockPath,
  normalizeSafeDirectorySpelling,
  safeDirectorySpellings,
  gitExec,
} = service;
