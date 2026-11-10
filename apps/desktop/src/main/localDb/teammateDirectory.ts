import { getDbClient } from './client/current.js';

/** Account metadata shared by Agent tools and the authenticated history query.
 * No profile configuration, prompts, credentials or activation side effects. */
export async function readTeammateDirectory() {
  const db = getDbClient();
  const profiles = await db.query<{ id: string; name: string; status: string; hiddenAt: number | null }>(
    'SELECT id, display_name AS name, status, hidden_at AS hiddenAt FROM bot_profiles ORDER BY updated_at DESC, id');
  const links = await db.query<{ botId: string; sessionId: string; role: string; routeKey: string | null; archivedAt: number | null }>(
    'SELECT bot_id AS botId, session_id AS sessionId, role, route_key AS routeKey, archived_at AS archivedAt FROM bot_session_links ORDER BY created_at, session_id');
  const byBot = new Map<string, typeof links>();
  for (const { botId, ...link } of links) {
    const rows = byBot.get(botId) ?? [];
    rows.push({ botId, ...link });
    byBot.set(botId, rows);
  }
  return profiles.map(profile => ({ ...profile, sessions: (byBot.get(profile.id) ?? []).map(({ botId: _botId, ...link }) => link) }));
}
