import { getDbClient } from '../localDb/client/current';
import { patchSessionMetaInDb } from '../localDb/ipc/sessions';
import { withSessionRouteLock } from '../localDb/sessionRouteLock';
import {
  getSessionLastUserActionAt,
  hasPendingSchedulerTargetInput,
  isSchedulerTargetSessionBusy,
} from '../maker-ipc/register.js';
import { ARCHIVE_CANDIDATE_SELECT, type ArchiveCandidateRow } from '../task-management/eligibility.js';

export async function readScheduledTargetStatus(sessionId: string): Promise<string | null> {
  const row = await getDbClient().queryOne<{ status: string }>(
    'SELECT status FROM sessions WHERE id = ?',
    [sessionId],
  );
  return row?.status ?? null;
}

/**
 * Owner input or a question for the owner since the round started; scheduled and delegated
 * executions do not count. CASE guards json_extract on malformed rows (same as agentHandoffHistory).
 */
const OWNER_MESSAGE_SINCE_SQL = `SELECT 1 AS hit FROM messages
  WHERE session_id = ? AND role IN ('user', 'ask_user', 'plan_review') AND created_at >= ? AND rewind_at IS NULL
    AND CASE WHEN role = 'user' AND json_valid(agent_meta)
      THEN COALESCE(json_extract(agent_meta, '$.autoReviewUserText.kind'), '')
        NOT IN ('scheduled-continuation', 'delegated-continuation')
      ELSE 1 END
  LIMIT 1`;

/** Uses the ordinary archive write; any sign of the user in the task keeps it restored. */
export async function archiveQuietScheduledTarget(sessionId: string, sinceMs: number): Promise<void> {
  if ((getSessionLastUserActionAt(sessionId) ?? 0) >= sinceMs) return;
  if (isSchedulerTargetSessionBusy(sessionId) || hasPendingSchedulerTargetInput(sessionId)) return;
  await withSessionRouteLock(sessionId, async () => {
    const db = getDbClient();
    const row = await db.queryOne<ArchiveCandidateRow & { snoozedAt: number | null }>(
      `${ARCHIVE_CANDIDATE_SELECT.replace('SELECT s.id,', 'SELECT s.snoozed_at AS snoozedAt, s.id,')} WHERE s.id = ?`,
      [sessionId],
    );
    // Running is judged from the live runtime above: right after a round the persisted
    // turn-end time may still be landing, so the stored turn columns would read as running.
    if (!row || row.status !== 'active' || row.pinnedAt != null || row.queued
      || (row.snoozedAt ?? 0) >= sinceMs) return;
    if (await db.queryOne(OWNER_MESSAGE_SINCE_SQL, [sessionId, sinceMs])) return;
    const superseded = new Error('Quiet round no longer owns the idle task');
    const beforeWrite = () => {
      if ((getSessionLastUserActionAt(sessionId) ?? 0) >= sinceMs
        || isSchedulerTargetSessionBusy(sessionId) || hasPendingSchedulerTargetInput(sessionId)) throw superseded;
    };
    try {
      await patchSessionMetaInDb(sessionId, { status: 'archived' }, { routeLockHeld: true, beforeWrite });
    } catch (error) {
      if (error !== superseded) throw error;
    }
  });
}
