/**
 * session_search 的检索核心（messages_fts），不依赖 Electron：桌面（session-search.ts）与
 * Node Host（apps/host/src/agent/memory-mcp-ports.ts）调同一份。设备号由调用方传入。
 * 数据源与失败原则见 session-search.ts 的文件注释。
 */

import type { SessionSearchOptions, SessionSearchHit } from '@cindy/mcps';

import { buildSessionDeepLink } from '../sessionDeepLink.js';
import { getDbClient } from '../localDb/client/current.js';
import {
  buildMessagesFtsMatch,
  extractMessagesFtsTokens,
} from '../localDb/chatHistorySearch.pure.js';
import { buildSnippetFromContent, SNIPPET_SOURCE_MAX_CHARS } from '../localDb/cjkSeg.js';
import { createLogger } from '../logger.js';
import { resolveBotHistoryScope } from '../localDb/botHistoryScope.js';

const log = createLogger('session-search');
const TABLE = 'messages_fts';
const DEFAULT_LIMIT = 10;

/**
 * `readDeviceId`：本机的设备号，拼进结果里的任务链接（桌面读登录状态，Host 读它自己的设备号）。
 * `botAccountWide`：宿主已判定这是伙伴主任务里主人本人（或主人事先安排）的一轮，可以搜全部任务。
 * 其余伙伴调用只搜这个伙伴自己的会话与它开的后台任务。
 */
export async function searchSessionsWithBotScopeCore(
  query: string,
  opts: SessionSearchOptions,
  scopeOptions: { botAccountWide: boolean; readDeviceId: () => string },
): Promise<SessionSearchHit[]> {
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

  const callerScope = await resolveBotHistoryScope(
    opts.callerSessionId,
    opts.callerMemoryScopeKey,
  );
  if (callerScope.kind === 'denied') return [];
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
  if (callerScope.kind === 'bot' && !scopeOptions.botAccountWide) {
    // Bot ownership is resolved from the current runtime Session. The model can
    // optionally narrow within that set, but cannot widen it by supplying an
    // arbitrary sessionId. Background tasks the Bot started are its own work too.
    sql += ` AND m.session_id IN (
      SELECT scoped.session_id
        FROM bot_session_links scoped
       WHERE scoped.bot_id = ?
      UNION
      SELECT delegated.child_session_id
        FROM bot_delegations delegated
       WHERE delegated.requesting_bot_id = ?
         AND delegated.child_session_id IS NOT NULL
    )`;
    params.push(callerScope.botId, callerScope.botId);
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
    const deviceId = scopeOptions.readDeviceId();
    return rows.map((r) => ({
      messageId: r.messageId,
      sessionId: r.sessionId,
      sessionUrl: buildSessionDeepLink(r.sessionId, { deviceId }),
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
}
