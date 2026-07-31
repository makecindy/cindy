/**
 * 会话尾部终态探针。
 *
 * 错误行有意不进入引用消息列表:其结构化正文可能含 provider 细节或回显的请求
 * 数据。这里只产出非敏感的安全标记,供会话引用(本地与 device-link 远程)解释
 * 「最后一条 assistant 文本为何不完整」。本地解析与远程被控端 handler 共用同一
 * 判定,避免两端语义分叉。
 */
import { and, desc, eq, gt, isNull, sql, type SQL } from 'drizzle-orm';
import { getDbClient } from './client/current';
import { messages } from './schema';

const messageRowid = sql<number>`"messages"."rowid"`;

export interface SessionTerminalHint {
  status: 'error';
  createdAt?: number;
}

/**
 * Return only a non-sensitive terminal hint for a session snapshot.
 *
 * The marker is enough to explain why the last assistant text can be
 * incomplete; the persisted error body never leaves this layer.
 */
export async function readLatestSessionTerminal(
  sessionId: string,
  clearedAt: number | null,
): Promise<SessionTerminalHint | undefined> {
  const db = getDbClient().drizzle;
  const where: SQL<unknown>[] = [
    eq(messages.sessionId, sessionId),
    isNull(messages.rewindAt),
  ];
  if (clearedAt !== null) where.push(gt(messages.createdAt, clearedAt));
  const [latest] = await db
    .select({ role: messages.role, content: messages.content, createdAt: messages.createdAt })
    .from(messages)
    .where(and(...where))
    .orderBy(desc(messages.createdAt), desc(messageRowid))
    .limit(1);
  if (latest?.role !== 'error') return undefined;
  // An ignored error remains in the database for audit/history, but should no
  // longer make a fresh quote look like an active failed turn.
  if (typeof latest.content === 'string') {
    try {
      const parsed = JSON.parse(latest.content) as unknown;
      if (
        parsed &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        (parsed as Record<string, unknown>).dismissed === true
      ) {
        return undefined;
      }
    } catch {
      // Legacy non-JSON error content is treated as an undismissed error.
    }
  }
  return {
    status: 'error',
    ...(Number.isFinite(latest.createdAt) ? { createdAt: latest.createdAt } : {}),
  };
}
