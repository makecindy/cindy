import { and, count, desc, eq, gte, inArray, isNull, ne, or } from 'drizzle-orm';

import type {
  ConversationSearchAgentFilter,
  ConversationSearchContentHit,
  ConversationSearchFilters,
  ConversationSearchLastActivityFilter,
  ConversationSearchRequest,
  ConversationSearchResponse,
  ConversationSearchSessionSummary,
  ConversationSearchSessionStatus,
  ConversationSearchSortBy,
  ConversationSearchStatusFilter,
} from '../../shared/conversationSearch.js';
import { conversationSearchTitle } from '../../shared/conversationSearch.js';
import { DESKTOP_VISIBLE_SESSION_SOURCES } from '../../shared/sessionSource.js';
import { normalizeWorkingDirForGrouping } from '../../shared/workingDir.js';
import { getDbClient } from './client/current.js';
import { messages, sessions } from './schema.js';
import { searchChatHistoryHybrid } from './chatHistorySearch.js';
import { normalizeDbAgentKind } from '../../shared/agentKindConversion.js';
import { visibleTextMatchesMessagesFtsQuery } from './chatHistorySearch.pure.js';
import {
  collectContentHitsUntilUniqueSessions,
  fuzzyTitleMatch,
  mergeConversationSearchResults,
  normalizeConversationContentPreview,
  visibleMessageTextForConversationSearch,
} from './conversationSearch.pure.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const CONTENT_PAGE_LIMIT = 50;
const CONTENT_MAX_PAGES = 3;
const CONTENT_POOL_LIMIT = CONTENT_PAGE_LIMIT * CONTENT_MAX_PAGES;
const SEARCH_ROLES = ['user', 'assistant', 'ask_user', 'plan_review'] as const;
const ACTIVE_STATUSES = ['active'] as const;
const VISIBLE_STATUSES = ['active', 'archived'] as const;
const LAST_ACTIVITY_DAY_COUNTS: Record<
  Exclude<ConversationSearchLastActivityFilter, 'all'>,
  number
> = {
  '1d': 1,
  '3d': 3,
  '7d': 7,
  '30d': 30,
};
const DAY_MS = 24 * 60 * 60 * 1000;

type SessionRow = typeof sessions.$inferSelect;

export async function searchConversations(
  request: ConversationSearchRequest,
): Promise<ConversationSearchResponse> {
  const query = request.query.trim();
  if (!query) {
    return {
      query: '',
      results: [],
      vectorUsed: false,
      vectorSkipReason: null,
      poolCapped: false,
    };
  }

  const limit = clampLimit(request.limit);
  const filters = normalizeFilters(request);
  const sortBy = normalizeSortBy(request.sortBy);
  const skipVector = request.semanticMode === 'keyword';
  if (filters.sessionIds && filters.sessionIds.length === 0) {
    return {
      query,
      results: [],
      vectorUsed: false,
      vectorSkipReason: null,
      poolCapped: false,
    };
  }
  const sessionRows = applyWorkingDirFilter(await listSearchableSessions(filters), filters.workingDirs);
  if (sessionRows.length === 0) {
    return {
      query,
      results: [],
      vectorUsed: false,
      vectorSkipReason: null,
      poolCapped: false,
    };
  }
  const sessionSummaries = new Map(
    sessionRows.map((row) => [row.id, sessionSummaryFromRow(row, 0)]),
  );
  const allowedSessionIds = sessionRows.map((row) => row.id);
  const activityCutoff = cutoffForLastActivity(filters.lastActivity);

  const titleMatches = sessionRows
    .map((row, index) => {
      // 匹配与命中下标都按**界面上显示的**标题算:未起名会话行上显示的是本地化兜底
      // 文案,拿原始哨兵匹配会两头错位 —— 搜可见文案一条都搜不到,搜 "New Maker" 反而
      // 命中一堆不显示这个词的行,高亮下标也会落在别的字上(PR #1031 review P1)。
      // renderer 渲染时调同一个 conversationSearchTitle,两端逐字一致。
      const match = fuzzyTitleMatch(conversationSearchTitle(row.title, request.unnamedLabel), query);
      if (!match) return null;
      const session = sessionSummaries.get(row.id);
      if (!session) return null;
      return { session, score: match.score, indices: match.indices, index };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((a, b) => b.score - a.score || activityMs(b.session) - activityMs(a.session) || a.index - b.index);

  const content = await searchContentUntilUniqueSessions({
    query,
    limit,
    allowedSessionIds,
    filters,
    activityCutoff,
    skipVector,
  });

  const contentMessageIds = content.hits.map((hit) => hit.messageId);
  const clientIdByMessageId = await fetchClientIds(contentMessageIds);
  const contentHits: Array<{
    session: ConversationSearchSessionSummary;
    hit: ConversationSearchContentHit;
  }> = [];

  for (const hit of content.hits) {
    const session = sessionSummaries.get(hit.sessionId);
    if (!session) continue;
    const messageClientId = clientIdByMessageId.get(hit.messageId);
    if (!messageClientId) continue;
    const hitContext = hit.context.find((item) => item.isHit) ?? hit.context[0] ?? null;
    const preview = normalizeConversationContentPreview(hit.role, hitContext?.content ?? '', query);
    // 可见文本对 query 字面不匹配时，仍可能是 FTS 命中（「边，界」按字相邻）。
    // 不要只靠 keywordRanges 清掉 ftsRank，否则这类命中会被整条丢弃。
    // 但附件文件名、内部 citation 等隐藏字段命中不能当可见结果：
    // preview 非空只说明消息有正文，不能证明 MATCH 落在可见字上。
    const visibleText = visibleMessageTextForConversationSearch(
      hit.role,
      hitContext?.content ?? '',
    );
    const ftsRank =
      preview.keywordMatchedVisibleText || visibleTextMatchesMessagesFtsQuery(visibleText, query)
        ? hit.ftsRank
        : null;
    if (ftsRank === null && hit.vectorRank === null) continue;
    contentHits.push({
      session,
      hit: {
        messageId: hit.messageId,
        messageClientId,
        role: hit.role as ConversationSearchContentHit['role'],
        createdAt: new Date(hit.createdAt).toISOString(),
        snippet: preview.snippet,
        preview: preview.preview,
        score: hit.score,
        ftsRank,
        vectorRank: hit.vectorRank,
      },
    });
  }

  const results = mergeConversationSearchResults({ titleMatches, contentHits, limit, sortBy });

  return {
    query,
    results: await attachMessageCounts(results),
    vectorUsed: content.vectorUsed,
    vectorSkipReason: content.vectorSkipReason,
    poolCapped: content.poolCapped,
  };
}

async function searchContentUntilUniqueSessions({
  query,
  limit,
  allowedSessionIds,
  filters,
  activityCutoff,
  skipVector,
}: {
  query: string;
  limit: number;
  allowedSessionIds: string[];
  filters: NormalizedConversationSearchFilters;
  activityCutoff: number | null;
  skipVector: boolean;
}) {
  const targetUniqueSessions = Math.min(limit * 2, allowedSessionIds.length);
  const queryEmbeddingCache = new Map<string, number[]>();

  return collectContentHitsUntilUniqueSessions({
    maxPages: CONTENT_MAX_PAGES,
    pageLimit: CONTENT_PAGE_LIMIT,
    targetUniqueSessions,
    fetchPage: ({ limit: pageLimit, offset }) => searchChatHistoryHybrid({
      query,
      sessionIds: allowedSessionIds,
      workdir: null,
      fromMs: null,
      toMs: null,
      agentKind: filters.agentKind === 'all' ? null : filters.agentKind,
      roles: [...SEARCH_ROLES],
      contextRadius: 0,
      limit: pageLimit,
      offset,
      sessionSources: DESKTOP_VISIBLE_SESSION_SOURCES,
      sessionStatuses: sessionStatusesForFilter(filters.status),
      excludeCleared: true,
      sessionActivityFromMs: activityCutoff,
      skipVector,
      ftsPoolLimit: CONTENT_POOL_LIMIT + 1,
      vectorPoolLimit: CONTENT_POOL_LIMIT + 1,
      fusePoolLimit: CONTENT_POOL_LIMIT,
      queryEmbeddingCache,
    }),
  });
}

interface NormalizedConversationSearchFilters {
  status: ConversationSearchStatusFilter;
  agentKind: ConversationSearchAgentFilter;
  lastActivity: ConversationSearchLastActivityFilter;
  sessionIds: string[] | null;
  workingDirs: string[] | null;
}

function normalizeFilters(request: ConversationSearchRequest): NormalizedConversationSearchFilters {
  const input = request.filters ?? {};
  const status = normalizeStatusFilter(input.status, request.includeArchived);
  const agentKind = normalizeAgentFilter(input.agentKind);
  const lastActivity = normalizeLastActivity(input.lastActivity);
  const sessionIds = normalizeSessionIds(input.sessionIds);
  const workingDirs = normalizeWorkingDirs(input.workingDirs);
  return { status, agentKind, lastActivity, sessionIds, workingDirs };
}

function normalizeStatusFilter(
  value: ConversationSearchFilters['status'],
  includeArchived: boolean | undefined,
): ConversationSearchStatusFilter {
  if (value === 'active' || value === 'archived' || value === 'all') return value;
  if (includeArchived === true) return 'all';
  if (includeArchived === false) return 'active';
  return 'all';
}

function normalizeAgentFilter(value: ConversationSearchFilters['agentKind']): ConversationSearchAgentFilter {
  return value === 'cc' || value === 'codex' || value === 'pi' ? value : 'all';
}

function normalizeLastActivity(
  value: ConversationSearchFilters['lastActivity'],
): ConversationSearchLastActivityFilter {
  return value === '1d' || value === '3d' || value === '7d' || value === '30d'
    ? value
    : 'all';
}

function normalizeSessionIds(value: ConversationSearchFilters['sessionIds']): string[] | null {
  if (value == null) return null;
  if (!Array.isArray(value)) return null;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function normalizeWorkingDirs(value: ConversationSearchFilters['workingDirs']): string[] | null {
  if (value == null || !Array.isArray(value)) return null;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const normalized = normalizeWorkingDirForGrouping(item);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out.length > 0 ? out : null;
}

function applyWorkingDirFilter(
  rows: SessionRow[],
  workingDirs: string[] | null,
): SessionRow[] {
  if (workingDirs == null) return rows;
  const allowed = new Set(workingDirs);
  return rows.filter((row) => {
    const key = normalizeWorkingDirForGrouping(row.workingDir);
    return key != null && allowed.has(key);
  });
}

function normalizeSortBy(value: ConversationSearchSortBy | undefined): ConversationSearchSortBy {
  return value === 'activityDesc' || value === 'activityAsc' ? value : 'relevance';
}

async function listSearchableSessions(filters: NormalizedConversationSearchFilters): Promise<SessionRow[]> {
  const db = getDbClient().drizzle;
  const statusCond = statusCondition(filters.status);
  const agentCond = filters.agentKind === 'all' ? undefined : eq(sessions.agentKind, filters.agentKind);
  const sessionIdsCond = filters.sessionIds ? inArray(sessions.id, filters.sessionIds) : undefined;
  const workerCond = or(isNull(sessions.orcaRole), ne(sessions.orcaRole, 'worker'));
  const activityCutoff = cutoffForLastActivity(filters.lastActivity);
  // 兼容存量 DB 行：旧版 touchUserSendInDb 只写 user_send_at 不 bump updated_at，
  // 侧栏排序用 max(userSendAt, updatedAt)，这里也同步用 OR 避免漏掉这些行。
  const activityCond = activityCutoff === null
    ? undefined
    : or(gte(sessions.updatedAt, activityCutoff), gte(sessions.userSendAt, activityCutoff));
  return db
    .select()
    .from(sessions)
    .where(and(
      inArray(sessions.source, DESKTOP_VISIBLE_SESSION_SOURCES),
      statusCond,
      agentCond,
      sessionIdsCond,
      workerCond,
      activityCond,
    ))
    .orderBy(desc(sessions.updatedAt));
}

function statusCondition(status: ConversationSearchStatusFilter) {
  if (status === 'active') return eq(sessions.status, 'active');
  if (status === 'archived') return eq(sessions.status, 'archived');
  return ne(sessions.status, 'deleted');
}

function sessionStatusesForFilter(
  status: ConversationSearchStatusFilter,
): readonly ConversationSearchSessionStatus[] {
  if (status === 'active') return ACTIVE_STATUSES;
  if (status === 'archived') return ['archived'] as const;
  return VISIBLE_STATUSES;
}

function cutoffForLastActivity(lastActivity: ConversationSearchLastActivityFilter): number | null {
  if (lastActivity === 'all') return null;
  return Date.now() - LAST_ACTIVITY_DAY_COUNTS[lastActivity] * DAY_MS;
}

async function fetchMessageCounts(sessionIds: string[]): Promise<Map<string, number>> {
  if (sessionIds.length === 0) return new Map();
  const rows = await getDbClient().drizzle
    .select({
      sessionId: messages.sessionId,
      cnt: count(messages.id),
    })
    .from(messages)
    .where(and(inArray(messages.sessionId, sessionIds), isNull(messages.rewindAt)))
    .groupBy(messages.sessionId);
  return new Map(rows.map((row) => [row.sessionId, Number(row.cnt)]));
}

async function fetchClientIds(messageIds: string[]): Promise<Map<string, string>> {
  if (messageIds.length === 0) return new Map();
  const rows = await getDbClient().drizzle
    .select({ id: messages.id, clientId: messages.clientId })
    .from(messages)
    .where(inArray(messages.id, messageIds));
  return new Map(rows.map((row) => [row.id, row.clientId]));
}

function sessionSummaryFromRow(
  row: SessionRow,
  messageCount: number,
): ConversationSearchSessionSummary {
  return {
    id: row.id,
    title: row.title,
    workingDir: row.workingDir,
    workspaceKind: row.workspaceKind,
    agentKind: normalizeDbAgentKind(row.agentKind),
    status: row.status,
    source: row.source,
    orcaRole: row.orcaRole,
    parentSessionId: row.parentSessionId,
    userSendAt: row.userSendAt === null ? null : new Date(row.userSendAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
    createdAt: new Date(row.createdAt).toISOString(),
    _count: { messages: messageCount },
  };
}

async function attachMessageCounts<T extends { session: ConversationSearchSessionSummary }>(
  results: T[],
): Promise<T[]> {
  const countMap = await fetchMessageCounts(results.map((item) => item.session.id));
  return results.map((item) => ({
    ...item,
    session: {
      ...item.session,
      _count: { messages: countMap.get(item.session.id) ?? 0 },
    },
  }));
}

function activityMs(session: ConversationSearchSessionSummary): number {
  const value = session.userSendAt ?? session.updatedAt;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

function clampLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(Math.floor(value), MAX_LIMIT));
}
