import { gitExec, GitExecError } from './gitExec';

import { createWorktreeContentSnapshots } from '@cindy/worktree-core/contentSnapshot';
const service = createWorktreeContentSnapshots({ gitExec, GitExecError });
export const {
  readWorktreeHeadRef,
  worktreeContentBaselineMatches,
  worktreeStagedContentMatches,
  worktreeContentMatches,
  presentFilesMatchSnapshotTree,
  checkoutMissingSnapshotFiles,
  releaseSnapshotRef,
  listSnapshotRefs,
  snapshotTreePaths,
  discardableWorktreePaths,
  captureWorktreeContent,
} = service;
export { WorktreeChangedDuringSnapshotError } from '@cindy/worktree-core/contentSnapshot';
