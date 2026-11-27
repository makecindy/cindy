import { getDbClient } from './client/current.js';

/** Existence only: no message text, metadata or session identifiers leave the reader.
 * Scheduler-authored turns do not count as human conversation changes; manual replies
 * inside the same session do. Malformed or absent origin metadata remains a change.
 */
export async function hasConversationChanges(from: number, to: number): Promise<boolean> {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to)
    throw new Error('INVALID_RANGE');
  const hit = await getDbClient().queryOne<{ found: number }>(
    `
    SELECT 1 AS found FROM messages m JOIN sessions s ON s.id = m.session_id
    WHERE m.created_at >= ? AND m.created_at < ? AND m.rewind_at IS NULL
      AND s.status <> 'deleted' AND m.role IN ('user', 'assistant')
      AND COALESCE(json_extract(CASE WHEN json_valid(m.agent_meta) THEN m.agent_meta ELSE '{}' END, '$.origin.kind'), '') <> 'scheduler'
      AND (m.role = 'user' OR COALESCE((
        SELECT json_extract(CASE WHEN json_valid(u.agent_meta) THEN u.agent_meta ELSE '{}' END, '$.origin.kind')
        FROM messages u WHERE u.session_id = m.session_id AND u.role = 'user' AND u.rewind_at IS NULL
          AND (u.created_at < m.created_at OR (u.created_at = m.created_at AND u.rowid <= m.rowid))
        ORDER BY u.created_at DESC, u.rowid DESC LIMIT 1
      ), '') <> 'scheduler')
    LIMIT 1`,
    [from, to],
  );
  return Boolean(hit);
}
