import { projectDraftSessionTitle } from './sessionTitle.js';
import { collapseWorktreeDirForGrouping } from './worktreePaths.js';

/**
 * 任务搜索的跨端契约与纯合并函数。
 *
 * 请求 / 响应形状对齐桌面 `apps/desktop/src/shared/conversationSearch.ts`
 * 与 device-link `local-db:conversations:search` 隧道。合并、打标、目录过滤
 * 对齐桌面 `conversationSearchFanout.ts` 的可移植子集。
 *
 * 不包含桌面本机 SQLite、hybrid / 向量搜索、机器切换栏 origin 解析。
 */

export type ConversationSearchAgentKind = 'cc' | 'codex' | 'pi';
export type ConversationSearchWorkspaceKind = 'project' | 'dialogue';
export type ConversationSearchSessionStatus = 'active' | 'archived' | 'deleted';
export type ConversationSearchOrcaRole = 'lead' | 'worker';
export type ConversationSearchMessageRole =
  | 'user'
  | 'assistant'
  | 'tool_use'
  | 'tool_result'
  | 'ask_user'
  | 'plan_review'
  | 'thinking';

export interface ConversationSearchRequest {
  query: string;
  limit?: number;
  sortBy?: ConversationSearchSortBy;
  semanticMode?: ConversationSearchSemanticMode;
  filters?: ConversationSearchFilters;
  includeArchived?: boolean;
  unnamedLabel?: string;
}

export type ConversationSearchSortBy = 'relevance' | 'activityDesc' | 'activityAsc';
export type ConversationSearchSemanticMode = 'hybrid' | 'keyword';
export type ConversationSearchStatusFilter = 'active' | 'archived' | 'all';
export type ConversationSearchAgentFilter = 'all' | ConversationSearchAgentKind;
export type ConversationSearchLastActivityFilter = 'all' | '1d' | '3d' | '7d' | '30d';

export interface ConversationSearchFilters {
  status?: ConversationSearchStatusFilter;
  agentKind?: ConversationSearchAgentFilter;
  lastActivity?: ConversationSearchLastActivityFilter;
  sessionIds?: string[] | null;
  workingDirs?: string[] | null;
}

export type ConversationSearchMatchKind = 'title' | 'content' | 'both';

export interface ConversationSearchSessionSummary {
  id: string;
  title: string;
  workingDir: string | null;
  workspaceKind: ConversationSearchWorkspaceKind;
  agentKind: ConversationSearchAgentKind;
  status: ConversationSearchSessionStatus;
  source?: string | null;
  orcaRole?: ConversationSearchOrcaRole | null;
  parentSessionId?: string | null;
  userSendAt: string | null;
  updatedAt: string;
  createdAt: string;
  _count: { messages: number };
  deviceLinkDeviceId?: string | null;
  deviceLinkDeviceName?: string | null;
}

export interface ConversationSearchContentHit {
  messageId: string;
  messageClientId: string;
  role: ConversationSearchMessageRole;
  createdAt: string;
  snippet: string | null;
  preview: string;
  score: number;
  ftsRank: number | null;
  vectorRank: number | null;
}

export interface ConversationSearchResultItem {
  session: ConversationSearchSessionSummary;
  matchKind: ConversationSearchMatchKind;
  titleMatchIndices: number[];
  titleScore: number | null;
  contentHit: ConversationSearchContentHit | null;
  contentHits: ConversationSearchContentHit[];
  rankScore: number;
}

export function conversationSearchTitle(title: string, unnamedLabel?: string | null): string {
  return projectDraftSessionTitle(title, unnamedLabel);
}

export interface ConversationSearchResponse {
  query: string;
  results: ConversationSearchResultItem[];
  vectorUsed: boolean;
  vectorSkipReason: string | null;
  poolCapped: boolean;
  remoteResults?: ConversationSearchResultItem[];
}

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

export function emptyConversationSearchResponse(query = ''): ConversationSearchResponse {
  return {
    query,
    results: [],
    vectorUsed: false,
    vectorSkipReason: null,
    poolCapped: false,
  };
}

export function stampRemoteSearchResponse(
  response: ConversationSearchResponse,
  device: { deviceId: string; deviceName?: string | null },
): ConversationSearchResponse {
  const results = Array.isArray(response?.results) ? response.results : [];
  return {
    query: response?.query ?? '',
    vectorUsed: response?.vectorUsed === true,
    vectorSkipReason: response?.vectorSkipReason ?? null,
    poolCapped: response?.poolCapped === true,
    results: results.map((item) => ({
      ...item,
      session: {
        ...item.session,
        deviceLinkDeviceId: device.deviceId,
        deviceLinkDeviceName: device.deviceName ?? item.session.deviceLinkDeviceName ?? null,
      },
    })),
  };
}

export function conversationSearchResultKey(item: ConversationSearchResultItem): string {
  return `${item.session.deviceLinkDeviceId ?? 'local'}:${item.session.id}`;
}

export function remoteResultsFromFanoutPages(
  pages: readonly ConversationSearchResponse[],
): ConversationSearchResultItem[] {
  const byKey = new Map<string, ConversationSearchResultItem>();
  for (const page of pages) {
    for (const item of page.results) {
      if (!item.session.deviceLinkDeviceId) continue;
      const key = conversationSearchResultKey(item);
      const existing = byKey.get(key);
      if (!existing || item.rankScore > existing.rankScore) {
        byKey.set(key, item);
      }
    }
  }
  return [...byKey.values()];
}

export function mergeConversationSearchFanout(
  pages: readonly ConversationSearchResponse[],
  limit: number,
  sortBy: ConversationSearchSortBy = 'relevance',
): ConversationSearchResponse {
  const byKey = new Map<string, ConversationSearchResultItem>();
  for (const page of pages) {
    for (const item of page.results) {
      const key = conversationSearchResultKey(item);
      const existing = byKey.get(key);
      if (!existing || item.rankScore > existing.rankScore) {
        byKey.set(key, item);
      }
    }
  }

  const results = [...byKey.values()]
    .sort((a, b) => compareSearchResults(a, b, sortBy))
    .slice(0, Math.max(1, limit));

  return {
    query: pages[0]?.query ?? '',
    results,
    vectorUsed: pages.some((page) => page.vectorUsed),
    vectorSkipReason: pages.find((page) => page.vectorSkipReason)?.vectorSkipReason ?? null,
    poolCapped: pages.some((page) => page.poolCapped),
  };
}

export function remoteIndexedSearchIgnoredWorkingDirs(
  response: ConversationSearchResponse,
  workingDirs: string[] | null | undefined,
): boolean {
  const allowed = normalizeWorkingDirSet(workingDirs);
  if (allowed == null) return false;
  const results = Array.isArray(response?.results) ? response.results : [];
  return results.some((item) => !matchesWorkingDirSet(item.session.workingDir, allowed));
}

export function filterResultsByWorkingDirs(
  response: ConversationSearchResponse,
  workingDirs: string[] | null | undefined,
): ConversationSearchResponse {
  return filterResultsByRequestFilters(response, { filters: { workingDirs } });
}

export function filterResultsByRequestFilters(
  response: ConversationSearchResponse,
  request: Pick<ConversationSearchRequest, 'filters'>,
): ConversationSearchResponse {
  const filters = request.filters ?? {};
  const allowedDirs = normalizeWorkingDirSet(filters.workingDirs);
  const activityCutoff = cutoffForLastActivity(filters.lastActivity ?? 'all');
  const status = filters.status ?? 'all';
  const agentKind = filters.agentKind ?? 'all';
  return {
    ...response,
    results: response.results.filter((item) => {
      if (!matchesWorkingDirSet(item.session.workingDir, allowedDirs)) return false;
      if (item.session.orcaRole === 'worker') return false;
      if (!matchesStatus(item.session.status, status)) return false;
      if (agentKind !== 'all' && item.session.agentKind !== agentKind) return false;
      if (activityCutoff !== null && sessionActivityMs(item.session) < activityCutoff) {
        return false;
      }
      return true;
    }),
  };
}

function normalizeWorkingDirForGrouping(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (trimmed === '') return null;

  const withoutLongPathPrefix = stripWindowsLongPathPrefix(trimmed);
  const needsWindowsSeparatorRewrite =
    isWindowsPathLike(trimmed) || isWindowsPathLike(withoutLongPathPrefix);
  let out = needsWindowsSeparatorRewrite
    ? withoutLongPathPrefix.replace(/\\/g, '/')
    : withoutLongPathPrefix;
  while (out.length > 1 && out.endsWith('/')) {
    if (/^[A-Za-z]:\/$/.test(out)) break;
    out = out.slice(0, -1);
  }
  return collapseWorktreeDirForGrouping(out);
}

function stripWindowsLongPathPrefix(value: string): string {
  if (value.startsWith('\\\\?\\UNC\\')) return `\\\\${value.slice('\\\\?\\UNC\\'.length)}`;
  if (value.startsWith('\\\\?\\')) return value.slice('\\\\?\\'.length);
  return value;
}

function isWindowsPathLike(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('//');
}

function normalizeWorkingDirSet(value: string[] | null | undefined): Set<string> | null {
  if (value == null || !Array.isArray(value)) return null;
  const out = new Set<string>();
  for (const item of value) {
    const normalized = normalizeWorkingDirForGrouping(item);
    if (normalized) out.add(normalized);
  }
  return out.size > 0 ? out : null;
}

function matchesWorkingDirSet(
  workingDir: string | null | undefined,
  allowed: Set<string> | null,
): boolean {
  if (allowed == null) return true;
  const key = normalizeWorkingDirForGrouping(workingDir);
  return key != null && allowed.has(key);
}

function matchesStatus(
  status: ConversationSearchSessionStatus | string,
  filter: ConversationSearchStatusFilter,
): boolean {
  if (status === 'deleted') return false;
  if (filter === 'all') return status === 'active' || status === 'archived';
  return status === filter;
}

function cutoffForLastActivity(lastActivity: ConversationSearchLastActivityFilter): number | null {
  if (lastActivity === 'all') return null;
  return Date.now() - LAST_ACTIVITY_DAY_COUNTS[lastActivity] * DAY_MS;
}

function sessionActivityMs(
  session: Pick<ConversationSearchSessionSummary, 'userSendAt' | 'updatedAt'>,
): number {
  return Math.max(parseActivityMs(session.userSendAt), parseActivityMs(session.updatedAt));
}

function parseActivityMs(value: string | null | undefined): number {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

function compareSearchResults(
  a: ConversationSearchResultItem,
  b: ConversationSearchResultItem,
  sortBy: ConversationSearchSortBy,
): number {
  if (sortBy === 'activityDesc') {
    return sessionActivityMs(b.session) - sessionActivityMs(a.session) || relevanceCompare(a, b);
  }
  if (sortBy === 'activityAsc') {
    return sessionActivityMs(a.session) - sessionActivityMs(b.session) || relevanceCompare(a, b);
  }
  return relevanceCompare(a, b);
}

function relevanceCompare(
  a: ConversationSearchResultItem,
  b: ConversationSearchResultItem,
): number {
  const groupA = a.matchKind === 'title' || a.matchKind === 'both' ? 1 : 0;
  const groupB = b.matchKind === 'title' || b.matchKind === 'both' ? 1 : 0;
  return (
    groupB - groupA ||
    b.rankScore - a.rankScore ||
    sessionActivityMs(b.session) - sessionActivityMs(a.session) ||
    a.session.id.localeCompare(b.session.id)
  );
}
