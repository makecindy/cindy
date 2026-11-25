import type { DbClient } from '../localDb/client/DbClient.js';
import { DAG_TIP_REJECTED, type ExpectedDagTip } from '../../shared/dagTip.js';
import { throwIpcError } from '../utils/ipcValidate.js';

export function rejectDagTip(): never {
  return throwIpcError('PRECONDITION_FAILED', `${DAG_TIP_REJECTED}: 分支末端或运行状态已变化，问题未发送。`);
}

export function readExpectedDagTip(value: unknown): ExpectedDagTip {
  if (!value || typeof value !== 'object') return rejectDagTip();
  const { answerId, userMessageId } = value as Partial<ExpectedDagTip>;
  for (const id of [answerId, userMessageId]) {
    if (typeof id !== 'string' || !id.trim() || id.length > 512) return rejectDagTip();
  }
  if (answerId === userMessageId) return rejectDagTip();
  return { answerId: answerId!, userMessageId: userMessageId! };
}

// One SQLite snapshot. Trailing tool rows don't create a turn. A hidden recovery
// input is part of this turn only when the host recorded its source question.
// No text or tool payloads leave the DB worker and identities never cross sessions.
const stillAtTip = `SELECT 1 AS ok FROM sessions s
 JOIN messages q ON q.session_id=s.id AND q.client_id=? AND q.role='user' AND q.rewind_at IS NULL
 JOIN messages a ON a.session_id=s.id AND a.client_id=? AND a.role='assistant' AND a.rewind_at IS NULL
 WHERE s.id=? AND s.status='active' AND s.hidden_at IS NULL AND s.remote_host_id IS NULL
 AND s.source IN ('desktop','side-chat') AND (s.cleared_at IS NULL OR q.created_at>s.cleared_at)
 AND (a.created_at,a.rowid)>(q.created_at,q.rowid)
 AND NOT EXISTS (SELECT 1 FROM messages later WHERE later.session_id=s.id
   AND (later.created_at,later.rowid)>(q.created_at,q.rowid)
   AND ((later.rewind_at IS NULL AND later.role IN ('agent_switch','user')
     AND (later.role!='user' OR COALESCE(json_extract(later.agent_meta,'$.recoveryCheckpoint.failedUserClientId'),'')!=q.client_id))
     OR later.role='context_rebuild'))
 AND (json_extract(a.agent_meta,'$.replyToClientId') IS NULL OR json_extract(a.agent_meta,'$.replyToClientId')=q.client_id
   OR EXISTS (SELECT 1 FROM messages resume WHERE resume.session_id=s.id AND resume.role='user' AND resume.rewind_at IS NULL
     AND resume.client_id=json_extract(a.agent_meta,'$.replyToClientId') AND json_extract(resume.agent_meta,'$.recoveryCheckpoint.failedUserClientId')=q.client_id))
 LIMIT 1`;

/** Call under the target session send lock. Recheck runtime immediately before
 * synchronous enqueue: a normal composer can enqueue even while the SQL read awaits. */
export async function admitAtDagTip<T>(
  db: Pick<DbClient, 'queryOne'>, sid: string, tip: ExpectedDagTip, idle: () => boolean, admit: () => T,
): Promise<T> {
  if (!idle()) return rejectDagTip();
  const row = await db.queryOne<{ok: number}>(stillAtTip, [tip.userMessageId, tip.answerId, sid]);
  if (row?.ok !== 1 || !idle()) return rejectDagTip();
  return admit();
}
