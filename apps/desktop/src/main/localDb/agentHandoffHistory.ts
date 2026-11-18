import { and, eq, gt, gte, desc, isNull, or, inArray, sql } from 'drizzle-orm';
import { getDbClient } from './client/current.js';
import { messages, sessions } from './schema.js';

const messageRowid = sql<number>`rowid`;

/**
 * session-agent-switch:读取交接素材——本会话未被 rewind、晚于 /clear 边界的
 * 最近 limit 行(时间正序返回),只取交接需要的最小投影；null 读取边界内完整历史。
 *
 * `after`(Phase 2 增量交接):只取严格晚于该水位线(createdAt + rowid 决序,
 * 与 findPendingAgentHandoff 同 tie-break 口径)的行——即目标引擎停泊
 * 边界行之后、它"离开期间"的进展。
 */
export async function listMessagesForAgentHandoff(
  sessionId: string,
  limit: number | null = 400,
  after?: { createdAt: number; rowid: number },
  role?: 'user' | 'authorization',
): Promise<
  Array<{
    clientId: string;
    role: string;
    content: unknown;
    createdAt: number;
    agentMeta: Record<string, unknown> | null;
    toolUseId: string | null;
  }>
> {
  const db = getDbClient().drizzle;
  const [sessRow] = await db
    .select({ clearedAt: sessions.clearedAt, source: sessions.source, createdAt: sessions.createdAt })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  const clearedAt = sessRow?.clearedAt ?? null;
  const afterClear = clearedAt === null ? undefined : gt(messages.createdAt, clearedAt);
  const afterWatermark =
    after === undefined
      ? undefined
      : or(
          gt(messages.createdAt, after.createdAt),
          and(eq(messages.createdAt, after.createdAt), gt(messageRowid, after.rowid)),
        );
  // Bound authorization history by answer acceptance, not the earlier question time.
  const authorityTime = sql<number>`CASE WHEN ${messages.role} IN ('ask_user', 'plan_review')
    AND json_valid(${messages.agentMeta}) THEN CASE
      WHEN json_type(${messages.agentMeta}, '$.autoReviewUserText.acceptedAt') IN ('integer', 'real')
      AND json_type(${messages.agentMeta}, '$.autoReviewUserText.text') = 'text'
      THEN json_extract(${messages.agentMeta}, '$.autoReviewUserText.acceptedAt')
      ELSE ${messages.createdAt} END ELSE ${messages.createdAt} END`;
  // Scheduled executions are not owner messages. Exclude them before LIMIT so
  // a long-running heartbeat cannot push its authorizing request out of history.
  // Empty human receipts can reset resource authorization; only protected typed continuations are skipped.
  // Keep malformed/unknown rows: restoration must still invalidate ambiguous consent.
  const notScheduledExecution = sql`CASE WHEN ${messages.role} = 'user'
    AND json_valid(${messages.agentMeta}) THEN CASE
      WHEN json_extract(${messages.agentMeta}, '$.autoReviewUserText.kind') IN ('scheduled-continuation', 'delegated-continuation')
      THEN 0 ELSE 1 END ELSE 1 END`;
  const query = db
    .select({
      rowid: messageRowid,
      clientId: messages.clientId,
      role: messages.role,
      content: messages.content,
      createdAt: messages.createdAt,
      agentMeta: messages.agentMeta,
      toolUseId: messages.toolUseId,
    })
    .from(messages)
    .where(
      and(eq(messages.sessionId, sessionId), isNull(messages.rewindAt), afterClear, afterWatermark,
        // A copied parent instruction is context, never authorization for a side task.
        role === 'authorization' && sessRow?.source === 'side-chat' ? gte(messages.createdAt, sessRow.createdAt) : undefined,
        role === 'authorization' ? and(inArray(messages.role, ['user', 'ask_user', 'plan_review']), notScheduledExecution)
          : role ? eq(messages.role, role) : undefined),
    )
    .orderBy(desc(role === 'authorization' ? authorityTime : messages.createdAt), desc(messageRowid));
  // Authority replay must start at the clear/rewind boundary: the shared intent
  // budget is stateful, so an arbitrary row suffix has a different projection.
  const rows = await (limit === null ? query : query.limit(limit));
  rows.reverse();
  return rows
    .map((r) => {
      let content: unknown = r.content;
      try {
        content = JSON.parse(r.content);
      } catch {
        // 与 messageToCamel 同口径:非法 JSON 保留原字符串
      }
      let agentMeta: Record<string, unknown> | null = null;
      if (r.agentMeta) {
        try {
          const parsed: unknown = JSON.parse(r.agentMeta);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            agentMeta = parsed as Record<string, unknown>;
          }
        } catch {
          // 非法 JSON 视为无 meta
        }
      }
      if (agentMeta?.voiceCall) return null;
      if (agentMeta && typeof agentMeta.contextRebuild === 'object' && agentMeta.contextRebuild) {
        return null;
      }
      // 任务导入的时间线标记只用于显示。
      if (agentMeta && typeof agentMeta.sessionImport === 'object' && agentMeta.sessionImport) {
        return null;
      }
      return {
        clientId: r.clientId,
        role: r.role,
        content,
        createdAt: r.createdAt,
        agentMeta,
        toolUseId: r.toolUseId ?? null,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);
}
