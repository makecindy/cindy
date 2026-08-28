/**
 * apps/desktop/src/main/maker-host/session-search.ts
 *
 * Desktop 端 messages FTS5 搜索能力实现, 通过 cindy_memory MCP 的 session_search tool
 * 暴露给 LLM。数据源是 0017_add_messages_fts 创建的 messages_fts 虚拟表 (跟 messages
 * 表通过触发器同步; 0066 起仅索引 user / assistant / ask_user / plan_review 四类
 * role, tool_result / tool_use / thinking 等工具输出不进索引)。
 *
 * 跟 maker-core 的关系:
 *  - maker-core 完全不知道 messages 表存在 (那是 chat history 持久化, 不属于 memory 范畴)
 *  - host 在装配 cindy_memory provider 时把 searchSessions 函数注入, MCP server
 *    的 session_search tool 调用时 dispatch 到这里
 *
 * 失败原则:
 *  - DB 没就绪 (logout / 切账号 reset window) → 抛 Error, MCP server 翻成 INTERNAL
 *  - FTS5 query 语法错 → 静默返空, 让 LLM 改写 query 重试 (跟 memory_search 同策略)
 */

import type { SessionSearchOptions, SessionSearchHit, SessionSearchFn } from '@cindy/mcps';

import { getDbClient } from '../localDb/client/current.js';
import {
  buildMessagesFtsMatch,
  extractMessagesFtsTokens,
} from '../localDb/chatHistorySearch.pure.js';
import { buildSnippetFromContent, SNIPPET_SOURCE_MAX_CHARS } from '../localDb/cjkSeg.js';
import { createLogger } from '../logger.js';

const log = createLogger('session-search');
const TABLE = 'messages_fts';
const DEFAULT_LIMIT = 10;

export const searchSessionsFn: SessionSearchFn = async (
  query: string,
  opts: SessionSearchOptions = {},
): Promise<SessionSearchHit[]> => {
  if (!query || query.trim().length === 0) return [];
  const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_LIMIT, 50));
  const escapedQuery = buildMessagesFtsMatch(query, 'AND');
  if (!escapedQuery) return [];

  try {
    getDbClient();
  } catch (e) {
    log.warn('session_search: DbClient not ready', { error: String(e) });
    throw new Error('DbClient not ready');
  }

  // snippet 从原文 m.content 重建，不用索引侧文本（见 buildSnippetFromContent 注释）。
  const queryTokens = extractMessagesFtsTokens(query);
  let sql = `
    SELECT m.id AS messageId,
           m.session_id AS sessionId,
           m.role AS role,
           m.created_at AS ts,
           substr(m.content, 1, ?) AS content,
           bm25(${TABLE}) AS score
    FROM ${TABLE}
    JOIN messages m ON m.id = ${TABLE}.message_id
    WHERE ${TABLE} MATCH ?
      AND m.rewind_at IS NULL
  `;
  const params: unknown[] = [SNIPPET_SOURCE_MAX_CHARS, escapedQuery];
  if (opts.sessionId) {
    sql += ` AND m.session_id = ?`;
    params.push(opts.sessionId);
  }
  if (opts.role) {
    sql += ` AND m.role = ?`;
    params.push(opts.role);
  }
  sql += ` ORDER BY score LIMIT ?`;
  params.push(limit);

  try {
    const rows = await getDbClient().query<{
      messageId: string;
      sessionId: string;
      role: string;
      ts: number;
      content: string;
      score: number;
    }>(sql, params);
    return rows.map((r) => ({
      messageId: r.messageId,
      sessionId: r.sessionId,
      role: r.role,
      ts: r.ts,
      snippet: buildSnippetFromContent(r.content, queryTokens),
      score: r.score,
    }));
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes('fts5') || msg.includes('syntax error')) return [];
    log.warn('session_search: query failed', { error: msg });
    throw e;
  }
};
