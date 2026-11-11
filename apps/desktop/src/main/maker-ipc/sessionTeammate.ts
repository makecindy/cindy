import { and, eq, isNull } from 'drizzle-orm';

import { getDbClient } from '../localDb/client/current.js';
import { botSessionLinks, sessions } from '../localDb/schema.js';

/**
 * The teammate a task belongs to when it manages the teammate's things (e.g. new
 * teammates). Any of the teammate's chats qualifies, like an ordinary task in
 * its project: who may talk to that chat is decided where the message comes in.
 */
export async function resolveSessionTeammate(callerSessionId: string): Promise<string | null> {
  const [row] = await getDbClient().drizzle
    .select({ botId: botSessionLinks.botId })
    .from(botSessionLinks)
    .innerJoin(sessions, eq(sessions.id, botSessionLinks.sessionId))
    .where(and(
      eq(botSessionLinks.sessionId, callerSessionId),
      eq(sessions.source, 'bot'),
      isNull(botSessionLinks.archivedAt),
    ))
    .limit(1);
  return row?.botId ?? null;
}
