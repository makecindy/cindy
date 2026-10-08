import { parseSharedTaskSnapshot, type SharedTaskIdentity, type SharedTaskSnapshot } from '@cindy/device-link';
import type { DbClient } from './client/DbClient.js';
import { CLOSE_SHARED_TASKS_FOR_SESSION_SQL, PREPARE_SHARED_TASKS_FOR_SESSION_SQL } from './sharedTaskClosureSql.js';

let closureMarker = 0;

function nextClosureMarker(): number {
  // Keep markers distinct even when several terminal transitions happen in
  // the same millisecond. The marker only identifies rows from one prepare.
  const now = Date.now() * 1000;
  closureMarker = Math.max(closureMarker + 1, now);
  return closureMarker;
}

export interface PreparedSharedTaskClosure {
  sessionId: string;
  marker: number;
  rowIds: number[];
}

/** Persist the local-close fence before a session enters a terminal state. */
export async function prepareSharedTasksForSession(
  db: Pick<DbClient, 'exec' | 'query'>,
  sessionId: string,
): Promise<PreparedSharedTaskClosure> {
  const marker = nextClosureMarker();
  await db.exec(PREPARE_SHARED_TASKS_FOR_SESSION_SQL, [marker, sessionId]);
  const rows = await db.query<{ id: number }>(
    "SELECT id FROM shared_task_events WHERE session_id = ? AND kind = 'local-close' AND revision = 0 AND terminal = 0",
    [sessionId],
  );
  return { sessionId, marker, rowIds: rows.map((row) => row.id) };
}

/** Remove only a prepare whose terminal session write did not commit. */
export async function rollbackPreparedSharedTasks(
  db: Pick<DbClient, 'exec'>,
  prepared: PreparedSharedTaskClosure,
): Promise<void> {
  if (prepared.rowIds.length === 0) return;
  const placeholders = prepared.rowIds.map(() => '?').join(',');
  await db.exec(
    "DELETE FROM shared_task_events WHERE id IN (" + placeholders + ") AND session_id = ? AND kind = 'local-close' AND revision = 0 AND terminal = 0 AND recorded_at = ?",
    [...prepared.rowIds, prepared.sessionId, prepared.marker],
  );
}

/** Make a previously prepared closure durable after the terminal status commit. */
export async function finalizePreparedSharedTasks(
  db: Pick<DbClient, 'exec'>,
  prepared: PreparedSharedTaskClosure,
): Promise<void> {
  if (prepared.rowIds.length === 0) return;
  const placeholders = prepared.rowIds.map(() => '?').join(',');
  await db.exec(
    "UPDATE shared_task_events SET terminal = 1 WHERE id IN (" + placeholders + ") AND session_id = ? AND kind = 'local-close' AND revision = 0 AND terminal = 0",
    [...prepared.rowIds, prepared.sessionId],
  );
}

/** Does not require a live Host; the captured profile DB owns these closures. */
export async function closeSharedTasksInJournalForSession(db: Pick<DbClient, 'exec' | 'query'>, sessionId: string): Promise<string[]> {
  await db.exec(CLOSE_SHARED_TASKS_FOR_SESSION_SQL, [Date.now(), sessionId]);
  const rows = await db.query<{ shared_task_id: string }>(
    'SELECT DISTINCT shared_task_id FROM shared_task_events WHERE session_id = ? AND terminal = 1', [sessionId]);
  return rows.map((row) => row.shared_task_id);
}

export interface SharedTaskJournalEntry {
  sharedTaskId: string;
  sessionId: string;
  terminal: boolean;
  snapshot: SharedTaskSnapshot | null;
}

/** Bound to one profile's DbClient; never resolves a different account after an await. */
export function createSharedTaskJournal(db: Pick<DbClient, 'exec' | 'query'>, now: () => number = Date.now) {
  return {
    async recordAuthority(value: SharedTaskSnapshot): Promise<boolean> {
      const snapshot = parseSharedTaskSnapshot(value);
      // A single atomic statement records both the recovery snapshot and its
      // membership audit entry. A terminal record permanently fences late replies.
      const result = await db.exec(`
        INSERT INTO shared_task_events (shared_task_id, session_id, revision, kind, terminal, snapshot, recorded_at)
        SELECT ?, ?, ?, 'authority', ?, ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM shared_task_events
          WHERE shared_task_id = ? AND (terminal = 1 OR session_id <> ? OR revision >= ?)
        )
        ON CONFLICT (shared_task_id, kind, revision) DO NOTHING
      `, [snapshot.sharedTaskId, snapshot.sessionId, snapshot.revision, snapshot.status === 'closed' ? 1 : 0,
        JSON.stringify(snapshot), now(), snapshot.sharedTaskId, snapshot.sessionId, snapshot.revision]);
      return result.changes > 0;
    },
    async close(identity: SharedTaskIdentity): Promise<void> {
      // Revision zero is reserved for a local closure, not a server revision.
      // Never manufacture a higher authority revision from the local clock.
      const checked = parseSharedTaskSnapshot({ ...identity, revision: 1, status: 'closed', guests: [] });
      await db.exec(`
        INSERT INTO shared_task_events (shared_task_id, session_id, revision, kind, terminal, snapshot, recorded_at)
        SELECT ?, ?, 0, 'local-close', 1, NULL, ?
        WHERE NOT EXISTS (SELECT 1 FROM shared_task_events WHERE shared_task_id = ? AND session_id <> ?)
        ON CONFLICT (shared_task_id, kind, revision) DO NOTHING
      `, [checked.sharedTaskId, checked.sessionId, now(), checked.sharedTaskId, checked.sessionId]);
    },
    async latest(): Promise<SharedTaskJournalEntry[]> {
      const rows = await db.query<{ shared_task_id: string; session_id: string; terminal: number; snapshot: string | null }>(`
        SELECT shared_task_id, session_id, terminal, snapshot FROM shared_task_events
        WHERE id IN (SELECT MAX(id) FROM shared_task_events GROUP BY shared_task_id)
      `);
      return rows.map((row) => {
        const snapshot = row.snapshot === null ? null : parseSharedTaskSnapshot(JSON.parse(row.snapshot));
        if (snapshot && (snapshot.sharedTaskId !== row.shared_task_id || snapshot.sessionId !== row.session_id)) throw new Error('SharedTask journal scope mismatch');
        return { sharedTaskId: row.shared_task_id, sessionId: row.session_id, terminal: row.terminal === 1, snapshot };
      });
    },
  };
}

export type SharedTaskJournal = ReturnType<typeof createSharedTaskJournal>;
