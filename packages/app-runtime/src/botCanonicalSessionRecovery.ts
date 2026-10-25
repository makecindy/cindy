import { eq } from 'drizzle-orm';
import type { DbClient } from '@cindy/runtime-db';
import { botProfiles, botSessionLinks, sessions } from '@cindy/runtime-db/schema';
import type { createBotCanonicalSessionRegistry } from './botCanonicalSessionRegistry.js';
import type { createBotProfileService } from './botProfileService.js';
export type BotCanonicalEnsureResult = { ok: true; sessionId: string } | { ok: false; errorCode: string; message: string };
/** Original canonical link CAS/recovery, shared by messages and task delegation. */
export function createBotCanonicalSessionRecovery(host: {
  getDbClient(): DbClient;
  resolveBotCanonicalSession: ReturnType<typeof createBotCanonicalSessionRegistry>['resolveBotCanonicalSession'];
  createBotCanonicalSession: ReturnType<typeof createBotProfileService>['createBotCanonicalSession'];
  broadcastSessionCreated?(id: string): void;
}) {
  const { getDbClient, resolveBotCanonicalSession, createBotCanonicalSession } = host;
  const ensureTargetCanonicalSession = async (target: {
    id: string;
    currentVersion: number;
  }, beforeRecovery?: () => Promise<void>): Promise<BotCanonicalEnsureResult> => {
    const db = getDbClient().drizzle;
    const registered = await resolveBotCanonicalSession(target.id);
    let expectedCanonicalSessionId = registered.status === 'resolved'
      ? registered.sessionId
      : null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (expectedCanonicalSessionId) {
        const [current] = await db
          .select({
            status: sessions.status,
            source: sessions.source,
            botId: botSessionLinks.botId,
            role: botSessionLinks.role,
          })
          .from(sessions)
          .leftJoin(botSessionLinks, eq(botSessionLinks.sessionId, sessions.id))
          .where(eq(sessions.id, expectedCanonicalSessionId))
          .limit(1);
        if (
          current?.status === 'active'
          && current.source === 'bot'
          && current.botId === target.id
          && current.role === 'canonical'
        ) {
          return { ok: true, sessionId: expectedCanonicalSessionId };
        }
        await beforeRecovery?.();
        const replacement = await createBotCanonicalSession({
          botId: target.id,
          // This is an authoritative link CAS, including a dangling link. The
          // mirror-only recovery mode would incorrectly compare it against null.
          // The shared transaction still refuses to replace a healthy Session.
          expectedCanonicalSessionId,
          expectedProfileVersion: target.currentVersion,
        }, beforeRecovery);
        if (replacement.created) host.broadcastSessionCreated?.(replacement.canonicalSessionId);
        expectedCanonicalSessionId = replacement.canonicalSessionId;
        continue;
      }
      await beforeRecovery?.();
      const created = await createBotCanonicalSession({
        botId: target.id,
        expectedCanonicalSessionId: null,
        expectedProfileVersion: target.currentVersion,
      }, beforeRecovery);
      if (created.created) host.broadcastSessionCreated?.(created.canonicalSessionId);
      expectedCanonicalSessionId = created.canonicalSessionId;
    }
    return {
      ok: false,
      errorCode: 'TARGET_CANONICAL_UNAVAILABLE',
      message: '目标伙伴的主任务正在变化，请稍后重试发送',
    };
  };

  const ensureCanonicalSession = async (botId: string, beforeRecovery?: () => Promise<void>) => {
    const [profile] = await getDbClient().drizzle
      .select({ id: botProfiles.id, currentVersion: botProfiles.currentVersion, status: botProfiles.status })
      .from(botProfiles)
      .where(eq(botProfiles.id, botId))
      .limit(1);
    if (!profile || profile.status !== 'active') {
      return { ok: false as const, errorCode: 'TARGET_BOT_INACTIVE', message: '目标伙伴已暂停或归档' };
    }
    await beforeRecovery?.();
    return ensureTargetCanonicalSession({ id: profile.id, currentVersion: profile.currentVersion }, beforeRecovery);
  };
  return { ensureCanonicalSession };
}
