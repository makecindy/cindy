import { and, desc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { messages, sessions } from './schema.js';
import type { DbClient } from './client/DbClient.js';
export interface LatestVisiblePreviewRow { clientId: string; content: string; role: string; createdAt: number; }
const joinedMessageRowid = sql<number>`"messages"."rowid"`;
export function createMessagePreviewReader(getDbClient: () => DbClient) {


/**
 * 与 sessions:list 同一口径的最近可见 user/assistant 行。
 * clear 边界与消息放进同一条 JOIN,避免先读旧 clearedAt 再选出清空前的行。
 */
async function latestVisiblePreviewRow(
  sessionId: string,
): Promise<LatestVisiblePreviewRow | null> {
  const [row] = await getDbClient()
    .drizzle.select({
      clientId: messages.clientId,
      content: messages.content,
      role: messages.role,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .innerJoin(sessions, eq(messages.sessionId, sessions.id))
    .where(
      and(
        eq(messages.sessionId, sessionId),
        sql`${messages.role} IN ('user', 'assistant')`,
        isNull(messages.rewindAt),
        // SQLite may still evaluate json_extract when OR json_valid is false.
        // CASE keeps malformed historical agent_meta from failing the whole query.
        sql`(${messages.agentMeta} IS NULL OR CASE WHEN json_valid(${messages.agentMeta}) THEN json_extract(${messages.agentMeta}, '$.autoResume') END IS NOT 1)`,
        or(isNull(sessions.clearedAt), gt(messages.createdAt, sessions.clearedAt)),
      ),
    )
    .orderBy(desc(messages.createdAt), desc(joinedMessageRowid))
    .limit(1);
  return row ?? null;
}
return { latestVisiblePreviewRow };
}
