/** Which stored rows of a companion's task the room mirror reads, and the images a reply's turn produced. */
import { and, asc, desc, eq, gt, inArray, isNull, lt, lte } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { messages } from '../localDb/schema.js';
import type * as schema from '../localDb/schema.js';
import { mirrorMessageText } from './mirror.js';
import { toolResultImageUrls } from './replyArtifacts.js';

export const mirrorColumns = {
  id: messages.id, clientId: messages.clientId, role: messages.role, content: messages.content,
  agentMeta: messages.agentMeta, createdAt: messages.createdAt,
};
export const visibleRows = (sessionId: string) => and(eq(messages.sessionId, sessionId), isNull(messages.rewindAt),
  inArray(messages.role, ['user', 'assistant']));

/**
 * Stored images the tools produced since the row before this reply that the room also gets (the
 * previous mirrored user or assistant row, the same test as mirrorMessageText): what the chat shows
 * as images of the turn. Each lands on the first mirrored reply after it, so a progress note or
 * sub-agent row between the tool and the reply does not take them away.
 */
export async function readTurnImageUrls(drizzle: BetterSQLite3Database<typeof schema>, sessionId: string, row: { id: string; createdAt: number }): Promise<string[]> {
  let before = row.createdAt;
  let previousAt = 0;
  for (let pages = 0; pages < 20; pages += 1) {
    const rows = await drizzle.select(mirrorColumns).from(messages)
      .where(and(visibleRows(sessionId), lt(messages.createdAt, before)))
      .orderBy(desc(messages.createdAt), desc(messages.id)).limit(50);
    const found = rows.find(candidate => mirrorMessageText(candidate) !== null);
    if (found) { previousAt = found.createdAt; break; }
    if (rows.length < 50) break;
    before = rows[rows.length - 1]!.createdAt;
  }
  const results = await drizzle.select({ content: messages.content }).from(messages)
    .where(and(eq(messages.sessionId, sessionId), isNull(messages.rewindAt), eq(messages.role, 'tool_result'),
      gt(messages.createdAt, previousAt), lte(messages.createdAt, row.createdAt)))
    .orderBy(asc(messages.createdAt)).limit(50);
  return [...new Set(results.flatMap(result => toolResultImageUrls(result.content)))];
}

