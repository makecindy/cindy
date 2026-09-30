import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { IOSSimulatorInstanceError } from '@cindy/ios-simulator-runtime';

import { createLogger } from '../logger';
import { subscribeWorktreeRecycleEvents } from '../worktree/recycleEvents';
import { readRecycleRecordsAcrossProfiles } from '../worktree/recycleJournal';
import { withWorktreeResourceLock, worktreeResourceId } from '../worktree/resourceLock';
import {
  acquireWorktreeRuntimeLease,
  managedWorktreeRoot,
  releaseWorktreeRuntimeLease,
} from '../worktree/runtimeLeases';

const log = createLogger('ios-simulator-project-source');

/** Project selection changes the build source, never the task or device owner. */
export async function resolveIOSSimulatorProjectDir(taskRoot: string, projectDir?: string): Promise<string> {
  if (projectDir === undefined) return taskRoot;
  try {
    const resolved = await realpath(path.resolve(taskRoot, projectDir));
    if ((await stat(resolved)).isDirectory()) return resolved;
  } catch { /* Return a stable tool error rather than a raw filesystem path. */ }
  throw new IOSSimulatorInstanceError('INVALID_ARGUMENT', 'projectDir must resolve to an existing local directory.');
}

/** Reuse the worktree recycler's cross-process lease; release only after source I/O has drained. */
export async function acquireIOSSimulatorProjectUse(
  sessionId: string,
  projectRoot: string,
  controller: AbortController,
  signal: AbortSignal = controller.signal,
): Promise<(() => Promise<void>) | null> {
  const managedRoot = managedWorktreeRoot(projectRoot);
  if (!managedRoot) return null;
  return withWorktreeResourceLock(managedRoot, async () => {
    // Recheck after taking the deletion lock: selection may have raced reclamation.
    const available = await stat(projectRoot).then((value) => value.isDirectory(), () => false);
    signal.throwIfAborted();
    if (!available) {
      throw new IOSSimulatorInstanceError('INVALID_ARGUMENT', 'The selected project directory is unavailable.');
    }
    // Check the owner's authoritative intent before publishing a lease that could
    // otherwise obstruct recovery of a partially removed directory.
    const records = await readRecycleRecordsAcrossProfiles(managedRoot);
    const identity = await stat(managedRoot);
    if (records.some((record) => !['removed', 'restored'].includes(record.phase)
      && (record.directoryIdentity === `${identity.dev}:${identity.ino}:${identity.birthtimeMs}`
        || (record.phase === 'restoring' && record.directoryIdentity == null)))) {
      controller.abort();
      throw new IOSSimulatorInstanceError('MUTATION_CANCELLED', 'The selected project worktree is being recycled or restored.', true);
    }
    signal.throwIfAborted();
    const lease = await acquireWorktreeRuntimeLease(`ios-simulator:${sessionId}`, projectRoot, { crossProfile: true });
    if (!lease) return null;
    const resourceId = worktreeResourceId(lease.physicalPath);
    const unsubscribe = subscribeWorktreeRecycleEvents((event) => {
      if (!event.opportunity && event.resourceId === resourceId) controller.abort();
    });
    const release = async (): Promise<void> => {
      unsubscribe();
      try {
        await releaseWorktreeRuntimeLease(lease);
      } catch {
        // The durable release request is retried by worktree maintenance. Keeping
        // the lease protects the directory until that retry succeeds.
        log.warn('project worktree lease release deferred');
      }
    };
    return release;
  }, signal).catch((error) => {
    if (signal.aborted) {
      throw new IOSSimulatorInstanceError('MUTATION_CANCELLED', 'The app operation was cancelled while acquiring its project worktree.', true);
    }
    throw error;
  });
}
