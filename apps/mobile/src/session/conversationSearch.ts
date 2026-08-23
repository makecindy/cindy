/**
 * 手机任务搜索集成层:按设备 fan-out `local-db:conversations:search`,
 * 老端 / 离线回落到已缓存会话的标题与消息预览，不搜列表元数据。
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
  remoteSessionDisplayTitle,
  sessionRowMessagePreview,
  toRemoteSessionListItem,
  type RemoteSessionListItem,
} from '@cindy/maker-shared/session-list';
import type { DeviceAccessState } from '@cindy/maker-shared/device-list';
import { collapseWorktreeDirForGrouping } from '@cindy/maker-shared/worktree-paths';
import { createMobileMakerTransport } from '@/device-link/mobileMakerTransport';
import { deviceMirrorCleanupDisposition } from '@/device-link/presenceDevices';
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
  workingDirs?: string[] | null;
}

export interface ConversationSearchDeviceModel {
  canOpen: boolean;
  deviceId: string;
  name: string | null;
  state: DeviceAccessState;
}

/**
 * 搜索源与会话镜像清理边界对齐:
 * - 全部范围:keep / soft(含短暂 offline)进源,hard(撤权 / 关远控)排除;
 * - 单台范围:只保留选中的那台,即使它暂时 offline;
 * - reachable 只看当前能否 invoke,离线或熔断都走缓存回退。
 */
export function conversationSearchOriginsFromDeviceModels(
  devices: readonly ConversationSearchDeviceModel[],
  options: {
    selectedDeviceId?: string | null;
    unresponsiveDeviceIds?: ReadonlySet<string>;
  } = {},
): ConversationSearchDeviceOrigin[] {
  const selectedDeviceId = options.selectedDeviceId ?? null;
  const unresponsiveDeviceIds = options.unresponsiveDeviceIds;
  const targets = selectedDeviceId
    ? devices.filter((item) => item.deviceId === selectedDeviceId)
    : devices.filter((item) => deviceMirrorCleanupDisposition(item.state) !== 'hard');
  return targets.map((item) => ({
    deviceId: item.deviceId,
    deviceName: item.name,
    reachable: item.canOpen && !unresponsiveDeviceIds?.has(item.deviceId),
  }));
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
    return searchCachedDeviceSessions(origin, requestForOrigin(origin, request), deps.getCachedSessions());
  }

  try {
    const maker = createMobileMakerTransport({
      deviceId: origin.deviceId,
      invoke: deps.invoke,
    });
    const deviceRequest = requestForOrigin(origin, request);
    const raw = await maker.searchConversations(deviceRequest);
    if (remoteIndexedSearchIgnoredWorkingDirs(raw, deviceRequest.filters?.workingDirs)) {
      return searchCachedDeviceSessions(origin, deviceRequest, deps.getCachedSessions());
    }
    return finalizeRemotePage(raw, origin, deviceRequest);
  } catch (error) {
    return searchCachedDeviceSessions(origin, requestForOrigin(origin, request), deps.getCachedSessions());
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
    const match = cachedConversationSearchMatch(session, query, request.unnamedLabel);
    if (!match) return;
    hits.push({
      session: sessionToSearchSummary(session, origin),
      matchKind: match.matchKind,
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

function cachedConversationSearchMatch(
  session: RemoteSession,
  query: string,
  unnamedLabel?: string,
): { matchKind: 'title' | 'content' | 'both' } | null {
  const titleHit = remoteSessionDisplayTitle(session, unnamedLabel).toLowerCase().includes(query);
  const contentHit = (sessionRowMessagePreview(session) ?? '').toLowerCase().includes(query);
  if (!titleHit && !contentHit) return null;
  if (titleHit && contentHit) return { matchKind: 'both' };
  return { matchKind: titleHit ? 'title' : 'content' };
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

export type ConversationSearchListItem = RemoteSessionListItem & {
  searchFocusClientId?: string;
  searchLocallyCached: boolean;
};

export function conversationSearchSessionCacheKey(
  session: Pick<RemoteSession, 'id'> & {
    canonicalDeviceId?: string | null;
    deviceLinkDeviceId?: string | null;
  },
): string {
  return `${session.canonicalDeviceId ?? session.deviceLinkDeviceId ?? 'local'}:${session.id}`;
}

/**
 * 索引搜索行只负责打开任务。重命名 / 置顶 / 归档 / 多选写回留在普通列表:
 * 搜索结果是一次请求的投影,订阅 store 再同步筛选只会把写操作家族继续放大。
 * 带 searchLocallyCached 字段 = 搜索命中(无论是否命中本地镜像)。
 */
export function conversationSearchAllowsLocalWrites(item: object): boolean {
  return !('searchLocallyCached' in item);
}

export function cachedSessionForSearchResult(
  item: ConversationSearchResultItem,
  sessionsByCacheKey: ReadonlyMap<string, RemoteSession>,
): RemoteSession | undefined {
  const deviceId = item.session.deviceLinkDeviceId;
  if (!deviceId) return undefined;
  return sessionsByCacheKey.get(`${deviceId}:${item.session.id}`);
}

export function toSearchListItem(
  item: ConversationSearchResultItem,
  now: number,
  unnamedLabel?: string,
  cached?: RemoteSession,
): ConversationSearchListItem {
  const deviceId = item.session.deviceLinkDeviceId ?? cached?.deviceLinkDeviceId;
  const stamped = cached
    ? {
        ...cached,
        canonicalDeviceId: deviceId ?? cached.canonicalDeviceId,
        deviceLinkDeviceId: deviceId,
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
  const listItem = toRemoteSessionListItem(
    stamped,
    now,
    undefined,
    0,
    item.contentHit?.preview ?? cached?.preview ?? null,
    null,
    unnamedLabel,
  );
  const searchFocusClientId = item.contentHit?.messageClientId?.trim();
  return {
    ...listItem,
    searchLocallyCached: !!cached,
    ...(searchFocusClientId ? { searchFocusClientId } : {}),
  };
}

function requestForOrigin(
  origin: ConversationSearchDeviceOrigin,
  request: ConversationSearchRequest,
): ConversationSearchRequest {
  if (!origin.workingDirs?.length) return request;
  return {
    ...request,
    filters: {
      ...request.filters,
      workingDirs: origin.workingDirs,
    },
  };
}

export type ConversationSearchProjectSelection = 'all' | string[];

export interface ConversationSearchProjectOption {
  count: number;
  deviceId: string;
  deviceName: string | null;
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
}): string[] | null {
  if (input.lockedWorkingDirs?.length) return [...input.lockedWorkingDirs];
  return null;
}

export function scopedConversationSearchOrigins(
  origins: readonly ConversationSearchDeviceOrigin[],
  selection: ConversationSearchProjectSelection,
  projects: readonly ConversationSearchProjectOption[],
): ConversationSearchDeviceOrigin[] {
  if (selection === 'all') return [...origins];
  const selected = new Set(selection);
  const dirsByDevice = new Map<string, string[]>();
  for (const project of projects) {
    if (!selected.has(project.key)) continue;
    const dirs = dirsByDevice.get(project.deviceId) ?? [];
    if (!dirs.includes(project.workingDir)) dirs.push(project.workingDir);
    dirsByDevice.set(project.deviceId, dirs);
  }
  return origins.flatMap((origin) => {
    const dirs = dirsByDevice.get(origin.deviceId);
    if (!dirs?.length) return [];
    return [{ ...origin, workingDirs: dirs }];
  });
}

export function listConversationSearchProjects(
  sessions: readonly Pick<RemoteSession, 'canonicalDeviceId' | 'deviceLinkDeviceId' | 'deviceLinkDeviceName' | 'orcaRole' | 'workingDir' | 'workspaceKind'>[],
  deviceIds?: ReadonlySet<string>,
): ConversationSearchProjectOption[] {
  const byKey = new Map<string, ConversationSearchProjectOption>();
  for (const session of sessions) {
    if (session.orcaRole === 'worker') continue;
    if (deviceIds && !sessionBelongsToSelectedDevice(session, deviceIds)) continue;
    if (session.workspaceKind === 'dialogue') continue;
    const deviceId = session.canonicalDeviceId ?? session.deviceLinkDeviceId;
    if (!deviceId) continue;
    const workingDir = stripTrailingPathSeparators(session.workingDir?.trim() ?? '');
    if (!workingDir) continue;
    const dirKey = collapseWorktreeDirForGrouping(workingDir) ?? workingDir;
    const key = `${deviceId}:${dirKey}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.count += 1;
      continue;
    }
    byKey.set(key, {
      count: 1,
      deviceId,
      deviceName: session.deviceLinkDeviceName ?? null,
      key,
      title: conversationSearchProjectTitle(workingDir),
      workingDir: dirKey,
    });
  }
  return [...byKey.values()].sort((a, b) => (
    a.title.localeCompare(b.title) || a.deviceId.localeCompare(b.deviceId) || a.key.localeCompare(b.key)
  ));
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
