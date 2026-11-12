/** Atomic, profile-local handoff of task closure to whichever process owns relay.
 * Reused inside replacement transactions so rollback also preserves sharing. */
export const CLOSE_SHARED_TASKS_FOR_SESSION_SQL = `
  INSERT INTO shared_task_events (shared_task_id, session_id, revision, kind, terminal, snapshot, recorded_at)
  SELECT DISTINCT shared_task_id, session_id, 0, 'local-close', 1, NULL, ?
  FROM shared_task_events WHERE session_id = ?
  ON CONFLICT (shared_task_id, kind, revision) DO NOTHING
`;

/** Prepare a reversible closure intent before the session status changes. */
export const PREPARE_SHARED_TASKS_FOR_SESSION_SQL = `
  INSERT INTO shared_task_events (shared_task_id, session_id, revision, kind, terminal, snapshot, recorded_at)
  SELECT DISTINCT shared_task_id, session_id, 0, 'local-close', 0, NULL, ?
  FROM shared_task_events AS source
  WHERE source.session_id = ?
    AND NOT EXISTS (
      SELECT 1 FROM shared_task_events AS existing
      WHERE existing.shared_task_id = source.shared_task_id
        AND existing.kind = 'local-close' AND existing.revision = 0
    )
  ON CONFLICT (shared_task_id, kind, revision) DO NOTHING
`;
