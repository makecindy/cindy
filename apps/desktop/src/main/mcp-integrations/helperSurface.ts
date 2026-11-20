import type { DbClient } from '../localDb/client/DbClient.js';

/** Companion tasks add their profile tools to the ordinary transport's helper surface.
 * Classification is a business-object distinction, not a separate permission tier.
 */
export function classifyHelperSurface(
  source: string | null | undefined,
  hasBotLink: boolean,
  main?: { role: string | null | undefined; status: string | null | undefined; remoteHostId: string | null | undefined },
): 'bot' | 'bot-main' | 'default' {
  if (source !== 'bot' && !hasBotLink) return 'default';
  // A private-chat topic is the owner's own Bot Chat, so it gets the main Chat's surface.
  return source === 'bot' && hasBotLink && (main?.role === 'canonical' || main?.role === 'thread' || main?.role === 'routine')
    && main.status === 'active' && !main.remoteHostId
    ? 'bot-main'
    : 'bot';
}

/** Agent tools depend on the task's account and role, not who created the task. */
export async function resolveHelperSurface(
  db: Pick<DbClient, 'queryOne'>,
  sessionId: string,
): Promise<'bot' | 'bot-main' | 'default' | 'restricted'> {
  const row = await db.queryOne<{
    source: string; botId: string | null; botRole: string | null; status: string | null; remoteHostId: string | null;
  }>(
    `SELECT s.source AS source, b.bot_id AS botId,
       CASE WHEN b.archived_at IS NULL THEN b.role ELSE NULL END AS botRole, s.status AS status,
       s.remote_host_id AS remoteHostId
       FROM sessions s
       LEFT JOIN bot_session_links b ON b.session_id = s.id
      WHERE s.id = ? LIMIT 1`,
    [sessionId],
  );
  if (!row) return 'restricted';
  return classifyHelperSurface(row.source, Boolean(row.botId), {
    role: row.botRole,
    status: row.status,
    remoteHostId: row.remoteHostId,
  });
}
