import { groupUsageCostRows, messageUsageCostRows } from '@cindy/maker-shared/usage-cost-details';
import type { DbClient } from '../localDb/client/DbClient.js';

/** Read the existing message ledger; billing remains owned by its original writers. */
export async function readSessionCostDetails(db: DbClient, sessionId: string, clientId?: string) {
  const rows = await db.query<{ clientId: string; role: string; agentMeta: string | null }>(
    clientId ? `WITH target AS (
       SELECT m.created_at, m.rowid FROM messages m JOIN sessions s ON s.id = m.session_id
       WHERE m.session_id = ? AND m.client_id = ? AND m.rewind_at IS NULL
         AND m.role IN ('user', 'assistant')
         AND (s.cleared_at IS NULL OR m.created_at > s.cleared_at)
     ), boundary AS (
       SELECT m.created_at, m.rowid FROM messages m JOIN sessions s ON s.id = m.session_id
       CROSS JOIN target t
       WHERE m.session_id = ? AND m.rewind_at IS NULL AND m.role = 'user'
         AND (s.cleared_at IS NULL OR m.created_at > s.cleared_at)
         AND (m.created_at, m.rowid) <= (t.created_at, t.rowid)
         AND CASE WHEN json_valid(m.agent_meta) THEN json_extract(m.agent_meta, '$.autoResume') END IS NOT 1
       ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1
     )
     SELECT m.client_id AS clientId, m.role, m.agent_meta AS agentMeta
     FROM messages m JOIN sessions s ON s.id = m.session_id
     CROSS JOIN target t LEFT JOIN boundary b ON 1 = 1
     WHERE m.session_id = ? AND m.rewind_at IS NULL AND m.role IN ('user', 'assistant')
       AND (s.cleared_at IS NULL OR m.created_at > s.cleared_at)
       AND (m.created_at, m.rowid) <= (t.created_at, t.rowid)
       AND (m.created_at, m.rowid) >= (COALESCE(b.created_at, t.created_at), COALESCE(b.rowid, t.rowid))
     ORDER BY m.created_at, m.rowid` : `SELECT m.client_id AS clientId, m.role, m.agent_meta AS agentMeta
     FROM messages m JOIN sessions s ON s.id = m.session_id
     WHERE m.session_id = ? AND m.rewind_at IS NULL AND m.role IN ('user', 'assistant')
       AND (s.cleared_at IS NULL OR m.created_at > s.cleared_at)
     ORDER BY m.created_at, m.rowid`,
    clientId ? [sessionId, clientId, sessionId, sessionId] : [sessionId],
  );
  return groupUsageCostRows(rows.flatMap((row) => {
    let meta: Record<string, unknown> = {};
    try {
      const value = JSON.parse(row.agentMeta ?? '{}');
      if (value && typeof value === 'object' && !Array.isArray(value)) meta = value;
    } catch {
      /* old metadata */
    }
    return messageUsageCostRows(meta, row.role);
  }));
}
