import { sql, type SQL } from 'drizzle-orm';
import { getDbClient } from './client/current.js';
import { buildHandoffText, type HandoffSourceMessage } from '../maker-ipc/agentHandoff.js';

/** Same membership predicate for browsing, search, learning and working context. */
export function botOriginMessageFilter(messageId: SQL, botId: string): SQL {
  return sql`EXISTS (SELECT 1 FROM bot_task_origin_messages om
    WHERE om.bot_id = ${botId} AND om.message_id = ${messageId})`;
}

export async function readBotTaskOrigin(botId: string) {
  return getDbClient().queryOne<{ sourceSessionId: string; title: string; createdAt: number; workingDir: string | null }>(
    `SELECT o.source_session_id AS sourceSessionId, s.title, s.working_dir AS workingDir, o.created_at AS createdAt
     FROM bot_task_origins o JOIN sessions s ON s.id=o.source_session_id
     WHERE o.bot_id=? AND s.status != 'deleted'`, [botId]);
}

/** Read current visible bytes, never a stale summary resurrecting withdrawn messages. */
export async function pendingBotTaskOriginHandoff(sessionId: string): Promise<string | null> {
  const db = getDbClient();
  const origin = await db.queryOne<{ botId: string; sourceSessionId: string }>(
    `SELECT o.bot_id AS botId, o.source_session_id AS sourceSessionId FROM bot_task_origins o
     JOIN bot_session_links b ON b.bot_id=o.bot_id AND b.role='canonical'
     JOIN sessions target ON target.id=b.session_id
     JOIN sessions s ON s.id=o.source_session_id
     WHERE b.session_id=? AND o.handoff_consumed_at IS NULL AND s.status != 'deleted'
       AND COALESCE(target.cleared_at,0) < o.created_at`, [sessionId]);
  if (!origin) return null;
  const rows = await db.query<{ role: string; content: string; agentMeta: string | null; createdAt: number; toolUseId: string | null }>(
    `SELECT m.role, m.content, m.agent_meta AS agentMeta, m.created_at AS createdAt, m.tool_use_id AS toolUseId
     FROM bot_task_origin_messages o JOIN messages m ON m.id=o.message_id
     JOIN sessions s ON s.id=m.session_id
     WHERE o.bot_id=? AND m.rewind_at IS NULL AND m.created_at > COALESCE(s.cleared_at,0)
     ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1000`, [origin.botId]);
  const parsed: HandoffSourceMessage[] = rows.reverse().map(row => {
    let content: unknown = row.content;
    try { content = JSON.parse(row.content); } catch { /* Legacy plain text. */ }
    return { ...row, content };
  });
  const lookup = JSON.stringify({ session_ids: [origin.sourceSessionId], teammate_id: origin.botId });
  return `Source history lookup: get_chat_history(${lookup}).\n` +
    buildHandoffText(parsed, { fromLabel: 'Source task', toLabel: 'Companion', sessionId: origin.sourceSessionId });
}

export async function consumeBotTaskOriginHandoff(sessionId: string): Promise<void> {
  await getDbClient().exec(`UPDATE bot_task_origins SET handoff_consumed_at=?
    WHERE handoff_consumed_at IS NULL AND bot_id IN
      (SELECT bot_id FROM bot_session_links WHERE session_id=? AND role='canonical')`, [Date.now(), sessionId]);
}
