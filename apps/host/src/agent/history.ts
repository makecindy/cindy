/**
 * Windowed history reader for cindy-host.
 *
 * Reuses createHistoryViewReader from desktop localDb/ipc/historyViewReader
 * so the web client gets the exact same pagination, work grouping,
 * and lazy details as desktop.
 */

import { and, asc, desc, eq, gt, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { createHistoryViewReader } from '../../../desktop/src/main/localDb/ipc/historyViewReader.js';
import { messageToCamel } from '../../../desktop/src/main/localDb/mapper.js';
import { messages as messageTable, sessions as sessionTable } from '../../../desktop/src/main/localDb/schema.js';
import { getDbClient } from '../../../desktop/src/main/localDb/client/current.js';
import type { Message } from '../../../desktop/src/renderer/lib/ccAgent.types.js';

const messageRowid = sql<number>`"messages"."rowid"`;

export interface HistoryListOptions {
  limit?: number;
  before?: string | null;
  after?: string | null;
}

export async function readMessagesList(sessionId: string, opts: HistoryListOptions = {}): Promise<Message[]> {
  const dbClient = getDbClient();
  if (!dbClient) throw new Error('DbClient not ready');
  const db = dbClient.drizzle;

  const limit = Math.max(1, Math.min(opts.limit ?? 200, 2000));
  const before = opts.before?.trim() || null;
  const after = opts.after?.trim() || null;

  // Session clearedAt boundary
  const [session] = await db
    .select({ clearedAt: sessionTable.clearedAt })
    .from(sessionTable)
    .where(eq(sessionTable.id, sessionId))
    .limit(1);
  const clearedAt = session?.clearedAt ?? null;

  let beforeCursor: { createdAt: number; rowid: number } | null = null;
  let afterCursor: { createdAt: number; rowid: number } | null = null;

  if (before) {
    const [row] = await db
      .select({ createdAt: messageTable.createdAt, rowid: messageRowid })
      .from(messageTable)
      .where(and(eq(messageTable.id, before), eq(messageTable.sessionId, sessionId)))
      .limit(1);
    if (row) beforeCursor = row;
  } else if (after) {
    const [row] = await db
      .select({ createdAt: messageTable.createdAt, rowid: messageRowid })
      .from(messageTable)
      .where(and(eq(messageTable.id, after), eq(messageTable.sessionId, sessionId)))
      .limit(1);
    if (row) afterCursor = row;
  }

  const conds: Array<SQL | undefined> = [
    eq(messageTable.sessionId, sessionId),
    isNull(messageTable.rewindAt),
  ];
  if (clearedAt !== null) {
    conds.push(gt(messageTable.createdAt, clearedAt));
  }

  if (beforeCursor) {
    conds.push(
      or(
        lt(messageTable.createdAt, beforeCursor.createdAt),
        and(eq(messageTable.createdAt, beforeCursor.createdAt), lt(messageRowid, beforeCursor.rowid)),
      ),
    );
  } else if (afterCursor) {
    conds.push(
      or(
        gt(messageTable.createdAt, afterCursor.createdAt),
        and(eq(messageTable.createdAt, afterCursor.createdAt), gt(messageRowid, afterCursor.rowid)),
      ),
    );
  }

  const rows = await db
    .select({
      id: messageTable.id,
      clientId: messageTable.clientId,
      sessionId: messageTable.sessionId,
      role: messageTable.role,
      content: messageTable.content,
      toolUseId: messageTable.toolUseId,
      agentMeta: messageTable.agentMeta,
      agentKind: messageTable.agentKind,
      createdAt: messageTable.createdAt,
      rewindAt: messageTable.rewindAt,
      rowid: messageRowid,
    })
    .from(messageTable)
    .where(and(...conds))
    .orderBy(
      afterCursor ? asc(messageTable.createdAt) : desc(messageTable.createdAt),
      afterCursor ? asc(messageRowid) : desc(messageRowid),
    )
    .limit(limit);

  const orderedRows = afterCursor ? rows.slice().reverse() : rows;
  return orderedRows.map((row) => ({
    ...messageToCamel(row),
    rowid: row.rowid,
  }));
}

export function createHostHistoryReader(isSessionRunning: (sessionId: string) => boolean = () => false) {
  return createHistoryViewReader<Message>({
    list: async (sessionId, opts) => {
      return readMessagesList(sessionId, {
        limit: opts.limit,
        before: opts.before,
        after: opts.after,
      });
    },
    anchor: async (sessionId, id) => {
      const dbClient = getDbClient();
      if (!dbClient) throw new Error('DbClient not ready');
      const db = dbClient.drizzle;

      const [row] = await db
        .select({
          id: messageTable.id,
          clientId: messageTable.clientId,
          sessionId: messageTable.sessionId,
          role: messageTable.role,
          content: messageTable.content,
          toolUseId: messageTable.toolUseId,
          agentMeta: messageTable.agentMeta,
          agentKind: messageTable.agentKind,
          createdAt: messageTable.createdAt,
          rewindAt: messageTable.rewindAt,
          rowid: messageRowid,
        })
        .from(messageTable)
        .where(and(eq(messageTable.sessionId, sessionId), eq(messageTable.id, id), isNull(messageTable.rewindAt)))
        .limit(1);

      if (!row) throw new Error(`Message not found: ${id}`);
      return {
        ...messageToCamel(row),
        rowid: row.rowid,
      };
    },
    running: isSessionRunning,
    live: () => [],
    revision: async () => '1',
  });
}

export async function readMessagesAroundClientId(
  sessionId: string,
  identifier: string,
  opts: { radius?: number } = {},
): Promise<Message[]> {
  const dbClient = getDbClient();
  if (!dbClient) throw new Error('DbClient not ready');
  const db = dbClient.drizzle;
  const radius = Math.max(1, Math.min(opts.radius ?? 50, 200));

  const [session] = await db
    .select({ clearedAt: sessionTable.clearedAt })
    .from(sessionTable)
    .where(eq(sessionTable.id, sessionId))
    .limit(1);
  const clearedAt = session?.clearedAt ?? null;
  const visibleConds = clearedAt === null ? [] : [gt(messageTable.createdAt, clearedAt)];

  const [anchor] = await db
    .select({
      id: messageTable.id,
      clientId: messageTable.clientId,
      sessionId: messageTable.sessionId,
      role: messageTable.role,
      content: messageTable.content,
      toolUseId: messageTable.toolUseId,
      agentMeta: messageTable.agentMeta,
      agentKind: messageTable.agentKind,
      createdAt: messageTable.createdAt,
      rewindAt: messageTable.rewindAt,
      rowid: messageRowid,
    })
    .from(messageTable)
    .where(and(
      eq(messageTable.sessionId, sessionId),
      or(eq(messageTable.clientId, identifier), eq(messageTable.id, identifier)),
      isNull(messageTable.rewindAt),
      ...visibleConds,
    ))
    .limit(1);

  if (!anchor) return [];

  const before = await db
    .select({
      id: messageTable.id,
      clientId: messageTable.clientId,
      sessionId: messageTable.sessionId,
      role: messageTable.role,
      content: messageTable.content,
      toolUseId: messageTable.toolUseId,
      agentMeta: messageTable.agentMeta,
      agentKind: messageTable.agentKind,
      createdAt: messageTable.createdAt,
      rewindAt: messageTable.rewindAt,
      rowid: messageRowid,
    })
    .from(messageTable)
    .where(and(
      eq(messageTable.sessionId, sessionId),
      isNull(messageTable.rewindAt),
      ...visibleConds,
      or(
        lt(messageTable.createdAt, anchor.createdAt),
        and(eq(messageTable.createdAt, anchor.createdAt), lt(messageRowid, anchor.rowid)),
      ),
    ))
    .orderBy(desc(messageTable.createdAt), desc(messageRowid))
    .limit(radius);

  const after = await db
    .select({
      id: messageTable.id,
      clientId: messageTable.clientId,
      sessionId: messageTable.sessionId,
      role: messageTable.role,
      content: messageTable.content,
      toolUseId: messageTable.toolUseId,
      agentMeta: messageTable.agentMeta,
      agentKind: messageTable.agentKind,
      createdAt: messageTable.createdAt,
      rewindAt: messageTable.rewindAt,
      rowid: messageRowid,
    })
    .from(messageTable)
    .where(and(
      eq(messageTable.sessionId, sessionId),
      isNull(messageTable.rewindAt),
      ...visibleConds,
      or(
        gt(messageTable.createdAt, anchor.createdAt),
        and(eq(messageTable.createdAt, anchor.createdAt), gt(messageRowid, anchor.rowid)),
      ),
    ))
    .orderBy(asc(messageTable.createdAt), asc(messageRowid))
    .limit(radius);

  const combined = [...before.reverse(), anchor, ...after];
  return combined.map((row) => ({
    ...messageToCamel(row),
    rowid: row.rowid,
  }));
}
