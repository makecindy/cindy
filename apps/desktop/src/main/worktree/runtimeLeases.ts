// The leases themselves live in runtimeLeasesCore.ts (shared with the Node Host). This module
// builds the single Desktop instance; its port resolves Electron when called, never when this
// module loads.
import { createWorktreeRuntimeLeases } from './runtimeLeasesCore.js';
import { app } from 'electron';
export { managedWorktreeRoot } from './managedResourcePath.js';
export type { WorktreeRuntimeLease } from './runtimeLeasesCore.js';

const desktopLeases = createWorktreeRuntimeLeases({
  app: { getPath: (name) => app.getPath(name) },
});
type Instance = typeof desktopLeases;

export function acquireWorktreeRuntimeLease(...args: Parameters<Instance['acquireWorktreeRuntimeLease']>): ReturnType<Instance['acquireWorktreeRuntimeLease']> {
  return desktopLeases.acquireWorktreeRuntimeLease(...args);
}

export function releaseWorktreeRuntimeLease(...args: Parameters<Instance['releaseWorktreeRuntimeLease']>): ReturnType<Instance['releaseWorktreeRuntimeLease']> {
  return desktopLeases.releaseWorktreeRuntimeLease(...args);
}

export function recordWorktreeRuntimeLeaseChild(...args: Parameters<Instance['recordWorktreeRuntimeLeaseChild']>): ReturnType<Instance['recordWorktreeRuntimeLeaseChild']> {
  return desktopLeases.recordWorktreeRuntimeLeaseChild(...args);
}

export function retryPendingWorktreeRuntimeLeaseReleases(...args: Parameters<Instance['retryPendingWorktreeRuntimeLeaseReleases']>): ReturnType<Instance['retryPendingWorktreeRuntimeLeaseReleases']> {
  return desktopLeases.retryPendingWorktreeRuntimeLeaseReleases(...args);
}

export function readWorktreeRuntimePaths(...args: Parameters<Instance['readWorktreeRuntimePaths']>): ReturnType<Instance['readWorktreeRuntimePaths']> {
  return desktopLeases.readWorktreeRuntimePaths(...args);
}

export function reclaimOrphanedWorktreeRuntimeLeases(...args: Parameters<Instance['reclaimOrphanedWorktreeRuntimeLeases']>): ReturnType<Instance['reclaimOrphanedWorktreeRuntimeLeases']> {
  return desktopLeases.reclaimOrphanedWorktreeRuntimeLeases(...args);
}
