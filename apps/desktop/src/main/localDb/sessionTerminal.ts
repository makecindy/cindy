/**
 * 会话尾部终态探针。
 *
 * 错误行有意不进入引用消息列表:其结构化正文可能含 provider 细节或回显的请求
 * 数据。这里只产出非敏感的安全标记,供会话引用(本地与 device-link 远程)解释
 * 「最后一条 assistant 文本为何不完整」。本地解析与远程被控端 handler 共用同一
 * 判定,避免两端语义分叉。
 */
import { sql } from 'drizzle-orm';
import type { DbClient } from './client/DbClient';
import { getDbClient } from './client/current';
import { messages } from './schema';

export interface SessionTerminalHint {
  status: 'error';
  createdAt?: number;
}

/** Each requested ID carries the clear boundary from the caller's session snapshot. */
export async function readLatestSessionTerminals(
  db: DbClient['drizzle'],
  boundaries: ReadonlyArray<readonly [sessionId: string, clearedAt: number | null]>,
): Promise<Map<string, SessionTerminalHint>> {
  const terminals = new Map<string, SessionTerminalHint>();
  if (boundaries.length === 0) return terminals;
  // One bound parameter also accommodates the workers of all requested leads.
  const requested = sql`json_each(${JSON.stringify(Object.fromEntries(boundaries))}) AS requested`;
  // JSON.parse used the last top-level dismissed field when legacy error JSON contained duplicate keys.
  const rows = await db.select({ sessionId: messages.sessionId, createdAt: messages.createdAt })
    .from(requested)
    .innerJoin(messages, sql`messages.rowid = (
      SELECT tail.rowid FROM messages tail
      WHERE tail.session_id = requested.key AND tail.rewind_at IS NULL
      ORDER BY tail.created_at DESC, tail.rowid DESC LIMIT 1
    )`)
    .where(sql`(requested.value IS NULL OR ${messages.createdAt} > requested.value)
      AND CASE WHEN ${messages.role} IS NOT 'error' THEN 0
        WHEN typeof(${messages.content}) = 'text' AND json_valid(${messages.content}) THEN (
          SELECT meta.type FROM json_each(${messages.content}) AS meta
          WHERE meta.key = 'dismissed' ORDER BY meta.id DESC LIMIT 1
        ) IS NOT 'true'
        ELSE 1 END`);
  for (const { sessionId, createdAt } of rows) {
    terminals.set(sessionId, { status: 'error', ...(Number.isFinite(createdAt) ? { createdAt } : {}) });
  }
  return terminals;
}

export async function readLatestSessionTerminal(
  sessionId: string,
  clearedAt: number | null,
): Promise<SessionTerminalHint | undefined> {
  const terminals = await readLatestSessionTerminals(getDbClient().drizzle, [[sessionId, clearedAt]]);
  return terminals.get(sessionId);
}
