import { and, eq } from 'drizzle-orm';

import { getDbClient } from '../localDb/client/current.js';
import { createBotCanonicalSession } from '../localDb/ipc/bots.js';
import { botProfiles, botProfileVersions, botSessionLinks, sessions } from '../localDb/schema.js';
import { readEffectiveBotPrimaryRoute } from '../maker-host/bot-model-chain-settings-store.js';
import { resolveBotCanonicalSession } from './botCanonicalSessionRegistry.js';

export type EnsureBotCanonicalSessionResult =
  | { ok: true; sessionId: string; missingModel?: boolean }
  | { ok: false; errorCode: string; message: string };

/**
 * The teammate's healthy main chat, created or repaired when it is missing or broken.
 * Messages to a teammate (cloud room, direct messages) land here. A healthy Session is never
 * replaced: the shared transaction compares the authoritative canonical link first.
 */
export async function ensureBotCanonicalSession(
  botId: string,
  opts: { beforeRecovery?: () => Promise<void>; onCreated?: (sessionId: string) => void; allowMissingModel?: boolean } = {},
): Promise<EnsureBotCanonicalSessionResult> {
  const db = getDbClient().drizzle;
  const [profile] = await db
    .select({ id: botProfiles.id, currentVersion: botProfiles.currentVersion, status: botProfiles.status })
    .from(botProfiles)
    .where(eq(botProfiles.id, botId))
    .limit(1);
  if (!profile || profile.status !== 'active') {
    return { ok: false, errorCode: 'TARGET_BOT_INACTIVE', message: '目标伙伴已暂停或归档' };
  }
  const { beforeRecovery, onCreated, allowMissingModel } = opts;
  await beforeRecovery?.();
  const registered = await resolveBotCanonicalSession(profile.id);
  let expected = registered.status === 'resolved' ? registered.sessionId : null;
  let missingModel: boolean | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (expected) {
      const [current] = await db
        .select({ status: sessions.status, source: sessions.source, botId: botSessionLinks.botId, role: botSessionLinks.role })
        .from(sessions)
        .leftJoin(botSessionLinks, eq(botSessionLinks.sessionId, sessions.id))
        .where(eq(sessions.id, expected))
        .limit(1);
      if (current?.status === 'active' && current.source === 'bot'
        && current.botId === profile.id && current.role === 'canonical') {
        if (allowMissingModel && missingModel === undefined) {
          // A previous take-over may have created the task but failed importing history.
          // Check the current profile route, not the task's creation-time model fields.
          const [version] = await db
            .select({ config: botProfileVersions.capabilitiesJson })
            .from(botProfileVersions)
            .where(and(eq(botProfileVersions.botId, profile.id), eq(botProfileVersions.version, profile.currentVersion)))
            .limit(1);
          let config: unknown;
          try { config = JSON.parse(version?.config ?? '{}'); } catch { config = {}; }
          missingModel = !(await readEffectiveBotPrimaryRoute(config && typeof config === 'object' && !Array.isArray(config)
            ? config as Record<string, unknown> : {}));
          await beforeRecovery?.();
        }
        return { ok: true, sessionId: expected, ...(missingModel ? { missingModel: true } : {}) };
      }
    }
    await beforeRecovery?.();
    // An authoritative link CAS, including a dangling link (null when none is registered).
    const created = await createBotCanonicalSession({
      botId: profile.id,
      expectedCanonicalSessionId: expected,
      expectedProfileVersion: profile.currentVersion,
    }, beforeRecovery, allowMissingModel ? { allowMissingModel: true } : undefined);
    missingModel = created.missingModel === true;
    if (created.created) onCreated?.(created.canonicalSessionId);
    expected = created.canonicalSessionId;
  }
  return { ok: false, errorCode: 'TARGET_CANONICAL_UNAVAILABLE', message: '目标伙伴的主任务正在变化，请稍后重试发送' };
}
