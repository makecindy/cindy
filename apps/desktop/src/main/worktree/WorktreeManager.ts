import {
  blocksManagedWorktreeBranchNamespace,
  generateUniqueName,
  avoidCollision,
  getBranchName,
  getManagedWorktreeNameFromBranch,
  getManagedWorktreeReservedName,
  isManagedWorktreeBranchForName,
  validateWorktreeName,
} from './nameGenerator';

import { readAttachedWorktreeBranch } from './attachedBranch';

import { createCwdProbeScheduler } from './cwdProbeScheduler';
import * as names from './nameGenerator';
import { createWorktreeManager } from '@cindy/worktree-core/manager';
import { createWorktreeSessionTransferReader } from '@cindy/app-runtime/worktreeSessionTransfer';

import { classifyError } from './errorClassifier';

import {
  gitExec,
  GitExecError,
  globalSafeDirectoryLockPath,
  safeDirectorySpellings,
} from './gitExec';

import { gitPathOutput } from './gitPathOutput';

import { withCrossProcessLock } from '../device-link/crossProcessLock';

import { applyWorktreeIncludeFile, listChangedWorktreeIncludeFiles } from './includePatternsEngine';

import { hasKeepSentinel, isManagedWorktreePath } from './safety';

import { isWorktreeDirty, listNonReproducibleIgnoredFiles } from './dirty';

import { hasLiveSessionReference, loadLiveSessionPathKeys } from './liveSessionRefs';

import { withWorktreeRestoreMutation } from './restoreLock';

import { recycleManagedWorktree } from './managedRecycle';

import { physicalWorktreeKey, withWorktreeResourceLock } from './resourceLock';

import {
  acquireWorktreeRuntimeLease,
  recordWorktreeRuntimeLeaseChild,
  reclaimOrphanedWorktreeRuntimeLeases,
  releaseWorktreeRuntimeLease,
} from './runtimeLeases';

import * as store from './worktreeStore';

import {
  assertPrecreatedSessionNotCancelled,
  sealPrecreatedSessionCancellation,
  withPrecreatedSessionOperationLock,
} from './precreatedCancellation';

import { createLogger } from '../logger';

import { realpathWorkingDirectory } from '../workdir-probe-host/index';

import { getDbClient } from '../localDb/client/current';

import {
  getManagedWorktreeBasePath,
  MANAGED_WORKTREE_DIR_NAME,
} from '../../shared/managedWorktreePaths';
const manager = createWorktreeManager({
  ...names,
  blocksManagedWorktreeBranchNamespace,
  generateUniqueName,
  avoidCollision,
  getBranchName,
  getManagedWorktreeNameFromBranch,
  getManagedWorktreeReservedName,
  isManagedWorktreeBranchForName,
  validateWorktreeName,
  readAttachedWorktreeBranch,
  createCwdProbeScheduler,
  classifyError,
  gitExec,
  GitExecError,
  globalSafeDirectoryLockPath,
  safeDirectorySpellings,
  gitPathOutput,
  withCrossProcessLock,
  applyWorktreeIncludeFile,
  listChangedWorktreeIncludeFiles,
  hasKeepSentinel,
  isManagedWorktreePath,
  isWorktreeDirty,
  listNonReproducibleIgnoredFiles,
  hasLiveSessionReference,
  loadLiveSessionPathKeys,
  withWorktreeRestoreMutation,
  recycleManagedWorktree,
  physicalWorktreeKey,
  withWorktreeResourceLock,
  acquireWorktreeRuntimeLease,
  recordWorktreeRuntimeLeaseChild: (lease, pid) => recordWorktreeRuntimeLeaseChild(lease, pid),
  reclaimOrphanedWorktreeRuntimeLeases,
  releaseWorktreeRuntimeLease,
  assertPrecreatedSessionNotCancelled,
  sealPrecreatedSessionCancellation,
  withPrecreatedSessionOperationLock,
  realpathWorkingDirectory,
  getManagedWorktreeBasePath,
  MANAGED_WORKTREE_DIR_NAME,
  store,
  log: createLogger('WorktreeManager'),
  readLocalWorktreeReferences: async () => getDbClient().readLocalWorktreeReferences?.() ?? null,
  readSessionTransfer: createWorktreeSessionTransferReader(getDbClient),
});
export const {
  reconcilePendingSafeDirectoryCleanups,
  detectCwd,
  listBranches,
  revParseCommit,
  suggestName,
  resolveAvailableWorktreeName,
  getForSession,
  reconcileSessionTransfer,
  withTransferredSession,
  listAll,
  copyDirIfExists,
  buildWorktreeAddArgs,
  copyClaudeSiviDirs,
  awaitBackgroundCheckout,
  createWorktree,
  getRemovalPreview,
  removeWorktreeForSession,
  cancelPrecreatedWorktree,
  discardPrecreatedWorktreeByRecoveryKey,
  discardPrecreatedWorktree,
} = manager;
export { assertPrecreatedSessionNotCancelled };
export type {
  CopyClaudeSiviDirsOptions,
  RemoveWorktreeOptions,
  DiscardPrecreatedWorktreeResult,
} from '@cindy/worktree-core/manager';
