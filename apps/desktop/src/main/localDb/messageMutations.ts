import { and, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import type { DbClient } from './client/DbClient.js';
import { messages, sessions } from './schema.js';
import { safeStringify } from './mapper.js';

/** Owner is captured by the caller. Do not reacquire a database after an await. */
export async function writeMessageContentRow(
  client: DbClient,
  sessionId: string,
  clientId: string,
  content: unknown,
  autoReviewAnswer?: { text: string; acceptedAt: number },
): Promise<typeof messages.$inferSelect | undefined> {
  const db = client.drizzle;
  const serialized = safeStringify(content);
  if (autoReviewAnswer !== undefined) {
    await db
      .update(messages)
      .set({
        content: serialized,
        agentMeta: sql`json_set(CASE WHEN json_valid(${messages.agentMeta}) THEN ${messages.agentMeta} ELSE '{}' END,
        '$.autoReviewUserText', json(${JSON.stringify(autoReviewAnswer)}))`,
      })
      .where(
        and(
          eq(messages.sessionId, sessionId),
          eq(messages.clientId, clientId),
          inArray(messages.role, ['ask_user', 'plan_review']),
        ),
      );
  } else await client.tx('message.updateContent', { sessionId, clientId, content: serialized });
  // Do not send an MB-sized tool result through the worker twice.
  const [row] = await db
    .select({
      id: messages.id,
      clientId: messages.clientId,
      sessionId: messages.sessionId,
      role: messages.role,
      toolUseId: messages.toolUseId,
      agentMeta: messages.agentMeta,
      agentKind: messages.agentKind,
      createdAt: messages.createdAt,
      rewindAt: messages.rewindAt,
    })
    .from(messages)
    .where(and(eq(messages.sessionId, sessionId), eq(messages.clientId, clientId)))
    .limit(1);
  return row ? { ...row, content: serialized } : undefined;
}

/** Exact publication rollback: a late correction cannot remove a replacement row. */
export async function rollbackAssistantMessageRow(
  client: DbClient,
  sessionId: string,
  clientId: string,
  isCurrent: () => boolean,
): Promise<typeof messages.$inferSelect | null> {
  if (!isCurrent()) return null;
  const [row] = await client.drizzle
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.sessionId, sessionId),
        eq(messages.clientId, clientId),
        eq(messages.role, 'assistant'),
        isNull(messages.rewindAt),
      ),
    )
    .limit(1);
  if (!row || !isCurrent()) return null;
  const result = await client.tx('message.insert', {
    id: row.id,
    clientId: row.clientId,
    sessionId: row.sessionId,
    role: row.role,
    content: row.content,
    toolUseId: row.toolUseId,
    agentMeta: row.agentMeta,
    agentKind: row.agentKind,
    createdAt: row.createdAt,
    guarded: false,
    publication: 'rollback',
  });
  return result.changes === 0 ? null : row;
}

export function parseAgentMetaRecord(agentMeta: string | null): Record<string, unknown> | null {
  if (!agentMeta) return null;
  try {
    const parsed = JSON.parse(agentMeta);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export interface VisibleToolUseMessageLink {
  clientId: string;
  toolUseId: string;
}

export interface MessageAgentMetaPatchResult {
  previous: Record<string, unknown>;
  next: Record<string, unknown>;
}

export async function patchMessageAgentMetaWithResultRow(
  dbClient: DbClient,
  sessionId: string,
  clientId: string,
  patch: Record<string, unknown>,
): Promise<MessageAgentMetaPatchResult | null> {
  const db = dbClient.drizzle;
  const rows = await db
    .select({ agentMeta: messages.agentMeta })
    .from(messages)
    .where(and(eq(messages.sessionId, sessionId), eq(messages.clientId, clientId)))
    .limit(1);
  if (rows.length === 0) return null;
  // 损坏的 JSON 以 {} 为底重建(补丁字段仍写入,旧字段无法挽救)。
  const previous = parseAgentMetaRecord(rows[0].agentMeta) ?? {};
  const next = { ...previous, ...patch };
  // Keep the read and write on the same owner even if login changes across await.
  await db
    .update(messages)
    .set({ agentMeta: JSON.stringify(next) })
    .where(and(eq(messages.sessionId, sessionId), eq(messages.clientId, clientId)));
  return { previous, next };
}

export async function findVisibleToolUseMessageByAliasesRow(
  dbClient: DbClient,
  sessionId: string,
  aliases: readonly string[],
): Promise<VisibleToolUseMessageLink | null> {
  const normalizedAliases = [...new Set(aliases.filter((alias) => alias.length > 0))];
  if (!sessionId || normalizedAliases.length === 0) return null;
  const [row] = await dbClient.drizzle
    .select({
      clientId: messages.clientId,
      toolUseId: messages.toolUseId,
    })
    .from(messages)
    .innerJoin(sessions, eq(messages.sessionId, sessions.id))
    .where(
      and(
        eq(messages.sessionId, sessionId),
        eq(messages.role, 'tool_use'),
        inArray(messages.toolUseId, normalizedAliases),
        isNull(messages.rewindAt),
        or(isNull(sessions.clearedAt), gt(messages.createdAt, sessions.clearedAt)),
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(1);
  return row?.clientId && row.toolUseId
    ? { clientId: row.clientId, toolUseId: row.toolUseId }
    : null;
}
