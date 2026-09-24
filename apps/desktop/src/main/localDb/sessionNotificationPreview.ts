import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { getDbClient } from './client/current.js';
import { botProfiles, botSessionLinks, messages, sessions } from './schema.js';
import { isTopLevelTitleAssistant } from './latestMessageText.logic.js';
import { extractText } from '../sessionTaskSummary.logic.js';
import { selectNotificationReply } from './sessionNotificationPreview.logic.js';

export interface SessionNotificationPreview {
  teammateName?: string;
  reply?: { clientId: string; text: string };
  eventId?: string;
  suppress?: boolean;
}

/** Use the durable current turn, never the previous answer or an internal task receipt. */
export async function readSessionNotificationPreview(sessionId: string, includeReply = true): Promise<SessionNotificationPreview> {
  const db = getDbClient().drizzle;
  const rows = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  const current = rows[0];
  if (!current) return {};
  const profile = current.source === 'bot' ? await db.select({ name: botProfiles.displayName })
    .from(botProfiles).innerJoin(botSessionLinks, eq(botSessionLinks.botId, botProfiles.id))
    .where(and(eq(botSessionLinks.sessionId, sessionId), eq(botSessionLinks.role, 'canonical'))).get() : undefined;
  const teammateName = profile?.name;
  // A delayed idle event may arrive after the next input has already started.
  // Do not notify that unfinished turn or reuse a pre-upgrade historical final.
  const startedAt = current.activeTurnStartedAt ?? 0;
  const endedAt = current.lastTurnEndedAt ?? 0;
  if (startedAt > endedAt) return { teammateName, suppress: true };
  if (startedAt <= 0) return { teammateName };
  // Stable across preview readiness: a retry after a fallback must not notify twice.
  const eventId = `turn:${startedAt}:${endedAt}`;
  if (!includeReply) return { teammateName, eventId };
  const recent = await db.select().from(messages).where(and(eq(messages.sessionId, sessionId), isNull(messages.rewindAt)))
    .orderBy(desc(messages.createdAt), desc(sql`rowid`)).limit(100);
  const reply = selectNotificationReply(recent.map((row) => {
    let meta: Record<string, unknown> = {};
    try { meta = row.agentMeta ? JSON.parse(row.agentMeta) : {}; } catch { /* fail closed */ }
    return {
      clientId: row.clientId, role: row.role, createdAt: row.createdAt,
      text: extractText(row.content, row.role), agentMeta: meta,
      topLevel: isTopLevelTitleAssistant(meta),
    };
  }), Math.max(startedAt, current.clearedAt ?? 0));
  return { teammateName, reply, eventId };
}
