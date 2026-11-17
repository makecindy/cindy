import { and, eq, inArray, isNull, ne } from 'drizzle-orm';
import { getDbClient } from '../localDb/client/current.js';
import { botSessionLinks, botProfiles, sessions } from '../localDb/schema.js';
/** Uses the canonical DB link, never an agent-supplied bot identity. */
export async function isBotAuthorizationSession(sessionId: string): Promise<boolean> {
  return (await readBotAuthorizationBot(sessionId)) !== null;
}

/** The active teammate whose owner chat this session is; null for every other caller. */
export async function readBotAuthorizationBot(sessionId: string): Promise<{ id: string; name: string } | null> {
  const [row] = await getDbClient()
    .drizzle.select({ id: botSessionLinks.botId, status: botProfiles.status, name: botProfiles.displayName })
    .from(botSessionLinks)
    .innerJoin(sessions, eq(sessions.id, botSessionLinks.sessionId))
    .innerJoin(botProfiles, eq(botProfiles.id, botSessionLinks.botId))
    .where(
      and(
        eq(botSessionLinks.sessionId, sessionId),
        // The owner's Bot Chat: the permanent Chat and its private-chat topics.
        inArray(botSessionLinks.role, ['canonical', 'thread', 'routine']),
        isNull(botSessionLinks.archivedAt),
        ne(sessions.status, 'deleted'),
        ne(sessions.status, 'archived'),
        isNull(sessions.remoteHostId),
      ),
    )
    .limit(1);
  return row?.status === 'active' ? { id: row.id, name: row.name ?? '' } : null;
}

