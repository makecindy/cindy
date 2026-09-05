import { and, eq, isNull } from 'drizzle-orm';

import { getDbClient } from '../localDb/client/current.js';
import { botSessionLinks } from '../localDb/schema.js';

export type BotCanonicalSessionResolution =
  | { status: 'resolved'; sessionId: string }
  | { status: 'missing' | 'conflict'; sessionId: null };

/**
 * Read the one authoritative canonical Session registration for a Bot.
 *
 * `bot_profiles.canonical_session_id` is intentionally absent here. That
 * column is only a compatibility mirror repaired by the migration/reconcile
 * path; runtime ownership and delivery must never fall back to it.
 */
export async function resolveBotCanonicalSession(
  botId: string,
): Promise<BotCanonicalSessionResolution> {
  const rows = await getDbClient()
    .drizzle.select({ sessionId: botSessionLinks.sessionId })
    .from(botSessionLinks)
    .where(and(
      eq(botSessionLinks.botId, botId),
      eq(botSessionLinks.role, 'canonical'),
      isNull(botSessionLinks.archivedAt),
    ))
    .limit(2);
  if (rows.length === 0) return { status: 'missing', sessionId: null };
  if (rows.length !== 1) return { status: 'conflict', sessionId: null };
  return { status: 'resolved', sessionId: rows[0]!.sessionId };
}
