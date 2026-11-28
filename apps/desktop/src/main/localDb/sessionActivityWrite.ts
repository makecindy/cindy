/**
 * The task list's activity write, shared by the desktop (localDb/ipc/sessions.ts touchSessionActivityInDb)
 * and the Node Host. Moved verbatim from touchSessionActivityInDb: it only ever moves the task's
 * last_activity_at and updated_at forward to `atMs`, and with `skipActiveGoal` leaves a task with an active
 * goal alone. The caller keeps the ended-write suppression, the owner scope, the broadcast and the error log.
 */
import { and, eq, sql } from 'drizzle-orm';

import type { DbClient } from './client/DbClient';
import { sessions } from './schema';

export async function writeSessionListActivity(
  dbClient: DbClient,
  id: string,
  atMs: number,
  skipActiveGoal: boolean,
) {
  const db = dbClient.drizzle;
  return db.update(sessions)
    .set({
      lastActivityAt: sql`MAX(COALESCE(${sessions.lastActivityAt}, 0), ${atMs})`,
      updatedAt: sql`MAX(COALESCE(${sessions.updatedAt}, 0), ${atMs})`,
    })
    .where(and(
      eq(sessions.id, id),
      sql`COALESCE(${sessions.lastActivityAt}, 0) < ${atMs}`,
      skipActiveGoal
        ? sql`NOT EXISTS (SELECT 1 FROM session_goals WHERE session_id = ${id} AND status = 'active')`
        : undefined,
    ))
    .returning({ lastActivityAt: sessions.lastActivityAt, updatedAt: sessions.updatedAt });
}
