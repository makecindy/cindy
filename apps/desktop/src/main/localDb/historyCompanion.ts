import { sql, type SQL } from 'drizzle-orm';
import type { HistoryCompanion } from '@cindy/mcps';

/** Attribution is a persisted link, never a directory, channel, name or current connection guess. */
export function historyCompanionJson(sessionId: SQL): SQL<string | null> {
  return sql<string | null>`(SELECT json_object('id', hcl.bot_id, 'role', hcl.role, 'routeKey', hcl.route_key)
    FROM bot_session_links hcl WHERE hcl.session_id = ${sessionId} LIMIT 1)`;
}

export function parseHistoryCompanion(value: string | null | undefined): HistoryCompanion | null {
  if (!value) return null;
  const row = JSON.parse(value) as { id: string; role: string; routeKey: string | null };
  const channel = row.routeKey?.match(/^im:([^:]+):/)?.[1];
  return { id: row.id, role: row.role, ...(channel ? { channel } : {}) };
}

/** A query filter only: callers' existing authorization/remote visibility still applies. */
export function teammateHistoryFilter(sessionId: SQL, teammateId: string): SQL {
  return sql`(EXISTS (SELECT 1 FROM bot_session_links hcf
    WHERE hcf.session_id = ${sessionId} AND hcf.bot_id = ${teammateId}) OR
    EXISTS (SELECT 1 FROM bot_task_origins hco WHERE hco.source_session_id = ${sessionId}
      AND hco.bot_id = ${teammateId}))`;
}
