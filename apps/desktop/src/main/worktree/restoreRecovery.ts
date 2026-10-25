import { GitExecError, gitExec } from './gitExec';
import { readRecycleRecord, writeRecycleRecord, worktreeGeneration } from './recycleJournal';
import {
  extractRecoveryArchive,
  inventoryWorktree,
  verifyRecoveryArchive,
} from './recoveryArchive';
import { physicalWorktreeKey, withWorktreeResourceLock } from './resourceLock';
import { hasLiveSessionReference, loadLiveSessionPathKeys } from './liveSessionRefs';
import {
  assertManagedResourceLocation,
  assertManagedResourcePath,
  assertWorktreeGitIdentity,
} from './resourceSafety';
import * as store from './worktreeStore';
import { withLegacyWorktreeRuntimeGuard } from './legacyRuntimeGuard';
import {
  readWorktreeHeadRef,
  presentFilesMatchSnapshotTree,
  checkoutMissingSnapshotFiles,
  releaseSnapshotRef,
} from './contentSnapshot';

import { createRecordedWorktreeRecovery } from '@cindy/worktree-core/restoreRecovery';
export const { restoreRecordedWorktree } = createRecordedWorktreeRecovery({
  GitExecError,
  gitExec,
  readRecycleRecord,
  writeRecycleRecord,
  worktreeGeneration,
  extractRecoveryArchive,
  inventoryWorktree,
  verifyRecoveryArchive,
  physicalWorktreeKey,
  withWorktreeResourceLock,
  hasLiveSessionReference,
  loadLiveSessionPathKeys,
  assertManagedResourceLocation,
  assertManagedResourcePath,
  assertWorktreeGitIdentity,
  store,
  withLegacyWorktreeRuntimeGuard,
  readWorktreeHeadRef,
  presentFilesMatchSnapshotTree,
  checkoutMissingSnapshotFiles,
  releaseSnapshotRef,
});
