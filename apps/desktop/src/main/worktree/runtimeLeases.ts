import { app } from 'electron';

import { physicalWorktreeKey, withWorktreeResourceLock } from './resourceLock';

import { notifyWorktreeRecycleOpportunity } from './recycleEvents';

import { isReusedDesktopInstancePid, readDesktopProcessIdentity } from '../desktopProcessIdentity';

import { isGitProcessTreeAlive } from './gitExec';
import { createWorktreeRuntimeLeases } from '@cindy/worktree-core/runtimeLeases';
const service = createWorktreeRuntimeLeases({
  physicalWorktreeKey: (...args) => physicalWorktreeKey(...args),
  withWorktreeResourceLock: (...args) => withWorktreeResourceLock(...args),
  notifyWorktreeRecycleOpportunity: (...args) => notifyWorktreeRecycleOpportunity(...args),
  readDesktopProcessIdentity: (...args) => readDesktopProcessIdentity(...args),
  isReusedDesktopInstancePid: (...args) => isReusedDesktopInstancePid(...args),
  isGitProcessTreeAlive: (pid) => isGitProcessTreeAlive(pid),
  userDataRoot: () => app.getPath('userData'),
  appDataRoot: () => app.getPath('appData'),
});
export const {
  managedWorktreeRoot,
  acquireWorktreeRuntimeLease,
  releaseWorktreeRuntimeLease,
  recordWorktreeRuntimeLeaseChild,
  retryPendingWorktreeRuntimeLeaseReleases,
  readWorktreeRuntimePaths,
  reclaimOrphanedWorktreeRuntimeLeases,
} = service;
export type { WorktreeRuntimeLease } from '@cindy/worktree-core/runtimeLeases';
