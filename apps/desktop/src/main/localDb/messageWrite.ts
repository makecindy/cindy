import { createId } from '@paralleldrive/cuid2';
import { and, eq } from 'drizzle-orm';
import type { DbClient } from './client/DbClient.js';
import { messages, sessions } from './schema.js';
import { messageCreateToRow } from './mapper.js';
import type { MessageRole, AgentMeta } from '../../renderer/lib/ccAgent.types.js';

type MessageRow = typeof messages.$inferSelect;
export interface MessageWriteBody {
  clientId: string;
  role: MessageRole;
  content: unknown;
  toolUseId?: string;
  agentMeta?: AgentMeta | null;
  agentKind?: 'cc' | 'codex' | 'pi' | null;
  createdAt?: number;
}
export interface MessageWriteOptions {
  expectedClearBoundaryMs?: number | null;
  beforePublish?: () => Promise<void>;
  requireNoUserMessage?: boolean;
}

/** The single durable insert transaction for every runtime. Presentation,
 * media delivery and indexing hooks remain with the caller. Never obtains a
 * different owner database after an await. */
export async function writeMessageRow(
  dbClient: DbClient,
  sessionId: string,
  body: MessageWriteBody,
  opts?: MessageWriteOptions,
): Promise<{ row: MessageRow; created: boolean }> {
  const db = dbClient.drizzle;
  const guarded =
    opts !== undefined && Object.prototype.hasOwnProperty.call(opts, 'expectedClearBoundaryMs');
  const expected = guarded ? opts?.expectedClearBoundaryMs : undefined;
  if (
    guarded &&
    expected !== null &&
    (typeof expected !== 'number' || !Number.isFinite(expected) || expected < 0)
  ) {
    throw new Error('expectedClearBoundaryMs must be null or a non-negative finite number');
  }

  // The unguarded API keeps its historical fast idempotency read. Guarded
  // optimistic sends must skip it: a pre-clear row can otherwise be returned
  // before the compare-and-set boundary is checked.
  if (!guarded) {
    const existing = await db
      .select()
      .from(messages)
      .where(and(eq(messages.sessionId, sessionId), eq(messages.clientId, body.clientId)))
      .limit(1);
    if (existing.length > 0) return { row: existing[0], created: false };
  }

  if (guarded && opts?.beforePublish)
    throw new Error('Publication guard cannot be combined with optimistic input');
  const id = createId();
  const now = Date.now();
  const visibleCreatedAt =
    guarded && expected !== null && expected !== undefined
      ? Math.max(body.createdAt ?? now, expected + 1)
      : (body.createdAt ?? now);
  const insertRow = messageCreateToRow(id, sessionId, body, visibleCreatedAt);
  const insertArgs = {
    id: insertRow.id,
    clientId: insertRow.clientId,
    sessionId,
    role: insertRow.role,
    content: insertRow.content,
    toolUseId: insertRow.toolUseId ?? null,
    agentMeta: insertRow.agentMeta ?? null,
    agentKind: insertRow.agentKind ?? null,
    createdAt: insertRow.createdAt,
    guarded,
    expectedClearBoundaryMs: guarded ? (expected ?? null) : undefined,
    ...(opts?.requireNoUserMessage ? { requireNoUserMessage: true } : {}),
  };
  try {
    const inserted = await dbClient.tx('message.insert', {
      ...insertArgs,
      ...(opts?.beforePublish ? { publication: 'stage' as const } : {}),
    });
    if (opts?.beforePublish) {
      await opts.beforePublish();
      try {
        const published = await dbClient.tx('message.insert', {
          ...insertArgs,
          publication: 'publish',
        });
        if (published.changes !== 1) throw new Error('Message publication lost its pending row');
      } catch (error) {
        // The worker can commit before its receipt is lost. Recover only this
        // exact publication, then run the same delivery/indexing hooks below.
        const [committed] = await db
          .select()
          .from(messages)
          .where(
            and(
              eq(messages.id, id),
              eq(messages.sessionId, sessionId),
              eq(messages.clientId, body.clientId),
            ),
          )
          .limit(1);
        if (
          !committed ||
          committed.role !== insertArgs.role ||
          committed.content !== insertArgs.content ||
          committed.toolUseId !== insertArgs.toolUseId ||
          committed.agentMeta !== insertArgs.agentMeta ||
          committed.agentKind !== insertArgs.agentKind ||
          committed.createdAt !== insertArgs.createdAt ||
          committed.rewindAt !== null
        )
          throw error;
      }
      // Keep this outside the lost-receipt recovery: a failed authorization
      // check must never be mistaken for a successful committed publication.
      try {
        await opts.beforePublish();
      } catch (error) {
        await dbClient.tx('message.insert', { ...insertArgs, publication: 'rollback' });
        throw error;
      }
    }
    if (guarded && inserted.changes === 0) {
      const [existingAfterGuard] = await db
        .select()
        .from(messages)
        .where(and(eq(messages.sessionId, sessionId), eq(messages.clientId, body.clientId)))
        .limit(1);
      const [sessionAfterGuard] = await db
        .select({ clearedAt: sessions.clearedAt })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);
      const actual = sessionAfterGuard?.clearedAt ?? null;
      if (
        existingAfterGuard &&
        actual === expected &&
        existingAfterGuard.rewindAt === null &&
        (expected === null || existingAfterGuard.createdAt > expected)
      ) {
        return { row: existingAfterGuard, created: false };
      }
      if (actual !== expected) {
        throw Object.assign(
          new Error(
            `REMOTE_OPTIMISTIC_INPUT_CLEARED: expectedClearBoundaryMs=${expected ?? 'null'}; currentClearBoundaryMs=${actual ?? 'null'}`,
          ),
          { code: 'REMOTE_OPTIMISTIC_INPUT_CLEARED' },
        );
      }
      throw new Error('Message insert skipped without a clear-boundary change');
    }
  } catch (err) {
    if (opts?.beforePublish) {
      await dbClient.tx('message.insert', { ...insertArgs, publication: 'discard' });
      throw err;
    }
    const after = await db
      .select()
      .from(messages)
      .where(and(eq(messages.sessionId, sessionId), eq(messages.clientId, body.clientId)))
      .limit(1);
    if (guarded) {
      const [sessionAfterError] = await db
        .select({ clearedAt: sessions.clearedAt })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);
      const actual = sessionAfterError?.clearedAt ?? null;
      const existingAfterError = after[0];
      if (
        existingAfterError &&
        actual === expected &&
        existingAfterError.rewindAt === null &&
        (expected === null || existingAfterError.createdAt > expected)
      ) {
        return { row: existingAfterError, created: false };
      }
      if (actual !== expected) {
        throw Object.assign(
          new Error(
            `REMOTE_OPTIMISTIC_INPUT_CLEARED: expectedClearBoundaryMs=${expected ?? 'null'}; currentClearBoundaryMs=${actual ?? 'null'}`,
          ),
          { code: 'REMOTE_OPTIMISTIC_INPUT_CLEARED' },
        );
      }
    } else if (after.length > 0) {
      return { row: after[0], created: false };
    }
    throw err;
  }
  // 插入成功后不再整行回读:大 content(tool_result 全文)会经 DB worker 的
  // postMessage 再送回主进程一次。insertRow 就是刚写入的行(新行 rewind_at 恒
  // NULL);必须过 messageToCamel 走与回读完全相同的解析路径(JSON.parse 失败
  // 回退裸串、assistant 引文剥离),否则返回值/广播行的类型语义会漂移。幂等命中
  // 与 UNIQUE / guarded 回退路径仍保留各自的回读(上方),不受影响。
  const row: MessageRow = {
    id: insertRow.id,
    clientId: insertRow.clientId,
    sessionId: insertRow.sessionId,
    role: insertRow.role,
    content: insertRow.content,
    toolUseId: insertRow.toolUseId ?? null,
    agentMeta: insertRow.agentMeta ?? null,
    agentKind: insertRow.agentKind ?? null,
    createdAt: insertRow.createdAt,
    rewindAt: null,
  };
  return { row, created: true };
}
