/**
 * 统一 Telegram 群消息池的本地全文检索核心。
 *
 * 本模块不注册 agent tool。每次查询都必须显式给出 provider + chatId + threadId，
 * MATCH 与中文 LIKE 兜底在 SQL 内使用完全相同的 lane 条件，调用方无法先全局搜索
 * 再事后过滤。跨 lane/命名空间权限由后续工具接线在此硬边界之上继续收紧。
 */

import { buildFtsMatch } from '../../localDb/chatHistorySearch.pure';
import { getDbClient } from '../../localDb/client/current';
import { createLogger } from '../../logger';

const log = createLogger('group-history-search');
const FTS_TABLE = 'hook_group_messages_fts';
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;
const QUERY_MAX_CHARS = 256;
const SNIPPET_TOKEN_RADIUS = 12;
const FALLBACK_SNIPPET_CHARS = 240;

export interface GroupHistorySearchLane {
  provider: string;
  chatId: string;
  /** topic/thread id；空串表示主群流。必填，禁止省略为“全 chat”。 */
  threadId: string;
}

export interface GroupHistorySearchHit {
  id: number;
  messageId: string;
  chatName: string | null;
  author: string;
  isBot: boolean;
  text: string;
  fileNames: string[];
  sentAt: number;
  snippet: string;
  score: number | null;
  source: 'fts' | 'like';
}

interface SearchRow {
  id: number;
  messageId: string;
  chatName: string | null;
  author: string;
  isBot: number;
  text: string;
  fileNames: string | null;
  sentAt: number;
  snippet: string;
  score: number | null;
}

function assertLane(lane: GroupHistorySearchLane): void {
  if (typeof lane.provider !== 'string' || !lane.provider.trim()) {
    throw new Error('group history provider is required');
  }
  if (typeof lane.chatId !== 'string' || !lane.chatId.trim()) {
    throw new Error('group history chatId is required');
  }
  if (typeof lane.threadId !== 'string') throw new Error('group history threadId is required');
}

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function escapeLikePattern(value: string): string {
  return value.replace(/[!%_]/g, (char) => `!${char}`);
}

function parseFileNames(value: string | null): string[] {
  if (value === null) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string') ? parsed : [];
  } catch {
    return [];
  }
}

function mapRows(
  rows: SearchRow[],
  source: GroupHistorySearchHit['source'],
): GroupHistorySearchHit[] {
  return rows.map((row) => ({
    id: row.id,
    messageId: row.messageId,
    chatName: row.chatName,
    author: row.author,
    isBot: row.isBot === 1,
    text: row.text,
    fileNames: parseFileNames(row.fileNames),
    sentAt: row.sentAt,
    snippet: row.snippet,
    score: row.score,
    source,
  }));
}

async function searchMatch(
  lane: GroupHistorySearchLane,
  match: string,
  limit: number,
): Promise<{ hits: GroupHistorySearchHit[]; available: boolean }> {
  const sql = `
    SELECT m.id AS id,
           m.message_id AS messageId,
           m.chat_name AS chatName,
           m.author AS author,
           m.is_bot AS isBot,
           m.text AS text,
           m.file_names AS fileNames,
           m.sent_at AS sentAt,
           snippet(${FTS_TABLE}, -1, '<mark>', '</mark>', '…', ${SNIPPET_TOKEN_RADIUS}) AS snippet,
           bm25(${FTS_TABLE}) AS score
      FROM ${FTS_TABLE}
      JOIN hook_group_messages m ON m.id = ${FTS_TABLE}.rowid
     WHERE ${FTS_TABLE} MATCH ?
       AND m.provider = ?
       AND m.chat_id = ?
       AND m.thread_id = ?
     ORDER BY score, m.sent_at DESC, m.id DESC
     LIMIT ?`;
  try {
    const rows = await getDbClient().query<SearchRow>(sql, [
      match,
      lane.provider,
      lane.chatId,
      lane.threadId,
      limit,
    ]);
    return { hits: mapRows(rows, 'fts'), available: true };
  } catch (error) {
    log.warn(JSON.stringify({ event: 'groupHistorySearch.ftsFailed', error: errorKind(error) }));
    return { hits: [], available: false };
  }
}

async function searchLike(
  lane: GroupHistorySearchLane,
  query: string,
  limit: number,
  excludeMatch: string | null,
): Promise<GroupHistorySearchHit[]> {
  const pattern = `%${escapeLikePattern(query)}%`;
  const exclusion =
    excludeMatch === null
      ? ''
      : `AND m.id NOT IN (
           SELECT ${FTS_TABLE}.rowid
             FROM ${FTS_TABLE}
             JOIN hook_group_messages matched ON matched.id = ${FTS_TABLE}.rowid
            WHERE ${FTS_TABLE} MATCH ?
              AND matched.provider = ?
              AND matched.chat_id = ?
              AND matched.thread_id = ?
         )`;
  const sql = `
    SELECT m.id AS id,
           m.message_id AS messageId,
           m.chat_name AS chatName,
           m.author AS author,
           m.is_bot AS isBot,
           m.text AS text,
           m.file_names AS fileNames,
           m.sent_at AS sentAt,
           substr(m.text, 1, ${FALLBACK_SNIPPET_CHARS}) AS snippet,
           NULL AS score
      FROM hook_group_messages m
     WHERE m.provider = ?
       AND m.chat_id = ?
       AND m.thread_id = ?
       AND (m.text LIKE ? ESCAPE '!'
         OR m.author LIKE ? ESCAPE '!'
         OR coalesce(m.file_names, '') LIKE ? ESCAPE '!')
       ${exclusion}
     ORDER BY m.sent_at DESC, m.id DESC
     LIMIT ?`;
  const params: unknown[] = [lane.provider, lane.chatId, lane.threadId, pattern, pattern, pattern];
  if (excludeMatch !== null) params.push(excludeMatch, lane.provider, lane.chatId, lane.threadId);
  params.push(limit);
  const rows = await getDbClient().query<SearchRow>(sql, params);
  return mapRows(rows, 'like');
}

/**
 * 当前 lane 内检索群历史。CJK 连续文本由 unicode61 MATCH 尽力召回，再用仓内
 * Memory/Contacts 同款 LIKE 子串兜底；MATCH 满额时为 true LIKE-only 命中预留一席。
 */
export async function searchGroupHistory(args: {
  lane: GroupHistorySearchLane;
  query: string;
  limit?: number;
}): Promise<GroupHistorySearchHit[]> {
  assertLane(args.lane);
  const query = args.query.trim().slice(0, QUERY_MAX_CHARS);
  if (!query) return [];
  const limit = Math.max(1, Math.min(args.limit ?? DEFAULT_LIMIT, MAX_LIMIT));
  const match = buildFtsMatch(query);
  const matched =
    match === null ? { hits: [], available: true } : await searchMatch(args.lane, match, limit);
  const fallback = await searchLike(
    args.lane,
    query,
    limit,
    match !== null && matched.available ? match : null,
  );
  if (limit > 1 && matched.hits.length >= limit && fallback.length > 0) {
    return [...matched.hits.slice(0, limit - 1), fallback[0]];
  }
  return [...matched.hits, ...fallback].slice(0, limit);
}
