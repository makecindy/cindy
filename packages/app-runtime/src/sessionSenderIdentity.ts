import {eq} from 'drizzle-orm';
import type {DbClient} from '@cindy/runtime-db';
import {sessions,botProfiles,botSessionLinks} from '@cindy/runtime-db/schema';
export function createSessionSenderIdentityReader(getDbClient:()=>DbClient) {
  async function readSenderIdentity(
    sessionId: string | undefined,
  ): Promise<{ dispatcherSessionTitle?: string | null; dispatcherBot?: { id: string; name: string } | null }> {
    if (!sessionId) return {};
    try {
      const [row] = await getDbClient()
        .drizzle.select({
          title: sessions.title,
          botId: botSessionLinks.botId,
          botName: botProfiles.displayName,
        })
        .from(sessions)
        .leftJoin(botSessionLinks, eq(botSessionLinks.sessionId, sessions.id))
        .leftJoin(botProfiles, eq(botProfiles.id, botSessionLinks.botId))
        .where(eq(sessions.id, sessionId))
        .limit(1);
      if (!row) return {};
      return {
        dispatcherSessionTitle: row.title,
        dispatcherBot: row.botId ? { id: row.botId, name: row.botName || row.botId } : null,
      };
    } catch {
      return {};
    }
  }

return readSenderIdentity;
}
