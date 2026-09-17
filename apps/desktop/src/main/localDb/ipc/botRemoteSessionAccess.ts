import { eq, inArray } from 'drizzle-orm';
import { getDbClient } from '../client/current.js';
import { botProfiles, botSessionLinks, sessions } from '../schema.js';
import { isBotVisibleRemotely } from './botRemoteVisibility.js';
import { captureDataOwnerBroadcastScope, isDataOwnerBroadcastScopeCurrent } from '../../device-link/broadcast-tap.js';
import type { RemoteBotSessionAccess } from '../../device-link/remoteBotSessionBoundary.js';

/** Keep bind counts bounded and issue only one query at a time, even for huge rosters. */
const ACCESS_BATCH_SIZE = 200;

/** Fresh checks only: cached replies and replay must observe newly hidden companions. */
export async function readRemoteBotSessionAccessBatch(
  ids: readonly string[], kind: 'session' | 'bot' = 'session',
): Promise<Map<string, RemoteBotSessionAccess>> {
  const uniqueIds = [...new Set(ids)];
  const access = new Map<string, RemoteBotSessionAccess>();
  if (!uniqueIds.length) return access;
  const owner = captureDataOwnerBroadcastScope();
  const db = getDbClient().drizzle;
  const denyAll = () => new Map(uniqueIds.map((id) => [id, 'hidden' as const]));
  for (let offset = 0; offset < uniqueIds.length; offset += ACCESS_BATCH_SIZE) {
    if (!isDataOwnerBroadcastScopeCurrent(owner)) return denyAll();
    const chunk = uniqueIds.slice(offset, offset + ACCESS_BATCH_SIZE);
    for (const id of chunk) access.set(id, 'missing');
    if (kind === 'bot') {
      const profiles = await db.select({ id: botProfiles.id, hiddenAt: botProfiles.hiddenAt, status: botProfiles.status })
        .from(botProfiles).where(inArray(botProfiles.id, chunk));
      if (!isDataOwnerBroadcastScopeCurrent(owner)) return denyAll();
      for (const profile of profiles) {
        access.set(profile.id, isBotVisibleRemotely(profile) ? 'visible' : 'hidden');
      }
    } else {
      const rows = await db.select({
        id: sessions.id,
        source: sessions.source,
        botId: botProfiles.id,
        hiddenAt: botProfiles.hiddenAt,
        status: botProfiles.status,
      }).from(sessions)
        .leftJoin(botSessionLinks, eq(botSessionLinks.sessionId, sessions.id))
        .leftJoin(botProfiles, eq(botProfiles.id, botSessionLinks.botId))
        .where(inArray(sessions.id, chunk));
      if (!isDataOwnerBroadcastScopeCurrent(owner)) return denyAll();
      for (const row of rows) {
        access.set(row.id, row.source !== 'bot' ? 'ordinary'
          : row.botId && row.status && isBotVisibleRemotely({ hiddenAt: row.hiddenAt, status: row.status })
            ? 'visible' : 'hidden');
      }
    }
  }
  return access;
}

/** Never infer companion authority from a controller's cached Session or resource link. */
export async function readRemoteBotSessionAccess(sessionId: string, kind: 'session' | 'bot' = 'session'): Promise<RemoteBotSessionAccess> {
  return (await readRemoteBotSessionAccessBatch([sessionId], kind)).get(sessionId) ?? 'hidden';
}
