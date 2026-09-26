import path from 'node:path';
import { physicalWorktreeKey } from '../worktree/resourceLock';
import { getDbClient } from '../localDb/client/current';
import { withSessionRouteLock } from '../localDb/sessionRouteLock';
import { assertTaskMigrationWritable, migrationScope } from './journal';

/** Share migration start's lock through acceptance and durable queue persistence. */
export function withTaskMigrationInputAcceptance<T>(sessionId: string, accept: () => Promise<T>): Promise<T> {
  return withSessionRouteLock(sessionId, async () => {
    await assertTaskMigrationInputAllowed(sessionId);
    assertTaskMigrationWritable(sessionId);
    return accept();
  });
}

/** Freeze new writers sharing the snapshot directory only while it is being prepared. */
export async function assertTaskMigrationInputAllowed(
  sessionId?: string,
  workingDir?: string | null,
): Promise<void> {
  const scope = migrationScope();
  if (sessionId) {
    assertTaskMigrationWritable(sessionId);
    if (!workingDir) {
      const row = await getDbClient().queryOne<{
        workingDir: string | null;
        remoteHostId: string | null;
      }>(
        'SELECT working_dir AS workingDir, remote_host_id AS remoteHostId FROM sessions WHERE id = ?',
        [sessionId],
      );
      scope.assertCurrent();
      assertTaskMigrationWritable(sessionId);
      if (!row?.remoteHostId) workingDir = row?.workingDir;
    }
  }
  if (!workingDir) return;
  const preparing = scope
    .list()
    .filter((record) => record.kind === 'outgoing' && record.stage === 'preparing');
  if (!preparing.length) return;
  const key = await physicalWorktreeKey(workingDir);
  scope.assertCurrent();
  for (const record of preparing) {
    for (const dir of [
      record.workingDir,
      ...(record.workers ?? []).map((worker) => worker.workingDir),
    ]) {
      const source = await physicalWorktreeKey(dir);
      scope.assertCurrent();
      if (key === source || key.startsWith(source + path.sep) || source.startsWith(key + path.sep))
        throw new Error('[PRECONDITION_FAILED] MIGRATION_SHARED_DIRECTORY_BUSY');
    }
  }
}
