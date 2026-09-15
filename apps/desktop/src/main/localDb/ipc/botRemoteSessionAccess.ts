import { eq, inArray } from 'drizzle-orm';
import { getDbClient } from '../client/current.js';
import { botProfiles, botSessionLinks, sessions } from '../schema.js';
import { isBotVisibleRemotely } from './botRemoteVisibility.js';
import {
  captureDataOwnerBroadcastScope,
  isDataOwnerBroadcastScopeCurrent,
} from '../../device-link/broadcast-tap.js';
import type { RemoteBotSessionAccess } from '../../device-link/remoteBotSessionBoundary.js';

/** Never infer companion authority from a controller's cached Session or resource link. */
export async function readRemoteBotSessionAccess(
  id: string,
  kind: 'session' | 'bot' = 'session',
): Promise<RemoteBotSessionAccess> {
  return (await readRemoteBotSessionAccessBatch([id], kind)).get(id) ?? 'hidden';
}

/** Bounded SQL batches, with no verdict cache across authorization passes. */
export async function readRemoteBotSessionAccessBatch(
  ids: readonly string[],
  kind: 'session' | 'bot',
): Promise<ReadonlyMap<string, RemoteBotSessionAccess>> {
  const unique = [...new Set(ids)];
  const result = new Map<string, RemoteBotSessionAccess>(unique.map((id) => [id, 'missing']));
  if (!unique.length) return result;
  const owner = captureDataOwnerBroadcastScope();
  const db = getDbClient().drizzle;
  for (let offset = 0; offset < unique.length; offset += 256) {
    const chunk = unique.slice(offset, offset + 256);
    if (kind === 'bot') {
      const profiles = await db
        .select({ id: botProfiles.id, hiddenAt: botProfiles.hiddenAt, status: botProfiles.status })
        .from(botProfiles)
        .where(inArray(botProfiles.id, chunk));
      for (const row of profiles)
        result.set(row.id, isBotVisibleRemotely(row) ? 'visible' : 'hidden');
    } else {
      const rows = await db
        .select({
          id: sessions.id,
          source: sessions.source,
          botId: botProfiles.id,
          hiddenAt: botProfiles.hiddenAt,
          status: botProfiles.status,
        })
        .from(sessions)
        .leftJoin(botSessionLinks, eq(botSessionLinks.sessionId, sessions.id))
        .leftJoin(botProfiles, eq(botProfiles.id, botSessionLinks.botId))
        .where(inArray(sessions.id, chunk));
      for (const row of rows) {
        result.set(
          row.id,
          row.source !== 'bot'
            ? 'ordinary'
            : row.botId &&
                row.status &&
                isBotVisibleRemotely({ hiddenAt: row.hiddenAt, status: row.status })
              ? 'visible'
              : 'hidden',
        );
      }
    }
    // Never combine rows from different owners if logout/switch happens mid-batch.
    if (!isDataOwnerBroadcastScopeCurrent(owner)) {
      return new Map(unique.map((id) => [id, 'hidden']));
    }
  }
  return result;
}
