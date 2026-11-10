/**
 * host-daemons/toolHistory —— 归属追溯用的只读消息窗口查询。
 *
 * 只读 `tool_use` / `tool_result`：agent 真正执行过的命令与结果。用户聊天里提到
 * 某个名字不算「Cindy 装了它」，所以 assistant 正文、thinking 一概不参与判定。
 *
 * 查询走 `(created_at, id)` 索引的有界窗口（默认交给调用方传 ±5 分钟），不扫全表。
 */

import { and, asc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';

import { getDbClient } from '../localDb/client/current';
import { messages, sessions } from '../localDb/schema';
import type { ToolMessageRow } from './attribution.js';

/**
 * 单个窗口最多取多少行。
 *
 * 任务名在 SQL 里就先过滤掉，截断只会砍掉「同一个任务名」的冗余命中，不会把
 * 创建任务的那次调用挤出窗口 —— 否则命中被截断后会被当成「查无归属」写进长期
 * 负缓存，用户建的任务从此不再出现在清单里。
 */
export const TOOL_MESSAGE_WINDOW_LIMIT = 300;

export async function readToolMessages(
  needle: string,
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
        // 只认能确认在本机执行的记录：SSH 远端会话的工具调用也会落进同一张消息表，
        // 远端消息提到同名任务时会被误当成本机归属证据（进而授权停止/删除无关的本机任务）。
        isNull(sessions.remoteHostId),
        // 先按任务名过滤再截断：截断不能影响「这条窗口里到底有没有提到它」。
        sql`instr(lower(${messages.content}), lower(${needle})) > 0`,
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
