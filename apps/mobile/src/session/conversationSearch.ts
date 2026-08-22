/**
 * 手机任务搜索集成层:按设备 fan-out `local-db:conversations:search`,
 * 老端 / 离线回落到已缓存会话的 matchesSearchQuery。
 *
 * 纯函数 + 注入依赖,不直接碰 React / store。
 */
import {
  emptyConversationSearchResponse,
  filterResultsByRequestFilters,
  mergeConversationSearchFanout,
  remoteIndexedSearchIgnoredWorkingDirs,
  stampRemoteSearchResponse,
  type ConversationSearchAgentFilter,
  type ConversationSearchLastActivityFilter,
  type ConversationSearchRequest,
  type ConversationSearchResponse,
  type ConversationSearchResultItem,
  type ConversationSearchSessionSummary,
  type ConversationSearchStatusFilter,
} from '@cindy/maker-shared/conversation-search';
import { stripTrailingPathSeparators } from '@cindy/maker-shared/path-text';
import {
  matchesSearchQuery,
  toRemoteSessionListItem,
  type RemoteSessionListItem,
} from '@cindy/maker-shared/session-list';
import { collapseWorktreeDirForGrouping } from '@cindy/maker-shared/worktree-paths';
import { createMobileMakerTransport } from '@/device-link/mobileMakerTransport';
import type { RemoteSession } from '@/session/types';

export const CONVERSATION_SEARCH_LIMIT = 24;

export type ConversationSearchInvoke = <T>(
  deviceId: string,
  channel: string,
  args?: unknown[],
) => Promise<T>;

export interface ConversationSearchDeviceOrigin {
  deviceId: string;
  deviceName: string | null;
  reachable: boolean;
}

export interface SearchConversationsAcrossDevicesDeps {
  invoke: ConversationSearchInvoke;
  getCachedSessions: () => readonly RemoteSession[];
  isDeviceUnresponsive?: (deviceId: string) => boolean;
}

export function isConversationSearchChannelNotAllowed(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  const message = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : String(error);
  return `${typeof code === 'string' ? code : ''} ${message}`.includes('CHANNEL_NOT_ALLOWED');
}

export function sessionBelongsToDevice(
  session: Pick<RemoteSession, 'canonicalDeviceId' | 'deviceLinkDeviceId'>,
  deviceId: string,
): boolean {
  return (session.canonicalDeviceId ?? session.deviceLinkDeviceId) === deviceId;
}

export async function searchConversationsAcrossDevices(
  origins: readonly ConversationSearchDeviceOrigin[],
  request: ConversationSearchRequest,
  deps: SearchConversationsAcrossDevicesDeps,
): Promise<ConversationSearchResponse> {
  const query = request.query.trim();
  if (!query || origins.length === 0) return emptyConversationSearchResponse(query);

  const keywordRequest: ConversationSearchRequest = {
    ...request,
    query,
    limit: request.limit ?? CONVERSATION_SEARCH_LIMIT,
    semanticMode: 'keyword',
  };

  const pages = await Promise.all(
    origins.map((origin) => searchOneDevice(origin, keywordRequest, deps)),
  );
  const present = pages.filter((page): page is ConversationSearchResponse => page != null);
  if (present.length === 0) return emptyConversationSearchResponse(query);

  const merged = mergeConversationSearchFanout(
    present,
    keywordRequest.limit ?? CONVERSATION_SEARCH_LIMIT,
    keywordRequest.sortBy ?? 'relevance',
  );
  return filterResultsByRequestFilters(merged, keywordRequest);
}

async function searchOneDevice(
  origin: ConversationSearchDeviceOrigin,
  request: ConversationSearchRequest,
  deps: SearchConversationsAcrossDevicesDeps,
): Promise<ConversationSearchResponse | null> {
  const unresponsive = deps.isDeviceUnresponsive?.(origin.deviceId) === true;
  if (!origin.reachable || unresponsive) {
    return searchCachedDeviceSessions(origin, request, deps.getCachedSessions());
  }

  try {
    const maker = createMobileMakerTransport({
      deviceId: origin.deviceId,
      invoke: deps.invoke,
    });
    const raw = await maker.searchConversations(request);
    if (remoteIndexedSearchIgnoredWorkingDirs(raw, request.filters?.workingDirs)) {
      return searchCachedDeviceSessions(origin, request, deps.getCachedSessions());
    }
    return finalizeRemotePage(raw, origin, request);
  } catch (error) {
    return searchCachedDeviceSessions(origin, request, deps.getCachedSessions());
  }
}

function finalizeRemotePage(
  response: ConversationSearchResponse,
  origin: ConversationSearchDeviceOrigin,
  request: ConversationSearchRequest,
): ConversationSearchResponse {
  return filterResultsByRequestFilters(
    stampRemoteSearchResponse(response, {
      deviceId: origin.deviceId,
      deviceName: origin.deviceName,
    }),
    request,
  );
}

export function searchCachedDeviceSessions(
  origin: ConversationSearchDeviceOrigin,
  request: ConversationSearchRequest,
  sessions: readonly RemoteSession[],
): ConversationSearchResponse {
  const query = request.query.trim().toLowerCase();
  if (!query) return emptyConversationSearchResponse('');

  const hits: ConversationSearchResultItem[] = [];
  sessions.forEach((session, index) => {
    if (session.orcaRole === 'worker') return;
    if (!sessionBelongsToDevice(session, origin.deviceId)) return;
    if (!matchesSearchQuery(session, query, { unnamedLabel: request.unnamedLabel })) return;
    hits.push({
      session: sessionToSearchSummary(session, origin),
      matchKind: 'title',
      titleMatchIndices: [],
      titleScore: null,
      contentHit: null,
      contentHits: [],
      rankScore: 1_000_000 - index,
    });
  });

  return filterResultsByRequestFilters(
    {
      query: request.query.trim(),
      results: hits,
      vectorUsed: false,
      vectorSkipReason: null,
      poolCapped: false,
    },
    request,
  );
}

function sessionToSearchSummary(
  session: RemoteSession,
  origin: ConversationSearchDeviceOrigin,
): ConversationSearchSessionSummary {
  return {
    id: session.id,
    title: session.title,
    workingDir: session.workingDir,
    workspaceKind: session.workspaceKind,
    agentKind: session.agentKind,
    status: session.status,
    source: session.source ?? null,
    orcaRole: session.orcaRole === 'lead' || session.orcaRole === 'worker' ? session.orcaRole : null,
    parentSessionId: session.parentSessionId ?? null,
    userSendAt: session.userSendAt,
    updatedAt: session.updatedAt,
    createdAt: session.createdAt,
    _count: { messages: session._count?.messages ?? 0 },
    deviceLinkDeviceId: origin.deviceId,
    deviceLinkDeviceName: origin.deviceName ?? session.deviceLinkDeviceName ?? null,
  };
}

export function toSearchListItem(
  item: ConversationSearchResultItem,
  now: number,
  unnamedLabel?: string,
  cached?: RemoteSession,
): RemoteSessionListItem {
  const stamped = cached
    ? {
        ...cached,
        deviceLinkDeviceId: item.session.deviceLinkDeviceId ?? cached.deviceLinkDeviceId,
        deviceLinkDeviceName: item.session.deviceLinkDeviceName ?? cached.deviceLinkDeviceName,
      }
    : {
        id: item.session.id,
        title: item.session.title,
        workingDir: item.session.workingDir,
        workspaceKind: item.session.workspaceKind,
        agentKind: item.session.agentKind,
        status: item.session.status,
        source: item.session.source ?? null,
        orcaRole: item.session.orcaRole,
        userSendAt: item.session.userSendAt,
        updatedAt: item.session.updatedAt,
        createdAt: item.session.createdAt,
        model: '',
        _count: item.session._count,
        deviceLinkDeviceId: item.session.deviceLinkDeviceId,
        deviceLinkDeviceName: item.session.deviceLinkDeviceName,
      };
  return toRemoteSessionListItem(
    stamped,
    now,
    undefined,
    0,
    item.contentHit?.preview ?? cached?.preview ?? null,
    null,
    unnamedLabel,
  );
}

export type ConversationSearchProjectSelection = 'all' | string[];

export interface ConversationSearchProjectOption {
  count: number;
  key: string;
  title: string;
  workingDir: string;
}

export function shouldReplaceListWithSearchResults(
  query: string,
  status: 'idle' | 'searching' | 'ready',
): boolean {
  return query.trim().length > 0 && status === 'ready';
}

export function conversationSearchStatusFilter(
  status: string | undefined,
): ConversationSearchStatusFilter {
  if (status === 'active' || status === 'archived' || status === 'all') return status;
  return 'all';
}

export function conversationSearchActiveFilterCount(input: {
  agentKind?: ConversationSearchAgentFilter;
  lastActivity?: ConversationSearchLastActivityFilter;
  lockedWorkingDirs?: string[] | null;
  projectSelection?: ConversationSearchProjectSelection;
  status?: ConversationSearchStatusFilter;
}): number {
  let count = 0;
  if ((input.status ?? 'all') !== 'all') count += 1;
  if ((input.agentKind ?? 'all') !== 'all') count += 1;
  if ((input.lastActivity ?? 'all') !== 'all') count += 1;
  if (!input.lockedWorkingDirs?.length && input.projectSelection && input.projectSelection !== 'all') {
    count += 1;
  }
  return count;
}

export function nextConversationSearchProjectSelection(
  prev: ConversationSearchProjectSelection,
  projectKey: string,
): ConversationSearchProjectSelection {
  if (prev === 'all') return [projectKey];
  if (prev.includes(projectKey)) {
    const next = prev.filter((key) => key !== projectKey);
    return next.length > 0 ? next : 'all';
  }
  return [...prev, projectKey];
}

export function reconcileConversationSearchProjectSelection(
  selection: ConversationSearchProjectSelection,
  visibleKeys: readonly string[],
): ConversationSearchProjectSelection {
  if (selection === 'all') return 'all';
  const visible = new Set(visibleKeys);
  const next = selection.filter((key) => visible.has(key));
  return next.length > 0 ? next : 'all';
}

export function conversationSearchWorkingDirs(input: {
  lockedWorkingDirs?: string[] | null;
  projectSelection?: ConversationSearchProjectSelection;
}): string[] | null {
  if (input.lockedWorkingDirs?.length) return [...input.lockedWorkingDirs];
  if (!input.projectSelection || input.projectSelection === 'all') return null;
  return [...input.projectSelection];
}

export function listConversationSearchProjects(
  sessions: readonly Pick<RemoteSession, 'canonicalDeviceId' | 'deviceLinkDeviceId' | 'orcaRole' | 'workingDir' | 'workspaceKind'>[],
  deviceIds?: ReadonlySet<string>,
): ConversationSearchProjectOption[] {
  const byKey = new Map<string, ConversationSearchProjectOption>();
  for (const session of sessions) {
    if (session.orcaRole === 'worker') continue;
    if (deviceIds && !sessionBelongsToSelectedDevice(session, deviceIds)) continue;
    if (session.workspaceKind === 'dialogue') continue;
    const workingDir = stripTrailingPathSeparators(session.workingDir?.trim() ?? '');
    if (!workingDir) continue;
    const key = collapseWorktreeDirForGrouping(workingDir) ?? workingDir;
    const existing = byKey.get(key);
    if (existing) {
      existing.count += 1;
      continue;
    }
    byKey.set(key, {
      count: 1,
      key,
      title: conversationSearchProjectTitle(workingDir),
      workingDir,
    });
  }
  return [...byKey.values()].sort((a, b) => a.title.localeCompare(b.title) || a.key.localeCompare(b.key));
}

function sessionBelongsToSelectedDevice(
  session: Pick<RemoteSession, 'canonicalDeviceId' | 'deviceLinkDeviceId'>,
  deviceIds: ReadonlySet<string>,
): boolean {
  const id = session.canonicalDeviceId ?? session.deviceLinkDeviceId;
  return !!id && deviceIds.has(id);
}

function conversationSearchProjectTitle(workingDir: string): string {
  const trimmed = stripTrailingPathSeparators(workingDir);
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || workingDir;
}
