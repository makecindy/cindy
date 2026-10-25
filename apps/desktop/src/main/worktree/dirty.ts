import { gitExec } from './gitExec';

import { createLogger } from '../logger';
import { createWorktreeDirtyChecks } from '@cindy/worktree-core/dirty';
const service = createWorktreeDirtyChecks({ gitExec, log: createLogger('worktree:dirty') });
export const {
  isWorktreeDirty,
  listNonReproducibleIgnoredFiles,
  snapshotRefForSession,
  getSnapshotSha,
  getRestorableSnapshotSha,
  clearSnapshotRef,
  getAutoStashSha,
  getRestorableAutoStashSha,
  markSnapshotConsumed,
  autoStashDirtyWorktree,
  restoreAutoStashToPreservedWorktree,
} = service;
