import type Database from 'better-sqlite3';
import type {
  SessionArchiveReceipt,
  SessionsSetRemoteArchiveArgs,
  SessionsSetRemoteArchiveResult,
} from '../../client/tx/types.js';

/** Used by both DB transports. External dependencies must be passed explicitly. */
export function setRemoteSessionArchive(
  db: Database.Database,
  args: SessionsSetRemoteArchiveArgs,
  idleGuard: string,
): SessionsSetRemoteArchiveResult {
  const { controllerId, operationId, sessionId, archived, expected, workingDir } = args;
  const fail = (message: string): never => {
    throw Object.assign(new Error(message), { code: 'PRECONDITION_FAILED' });
  };
  return db.transaction(() => {
    const previous = db.prepare(`
      SELECT session_id AS sessionId, session_instance AS instance, expected_revision AS expectedRevision,
        revision, archived, operation_id AS operationId
      FROM session_archive_receipts WHERE controller_id = ? AND operation_id = ?
    `).get(controllerId, operationId) as (Omit<SessionArchiveReceipt, 'archived'> & {
      archived: number;
      expectedRevision: number;
    }) | undefined;
    if (previous) {
      if (previous.sessionId !== sessionId || previous.instance !== expected.instance ||
          previous.expectedRevision !== expected.revision || Boolean(previous.archived) !== archived) {
        return fail('Archive operation ID was previously used with different parameters');
      }
      const { expectedRevision: _expected, ...receipt } = previous;
      return { receipt: { ...receipt, archived }, applied: false };
    }
    const expectedStatus = archived ? 'active' : 'archived';
    if (!db.prepare(idleGuard).get(sessionId, expectedStatus, expected.instance, expected.revision, workingDir)) {
      return fail('Task status or archive eligibility changed');
    }
    // Keep receipts for the life of the task and reject new writes at the limit.
    // Evicting an operation here would make a late duplicate indistinguishable.
    const limitReached = db.prepare(`
      SELECT 1 FROM session_archive_receipts WHERE session_id = ? AND session_instance = ? LIMIT 1 OFFSET 255
    `).get(sessionId, expected.instance);
    if (limitReached) return fail('Task archive operation limit reached');

    const now = Date.now();
    db.prepare(`
      UPDATE sessions SET status = ?, updated_at = ?,
        remote_restored_at = CASE WHEN ? THEN remote_restored_at ELSE ? END
      WHERE id = ?
    `).run(archived ? 'archived' : 'active', now, Number(archived), now, sessionId);
    // UPDATE RETURNING does not include values written by an AFTER trigger.
    const { archive_revision: revision } = db.prepare('SELECT archive_revision FROM sessions WHERE id = ?')
      .get(sessionId) as { archive_revision: number };
    if (revision !== expected.revision + 1) return fail('Task archive revision did not advance');
    db.prepare(`
      INSERT INTO session_archive_receipts
        (controller_id, operation_id, session_id, session_instance, expected_revision, revision, archived)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(controllerId, operationId, sessionId, expected.instance, expected.revision, revision, Number(archived));
    return { receipt: { sessionId, instance: expected.instance, operationId, revision, archived }, applied: true };
  }).immediate();
}
