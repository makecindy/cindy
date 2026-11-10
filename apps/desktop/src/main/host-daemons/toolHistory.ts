/**
 * host-daemons/toolHistory —— 归属追溯用的只读消息窗口查询。
 *
 * 只读 `tool_use` / `tool_result`：agent 真正执行过的命令与结果。用户聊天里提到
 * 某个名字不算「Cindy 装了它」，所以 assistant 正文、thinking 一概不参与判定。
 *
 * 查询走 `(created_at, id)` 索引的有界窗口（默认交给调用方传 ±5 分钟），不扫全表。
 */

import { and, asc, eq, gte, inArray, isNull, lte } from 'drizzle-orm';

import { getDbClient } from '../localDb/client/current';
import { messages, sessions } from '../localDb/schema';
import type { ToolMessageRow } from './attribution.js';

/** 单个窗口最多取多少行（超出时按时间先后截断，并回报 `truncated`）。 */
export const TOOL_MESSAGE_WINDOW_LIMIT = 300;

export interface ToolMessageWindow {
  rows: ToolMessageRow[];
  /**
   * 窗口内消息超过上限，只读到其中一部分。
   *
   * 匹配放在 JS 里做（`toLowerCase()` 才是完整的大小写折叠，SQLite 的 `lower()`
   * 只处理 ASCII，任务名里非 ASCII 大写字母会被错杀），所以必须把「没读全」和
   * 「读全了确实没有」分开报给调用方：前者不能当作「查无此人」写进长期负缓存。
   */
  truncated: boolean;
}

export async function readToolMessages(
  fromMs: number,
  toMs: number,
  limit = TOOL_MESSAGE_WINDOW_LIMIT,
): Promise<ToolMessageWindow> {
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
      ),
    )
    .orderBy(asc(messages.createdAt))
    // 多取一行只为判断是否被截断，不把它当证据。
    .limit(limit + 1);
  return {
    rows: rows.slice(0, limit).map((row) => ({
      sessionId: row.sessionId,
      title: row.title ?? null,
      content: row.content,
    })),
    truncated: rows.length > limit,
  };
}
