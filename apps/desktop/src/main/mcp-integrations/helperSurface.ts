import type { DbClient } from '../localDb/client/DbClient.js';
import { readBotProjectMode } from '../../shared/botProjectMode.js';

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

/** The teammate owning this task runs as a project (V2). */
export async function resolveHelperTeammateProjectMode(
  db: Pick<DbClient, 'queryOne'>,
  sessionId: string,
): Promise<boolean> {
  const config = await readOwningBotConfig(db, sessionId);
  return config ? readBotProjectMode(config) : false;
}

async function readOwningBotConfig(
  db: Pick<DbClient, 'queryOne'>,
  sessionId: string,
): Promise<Record<string, unknown> | null> {
  const row = await db.queryOne<{ config: string | null }>(
    `SELECT v.capabilities_json AS config
       FROM bot_session_links b
       JOIN bot_profiles p ON p.id = b.bot_id
       JOIN bot_profile_versions v ON v.bot_id = p.id AND v.version = p.current_version
      WHERE b.session_id = ? AND b.archived_at IS NULL
      LIMIT 1`,
    [sessionId],
  );
  if (!row?.config) return null;
  try {
    const config = JSON.parse(row.config) as unknown;
    return config && typeof config === 'object' && !Array.isArray(config) ? config as Record<string, unknown> : null;
  } catch {
    return null;
  }
}
