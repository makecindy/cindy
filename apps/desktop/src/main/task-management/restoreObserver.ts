import { and, eq, inArray } from 'drizzle-orm';
import { activeDataOwnerId } from '../ownerContext.js';
import { getCurrentDbClientSnapshot } from '../localDb/client/current.js';
import type { DbClient } from '../localDb/client/DbClient.js';
import { sessions } from '../localDb/schema.js';
import { taskManagementScope, taskManagementStore } from './store.js';

/**
 * The restore observer (localDb/sessionRestoreRetention.ts setSessionRestoreObserver): before an archived
 * task is made active, record when, so idle archiving keeps it for its retention days (eligibility.ts
 * 'restored'). Metadata is persisted before restoring, including manual/remote/Agent restores. The desktop's
 * task management (service.ts) and the Node Host (apps/host task-restore.ts) install this one function.
 */
export async function recordTaskArchiveRestores(
  ids: readonly string[],
  db: DbClient['drizzle'],
): Promise<void> {
  const scope = taskManagementScope();
  const current = getCurrentDbClientSnapshot();
  if (!current || current.client.drizzle !== db || current.userId !== activeDataOwnerId()) {
    throw new Error('TASK_ARCHIVE_SCOPE_CHANGED');
  }
  for (let offset = 0; offset < ids.length; offset += 128) {
    const rows = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        and(
          inArray(sessions.id, [...ids.slice(offset, offset + 128)]),
          eq(sessions.status, 'archived'),
        ),
      );
    if (scope !== taskManagementScope()) throw new Error('TASK_ARCHIVE_SCOPE_CHANGED');
    await taskManagementStore.restored(
      rows.map((row) => row.id),
      Date.now(),
    );
    if (scope !== taskManagementScope()) throw new Error('TASK_ARCHIVE_SCOPE_CHANGED');
  }
}
