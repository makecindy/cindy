/**
 * host-daemons/toolHistory —— 归属追溯用的只读消息窗口查询。
 *
 * 只读 `tool_use` / `tool_result`：agent 真正执行过的命令与结果。用户聊天里提到
 * 某个名字不算「Cindy 装了它」，所以 assistant 正文、thinking 一概不参与判定。
 *
 * 查询走 `(created_at, id)` 索引的有界窗口（默认交给调用方传 ±5 分钟），不扫全表。
 */

import { and, asc, eq, gte, inArray, lte } from 'drizzle-orm';

import { getDbClient } from '../localDb/client/current';
import { messages, sessions } from '../localDb/schema';
import type { ToolMessageRow } from './attribution.js';

/** 单个窗口最多取多少行。超出时按时间先后截断（命令通常在窗口前段）。 */
export const TOOL_MESSAGE_WINDOW_LIMIT = 300;

export async function readToolMessages(
  fromMs: number,
  toMs: number,
  limit = TOOL_MESSAGE_WINDOW_LIMIT,
): Promise<ToolMessageRow[]> {
  const db = getDbClient().drizzle;
  const rows = await db
    .select({
      sessionId: messages.sessionId,
      title: sessions.title,
      content: messages.content,
    })
    .from(messages)
    .leftJoin(sessions, eq(messages.sessionId, sessions.id))
    .where(
      and(
        gte(messages.createdAt, fromMs),
        lte(messages.createdAt, toMs),
        inArray(messages.role, ['tool_use', 'tool_result']),
      ),
    )
    .orderBy(asc(messages.createdAt))
    .limit(limit);
  return rows.map((row) => ({
    sessionId: row.sessionId,
    title: row.title ?? null,
    content: row.content,
  }));
}
