import { eq } from 'drizzle-orm';
import type { Session } from '@cindy/maker-core';
import type { DbClient } from '@cindy/runtime-db';
import { botProfiles, botSessionLinks, sessions } from '@cindy/runtime-db/schema';
import { botSessionInputBlockReason } from './botSessionInputGuard.js';
export function createBotImSendGuard(host: {
  getDbClient(): DbClient;
  reconcileBotModelRoute(sessionId: string): Promise<unknown>;
  getSession(sessionId: string): Session | undefined;
  refreshBotCapabilityEpochBeforeSend(session: Session): Promise<unknown>;
}) {
const {getDbClient}=host;
return async (sessionId: string): Promise<string | null> => {
    const [botInput] = await getDbClient()
      .drizzle.select({
        source: sessions.source,
        role: botSessionLinks.role,
        profileStatus: botProfiles.status,
      })
      .from(sessions)
      .leftJoin(botSessionLinks, eq(botSessionLinks.sessionId, sessions.id))
      .leftJoin(botProfiles, eq(botProfiles.id, botSessionLinks.botId))
      .where(eq(sessions.id, sessionId))
      .limit(1);
    const blocked = botSessionInputBlockReason(botInput ?? null);
    if (blocked || botInput?.source !== 'bot') return blocked;
    // TODO(im-bot-companion): IM turns do not yet get the desktop model-chain
    // fallback (botFallbackInputs / coordinator recovery); a failing primary
    // route surfaces as an IM error instead of moving to the next candidate.
    await host.reconcileBotModelRoute(sessionId);
    const live = host.getSession(sessionId);
    if (live) await host.refreshBotCapabilityEpochBeforeSend(live);
    return null;
};
}
