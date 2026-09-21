import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { getCindyMakeMessageAttention } from '../../shared/cindyMakeAttention.js';
import { getDbClient } from './client/current.js';
import { messages, sessions } from './schema.js';

/** Restore unresolved native Make failures even when their task has never been opened. */
export async function listCindyMakePendingFailureSessionIds(): Promise<string[]> {
  const rows = await getDbClient()
    .drizzle.select({
      sessionId: messages.sessionId,
      role: messages.role,
      content: messages.content,
      agentMeta: messages.agentMeta,
    })
    .from(messages)
    .innerJoin(sessions, eq(sessions.id, messages.sessionId))
    .where(
      and(
        eq(sessions.source, 'cindy-make'),
        eq(sessions.status, 'active'),
        eq(messages.role, 'assistant'),
        isNull(messages.rewindAt),
        gt(messages.createdAt, sql`COALESCE(${sessions.clearedAt}, 0)`),
        sql`NOT EXISTS (
          SELECT 1 FROM messages m2
          WHERE m2.session_id = ${messages.sessionId}
            AND m2.rewind_at IS NULL
            AND (m2.created_at > ${messages.createdAt}
              OR (m2.created_at = ${messages.createdAt}
                AND m2.rowid > ${sql.raw('"messages"."rowid"')}))
        )`,
      ),
    );
  return rows
    .filter((row) => getCindyMakeMessageAttention(row)?.kind === 'error')
    .map((row) => row.sessionId);
}
