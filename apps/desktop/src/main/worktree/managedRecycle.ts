import {
  captureWorktreeContent,
  worktreeContentBaselineMatches,
  worktreeContentMatches,
  worktreeStagedContentMatches,
  presentFilesMatchSnapshotTree,
  releaseSnapshotRef,
  snapshotTreePaths,
  discardableWorktreePaths,
} from './contentSnapshot';
import { gitExec } from './gitExec';
import { hasLiveSessionReference, loadLiveSessionPathKeys } from './liveSessionRefs';
import {
  newRecycleRecord,
  readRecycleRecord,
  writeRecycleRecord,
  worktreeGeneration,
} from './recycleJournal';
import { createRecoveryArchive, inventoryWorktree, verifyRecoveryArchive } from './recoveryArchive';
import { physicalWorktreeKey, withWorktreeResourceLock } from './resourceLock';

import { assertManagedResourcePath, assertWorktreeGitIdentity } from './resourceSafety';
import * as store from './worktreeStore';

import { withLegacyWorktreeRuntimeGuard } from './legacyRuntimeGuard';

import { createManagedWorktreeRecycle } from '@cindy/worktree-core/managedRecycle';
export type { ManagedRecycleOptions } from '@cindy/worktree-core/managedRecycle';
export const { checkpointWorktreeForReuse, requestWorktreeRecycle, recycleManagedWorktree } =
  createManagedWorktreeRecycle({
    captureWorktreeContent,
    worktreeContentBaselineMatches,
    worktreeContentMatches,
    worktreeStagedContentMatches,
    presentFilesMatchSnapshotTree,
    releaseSnapshotRef,
    snapshotTreePaths,
    discardableWorktreePaths,
    gitExec,
    hasLiveSessionReference,
    loadLiveSessionPathKeys,
    newRecycleRecord,
    readRecycleRecord,
    writeRecycleRecord,
    worktreeGeneration,
    createRecoveryArchive,
    inventoryWorktree,
    verifyRecoveryArchive,
    physicalWorktreeKey,
    withWorktreeResourceLock: (...args) => withWorktreeResourceLock(...args),
    assertManagedResourcePath,
    assertWorktreeGitIdentity,
    store,
    withLegacyWorktreeRuntimeGuard,
  });
