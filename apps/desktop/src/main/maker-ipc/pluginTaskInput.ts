import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { DbClient } from '../localDb/client/DbClient.js';
import { messages, sessions } from '../localDb/schema.js';

export interface AcceptedTaskInput {
  clientId: string;
  autoResume?: boolean;
  retrySourceClientId?: string;
  authoredText?: string;
  originKind?: string;
}

/** Existing Host input evidence, shared by Orca control and retained-task tools. */
export async function hasAcceptedUserTaskInput(
  db: Pick<DbClient, 'drizzle'>,
  sessionId: string,
  input: AcceptedTaskInput | null,
  isWorker = false,
): Promise<boolean> {
  if ((input?.retrySourceClientId ?? input?.clientId)?.startsWith('plugin-task:')) return false;
  const authored = (text: unknown) => typeof text === 'string' && !!text.trim() && !text.startsWith('[UI_ACTION_TRIGGER]');
  // Human retries retain this Host stamp even after supersede rewinds the
  // original message. The stable plugin source above always takes precedence.
  if (input && !input.originKind && (!input.autoResume || input.retrySourceClientId) && authored(input.authoredText)) return true;
  if (input && !input.originKind && !input.autoResume && !input.retrySourceClientId) return false;
  // A new Lead directive to a Worker supersedes any older human assignment,
  // including the window before the native send acknowledgement is persisted.
  if (isWorker && input?.originKind === 'orca') return false;
  const meta = sql`CASE WHEN json_valid(${messages.agentMeta}) THEN ${messages.agentMeta} ELSE '{}' END`;
  const [source] = await db.drizzle.select({ clientId: messages.clientId, agentMeta: messages.agentMeta }).from(messages)
    .innerJoin(sessions, eq(sessions.id, messages.sessionId))
    .where(and(eq(messages.sessionId, sessionId), eq(messages.role, 'user'), isNull(messages.rewindAt),
      input?.retrySourceClientId ? eq(messages.clientId, input.retrySourceClientId) : undefined,
      sql`${messages.createdAt} > COALESCE(${sessions.clearedAt}, 0)`,
      sql`json_extract(${meta}, '$.parentUuid') IS NULL`,
      sql`(${messages.clientId} LIKE 'plugin-task:%' OR (
        COALESCE(json_extract(${meta}, '$.autoResume'), 0) != 1
        AND COALESCE(json_extract(${meta}, '$.contextRebuild'), 0) != 1
        AND (${isWorker ? 1 : 0} = 1 OR COALESCE(json_extract(${meta}, '$.origin.kind'), '') != 'orca')))`))
    .orderBy(desc(messages.createdAt), desc(sql`messages.rowid`)).limit(1);
  if (!source || source.clientId.startsWith('plugin-task:')) return false;
  let evidence: Record<string, unknown> | null;
  try { evidence = JSON.parse(source.agentMeta ?? '{}'); } catch { return false; }
  return !!evidence && !evidence.origin && ['turn', 'steer'].includes(String(evidence.delivery))
    && authored(evidence.autoReviewUserText);
}
