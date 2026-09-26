import path from 'node:path';

import { withWorktreeResourceLocks } from '../worktree/resourceLock';
import { assertTaskMigrationWritable, migrationScope } from './journal';

/** Reuse the physical-resource mutex for admission across Desktop processes.
 * These are resource identities, not files to create in a user's project.
 * Batch acquisition also fences every member of an Orca migration.
 */
export function withTaskMigrationBoundary<T>(
  ids: readonly string[],
  task: () => Promise<T>,
): Promise<T> {
  const scope = migrationScope();
  const resources = ids.map((id) => {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error('MIGRATION_INVALID_ID');
    return path.join(scope.root, 'admission', id);
  });
  return withWorktreeResourceLocks(resources, async () => {
    scope.assertCurrent();
    return task();
  });
}

/** Check under the same mutex that publishes preparing, never before an await. */
export function withTaskMigrationWrite<T>(id: string, task: () => Promise<T>): Promise<T> {
  return withTaskMigrationBoundary([id], async () => {
    assertTaskMigrationWritable(id);
    return task();
  });
}
