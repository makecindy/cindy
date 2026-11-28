import { eq, inArray, sql } from 'drizzle-orm';
import { SESSION_STATUS_PROJECTION } from '../../../shared/pluginObserve.js';
import { getDbClient } from '../client/current.js';
import { botProfiles, botSessionLinks, sessions } from '../schema.js';
import { pluginSessionStatusFilter } from '../sessionVisibility.js';
import { isBotVisibleRemotely, remoteVisibleSessionSql } from './botRemoteVisibility.js';
import { captureDataOwnerBroadcastScope, isDataOwnerBroadcastScopeCurrent } from '../../device-link/broadcast-tap.js';
import type { RemoteBotSessionAccess, RemoteSessionLookupKind } from '../../device-link/remoteBotSessionBoundary.js';

/** Keep bind counts bounded and issue only one query at a time, even for huge rosters. */
const ACCESS_BATCH_SIZE = 200;

/** Fresh checks only: cached replies and replay must observe newly hidden companions. */
export async function readRemoteBotSessionAccessBatch(
  ids: readonly string[], kind: RemoteSessionLookupKind = 'session',
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
    if (kind === SESSION_STATUS_PROJECTION) {
      const rows = await db.select({ id: sessions.id }).from(sessions)
        .leftJoin(botSessionLinks, eq(botSessionLinks.sessionId, sessions.id))
        .where(pluginSessionStatusFilter(chunk));
      if (!isDataOwnerBroadcastScopeCurrent(owner)) return denyAll();
      for (const row of rows) access.set(row.id, 'ordinary');
    } else if (kind === 'bot') {
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
        hiddenAt: sessions.hiddenAt,
        visible: sql<number>`${sql.raw(remoteVisibleSessionSql('sessions'))}`,
      }).from(sessions)
        .where(inArray(sessions.id, chunk));
      if (!isDataOwnerBroadcastScopeCurrent(owner)) return denyAll();
      for (const row of rows) {
        // Hidden is a listing preference, not an owner access boundary.
        // Companion history and orphaned transcripts remain readable by exact ID.
        access.set(row.id, row.source !== 'bot' ? (row.hiddenAt != null ? 'background' : 'ordinary')
          : row.visible && row.hiddenAt == null ? 'visible' : 'background');
      }
    }
  }
  return access;
}

/** Never infer companion authority from a controller's cached Session or resource link. */
export async function readRemoteBotSessionAccess(sessionId: string, kind: RemoteSessionLookupKind = 'session'): Promise<RemoteBotSessionAccess> {
  return (await readRemoteBotSessionAccessBatch([sessionId], kind)).get(sessionId) ?? 'hidden';
}
