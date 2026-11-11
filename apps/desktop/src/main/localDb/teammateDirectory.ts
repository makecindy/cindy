import { getDbClient } from './client/current.js';
import type { XdtHelperHistoryDeps } from '@cindy/mcps';

/** Account metadata shared by Agent tools and the authenticated history query.
 * No profile configuration, prompts, credentials or activation side effects. */
export async function readTeammateDirectory(args: Parameters<NonNullable<XdtHelperHistoryDeps['listTeammates']>>[0] & { remoteVisibleOnly?: boolean }) {
  const db = getDbClient();
  // Seek through existing primary/role indexes; no startup migration or full directory projection.
  const { limit, cursor, teammateId } = args;
  const visible = '(hidden_at IS NULL OR hidden_at = 0) AND status <> \'archived\'';
  if (teammateId) {
    const after = cursor?.rowid !== undefined;
    const rows = await db.query<{ rowid: number; sessionId: string; role: string; routeKey: string | null; archivedAt: number | null }>(
      `SELECT rowid, session_id AS sessionId, role, route_key AS routeKey, archived_at AS archivedAt
       FROM bot_session_links WHERE bot_id = ? ${after ? 'AND (role, rowid) > (?, ?)' : ''}
       ${args.remoteVisibleOnly ? `AND EXISTS (SELECT 1 FROM bot_profiles WHERE id = bot_session_links.bot_id AND ${visible})` : ''}
       ORDER BY role, rowid LIMIT ?`, [teammateId, ...(after ? [cursor!.id, cursor!.rowid] : []), limit + 1]);
    const items = rows.slice(0, limit), last = items.at(-1), hasMore = rows.length > limit;
    return { items: items.map(({ rowid: _rowid, ...item }) => item), hasMore,
      nextCursor: hasMore && last ? { createdAt: 0, id: last.role, rowid: last.rowid } : null };
  }
  const conditions = [...(cursor ? ['id > ?'] : []), ...(args.remoteVisibleOnly ? [visible] : [])];
  const rows = await db.query<{ id: string; name: string; status: string; hiddenAt: number | null }>(
    `SELECT id, display_name AS name, status, hidden_at AS hiddenAt FROM bot_profiles
     ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY id LIMIT ?`, [...(cursor ? [cursor.id] : []), limit + 1]);
  const items = rows.slice(0, limit), last = items.at(-1), hasMore = rows.length > limit;
  return { items, hasMore, nextCursor: hasMore && last ? { createdAt: 0, id: last.id } : null };
}
