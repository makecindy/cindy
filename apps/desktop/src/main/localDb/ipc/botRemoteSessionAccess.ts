import { eq } from 'drizzle-orm';
import { getDbClient } from '../client/current.js';
import { botProfiles, botSessionLinks, sessions } from '../schema.js';
import { isBotVisibleRemotely } from './botRemoteVisibility.js';
import { captureDataOwnerBroadcastScope, isDataOwnerBroadcastScopeCurrent } from '../../device-link/broadcast-tap.js';

/** Never infer companion authority from a controller's cached Session or resource link. */
export async function readRemoteBotSessionAccess(sessionId: string, kind: 'session' | 'bot' = 'session'): Promise<'ordinary' | 'visible' | 'hidden' | 'missing'> {
  const owner = captureDataOwnerBroadcastScope();
  if (kind === 'bot') {
    const [profile] = await getDbClient().drizzle.select({ hiddenAt: botProfiles.hiddenAt, status: botProfiles.status })
      .from(botProfiles).where(eq(botProfiles.id, sessionId)).limit(1);
    if (!isDataOwnerBroadcastScopeCurrent(owner)) return 'hidden';
    return profile ? (isBotVisibleRemotely(profile) ? 'visible' : 'hidden') : 'missing';
  }
  const [row] = await getDbClient().drizzle.select({
    source: sessions.source,
    botId: botProfiles.id,
    hiddenAt: botProfiles.hiddenAt,
    status: botProfiles.status,
  }).from(sessions)
    .leftJoin(botSessionLinks, eq(botSessionLinks.sessionId, sessions.id))
    .leftJoin(botProfiles, eq(botProfiles.id, botSessionLinks.botId))
    .where(eq(sessions.id, sessionId)).limit(1);
  if (!isDataOwnerBroadcastScopeCurrent(owner)) return 'hidden';
  if (!row) return 'missing';
  if (row.source !== 'bot') return 'ordinary';
  return row.botId && row.status && isBotVisibleRemotely({ hiddenAt: row.hiddenAt, status: row.status })
    ? 'visible' : 'hidden';
}
