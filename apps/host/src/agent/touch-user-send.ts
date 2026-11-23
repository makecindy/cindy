import type { DbClient } from '../../../desktop/src/main/localDb/client/DbClient.ts';
import { touchUserSendRow } from '../../../desktop/src/main/localDb/sessionQueries.ts';
import { touchRecentWorkdir } from '../../../desktop/src/main/localDb/ipc/recentWorkdirsCore.ts';
import { recordRecentWorkdirForSend } from '../../../desktop/src/main/localDb/ipc/touchUserSendRecentWorkdir.ts';

/**
 * A user's send stamps the task (the desktop's touchUserSendInDb, localDb/ipc/sessions.ts): the row's send
 * and activity times in one guarded update, a `session_changed` with them while the owner holds, and the
 * desktop's own record of the project the send was made in (recordRecentWorkdirForSend), in the entry's
 * database, announced only while that owner still holds (the desktop's owner scope).
 */
export function createHostTouchUserSend<Owner extends { client: DbClient }>(deps: {
  getOwner(): Owner | null;
  publish(event: Record<string, unknown>): void;
  /** The recent projects push (session-move.ts createRecentWorkdirsChangedPush). */
  broadcastRecentWorkdirsChanged(path: string): void;
}) {
  return async (sessionId: string, atMs?: number) => {
    const owner = deps.getOwner();
    if (!owner) throw new Error('DbClient not ready');
    const ts = typeof atMs === 'number' && Number.isFinite(atMs) && atMs > 0 ? Math.floor(atMs) : Date.now();
    const updated = await touchUserSendRow(owner.client.drizzle, sessionId, ts);
    // As touchUserSendInDb: an older or repeated stamp changes nothing and announces nothing.
    if (updated.length === 0) return;
    const [row] = updated;
    if (deps.getOwner() === owner) deps.publish({ type: 'session_changed', sessionId,
      patch: { userSendAt: new Date(row.userSendAt!).toISOString(),
        lastActivityAt: new Date(row.lastActivityAt!).toISOString(), updatedAt: new Date(row.updatedAt).toISOString() } });
    await recordRecentWorkdirForSend({
      updated, ts, dbClient: owner.client, ownerScope: owner, touchRecentWorkdir,
      broadcastRecentWorkdirsChanged: (path, scope) => {
        if (deps.getOwner() === scope) deps.broadcastRecentWorkdirsChanged(path);
      },
    });
  };
}
