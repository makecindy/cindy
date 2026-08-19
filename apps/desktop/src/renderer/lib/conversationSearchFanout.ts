/**
 * conversationSearchFanout —— 侧栏任务搜索的本机 / device-link fan-out。
 *
 * 被控端任务不进控制端 SQLite。本机 IPC 与 `local-db:conversations:search` 隧道
 * 共用同一份 request,控制端按机器切换栏 / 项目锁定拆 origin 后再合并。
 * 纯函数 + 注入依赖,方便单测,不直接碰 store / Electron。
 */

import { conversationSearchTitle } from '../../shared/conversationSearch';
import type {
  ConversationSearchLastActivityFilter,
  ConversationSearchRequest,
  ConversationSearchResponse,
  ConversationSearchResultItem,
  ConversationSearchSessionStatus,
  ConversationSearchSessionSummary,
  ConversationSearchSortBy,
  ConversationSearchStatusFilter,
} from '../../shared/conversationSearch';
import type { Session } from '@/lib/ccAgent.types';
import { fuzzyMatch } from '@/features/cc-agent/lib/fuzzyMatch';
import { isOrcaWorkerSession } from '@/lib/orcaSessionIdentity';
import {
  MACHINE_ALL,
  MACHINE_LOCAL,
  type MachineSelection,
} from '@/features/device-link/selectedMachineStore';
import {
  normalizeProjectKey,
  projectKeyComparisonKey,
} from '../../shared/projectKeys';
import { normalizeWorkingDirForGrouping } from '../../shared/workingDir';

export interface ConversationSearchDevice {
  deviceId: string;
  deviceName: string;
  connected: boolean;
}

export function searchDevicesFromSwitcher(
  devices: readonly { deviceId: string; name: string; status: string }[],
): ConversationSearchDevice[] {
  return devices
    .filter((device) => device.status !== 'rejected')
    .map((device) => ({
      deviceId: device.deviceId,
      deviceName: device.name,
      connected: device.status === 'connected' || device.status === 'connecting',
    }));
}

export interface ConversationSearchProjectTarget {
  /** device-link 设备。本机 / SSH 项目不走这条路径，避免丢掉 remoteHostId。 */
  deviceId: string;
  workingDir: string;
}

export type ConversationSearchOrigin =
  | {
      kind: 'local';
      sessionIds: string[] | null;
      workingDirs?: string[] | null;
    }
  | {
      kind: 'remote';
      deviceId: string;
      deviceName: string | null;
      connected: boolean;
      sessionIds: string[] | null;
      workingDirs?: string[] | null;
    };

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
const LEGACY_REMOTE_LIST_LIMIT = 100;

export function emptyConversationSearchResponse(query = ''): ConversationSearchResponse {
  return {
    query,
    results: [],
    vectorUsed: false,
    vectorSkipReason: null,
    poolCapped: false,
  };
}

export function resolveConversationSearchOrigins(args: {
  machineSelection: MachineSelection;
  sessionIds?: string[] | null;
  projectTargets?: readonly ConversationSearchProjectTarget[] | null;
  devices: readonly ConversationSearchDevice[];
  getSessionDeviceId: (sessionId: string) => string | undefined;
}): ConversationSearchOrigin[] {
  const targetOrigins =
    args.projectTargets && args.projectTargets.length > 0
      ? originsFromProjectTargets(args.projectTargets, args.devices)
      : [];
  const sessionIds = normalizeSessionIds(args.sessionIds);
  if (sessionIds && sessionIds.length === 0 && targetOrigins.length === 0) return [];

  if (sessionIds && sessionIds.length > 0) {
    return mergeProjectAndSessionOrigins(
      targetOrigins,
      originsFromSessionIds(sessionIds, args.devices, args.getSessionDeviceId),
    );
  }
  if (targetOrigins.length > 0) return targetOrigins;

  return originsFromMachineSelection(args.machineSelection, args.devices);
}

function originsFromProjectTargets(
  targets: readonly ConversationSearchProjectTarget[],
  devices: readonly ConversationSearchDevice[],
): ConversationSearchOrigin[] {
  const deviceById = new Map(devices.map((device) => [device.deviceId, device]));
  const remoteDirs = new Map<string, string[]>();

  for (const target of targets) {
    const deviceId = target.deviceId.trim();
    const workingDir = normalizeWorkingDirForGrouping(target.workingDir);
    if (!deviceId || workingDir == null) continue;
    const bucket = remoteDirs.get(deviceId);
    if (bucket) {
      if (!bucket.includes(workingDir)) bucket.push(workingDir);
    } else {
      remoteDirs.set(deviceId, [workingDir]);
    }
  }

  return [...remoteDirs].map(([deviceId, workingDirs]) => {
    const device = deviceById.get(deviceId);
    return {
      kind: 'remote' as const,
      deviceId,
      deviceName: device?.deviceName ?? null,
      connected: device?.connected === true,
      sessionIds: null,
      workingDirs,
    };
  });
}

function mergeProjectAndSessionOrigins(
  targetOrigins: ConversationSearchOrigin[],
  sessionOrigins: ConversationSearchOrigin[],
): ConversationSearchOrigin[] {
  const targetDeviceIds = new Set(
    targetOrigins.flatMap((origin) => (origin.kind === 'remote' ? [origin.deviceId] : [])),
  );
  return [
    ...targetOrigins,
    ...sessionOrigins.filter(
      (origin) => origin.kind === 'local' || !targetDeviceIds.has(origin.deviceId),
    ),
  ];
}

function originsFromSessionIds(
  sessionIds: string[],
  devices: readonly ConversationSearchDevice[],
  getSessionDeviceId: (sessionId: string) => string | undefined,
): ConversationSearchOrigin[] {
  const deviceById = new Map(devices.map((device) => [device.deviceId, device]));
  const localIds: string[] = [];
  const remoteIds = new Map<string, string[]>();

  for (const sessionId of sessionIds) {
    const deviceId = getSessionDeviceId(sessionId);
    if (!deviceId) {
      localIds.push(sessionId);
      continue;
    }
    const bucket = remoteIds.get(deviceId);
    if (bucket) bucket.push(sessionId);
    else remoteIds.set(deviceId, [sessionId]);
  }

  const origins: ConversationSearchOrigin[] = [];
  if (localIds.length > 0) {
    origins.push({ kind: 'local', sessionIds: localIds });
  }
  for (const [deviceId, ids] of remoteIds) {
    const device = deviceById.get(deviceId);
    origins.push({
      kind: 'remote',
      deviceId,
      deviceName: device?.deviceName ?? null,
      connected: device?.connected === true,
      sessionIds: ids,
    });
  }
  return origins;
}

function originsFromMachineSelection(
  selection: MachineSelection,
  devices: readonly ConversationSearchDevice[],
): ConversationSearchOrigin[] {
  const includeLocal = selection === MACHINE_ALL || selection.includes(MACHINE_LOCAL);
  const selectedRemoteIds =
    selection === MACHINE_ALL ? null : new Set(selection.filter((id) => id !== MACHINE_LOCAL));
  const origins: ConversationSearchOrigin[] = [];
  if (includeLocal) {
    origins.push({ kind: 'local', sessionIds: null });
  }
  for (const device of devices) {
    if (selectedRemoteIds && !selectedRemoteIds.has(device.deviceId)) continue;
    origins.push({
      kind: 'remote',
      deviceId: device.deviceId,
      deviceName: device.deviceName,
      connected: device.connected,
      sessionIds: null,
    });
  }
  return origins;
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

/** Remote hits from origin pages, before the merged display page is truncated. */
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

export function searchCachedSessionsByTitle(
  sessions: readonly Session[],
  request: ConversationSearchRequest,
): ConversationSearchResponse {
  const query = request.query.trim();
  if (!query) return emptyConversationSearchResponse('');

  const filters = request.filters ?? {};
  const sessionIds = normalizeSessionIds(filters.sessionIds);
  if (sessionIds && sessionIds.length === 0) {
    return emptyConversationSearchResponse(query);
  }
  const allowed = sessionIds ? new Set(sessionIds) : null;
  const workingDirs = normalizeWorkingDirSet(filters.workingDirs);
  const activityCutoff = cutoffForLastActivity(filters.lastActivity ?? 'all');
  const titleMatches: Array<{
    session: ConversationSearchSessionSummary;
    score: number;
    indices: number[];
    index: number;
  }> = [];

  sessions.forEach((session, index) => {
    if (isOrcaWorkerSession(session)) return;
    if (allowed && !allowed.has(session.id)) return;
    if (!matchesWorkingDirSet(session.workingDir, workingDirs)) return;
    if (!matchesStatus(session.status, filters.status ?? 'all')) return;
    if (
      filters.agentKind &&
      filters.agentKind !== 'all' &&
      session.agentKind !== filters.agentKind
    ) {
      return;
    }
    if (activityCutoff !== null && sessionActivityMs(session) < activityCutoff) return;
    const title = conversationSearchTitle(session.title, request.unnamedLabel);
    const match = fuzzyMatch(title, query);
    if (!match) return;
    titleMatches.push({
      session: sessionToSearchSummary(session),
      score: match.score,
      indices: match.indices,
      index,
    });
  });

  titleMatches.sort(
    (a, b) =>
      b.score - a.score ||
      sessionActivityMs(b.session) - sessionActivityMs(a.session) ||
      a.index - b.index,
  );

  const limit = clampLimit(request.limit);
  const results: ConversationSearchResultItem[] = titleMatches
    .slice(0, limit)
    .map((match, index) => ({
      session: match.session,
      matchKind: 'title',
      titleMatchIndices: match.indices,
      titleScore: match.score,
      contentHit: null,
      contentHits: [],
      rankScore: 2_000_000 + match.score * 100 - index,
    }));

  return {
    query,
    results: sortByRequest(results, request.sortBy),
    vectorUsed: false,
    vectorSkipReason: null,
    poolCapped: false,
  };
}

export function requestForOrigin(
  request: ConversationSearchRequest,
  origin: ConversationSearchOrigin,
): ConversationSearchRequest {
  return {
    ...request,
    semanticMode: origin.kind === 'remote' ? 'keyword' : request.semanticMode,
    filters: {
      ...request.filters,
      sessionIds: origin.sessionIds,
      workingDirs: origin.workingDirs ?? null,
    },
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

/** Drop remote hits that ignore status / agent / activity / project filters. */
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
      if (isOrcaWorkerSession(item.session)) return false;
      if (!matchesStatus(item.session.status, status)) return false;
      if (agentKind !== 'all' && item.session.agentKind !== agentKind) return false;
      if (activityCutoff !== null && sessionActivityMs(item.session) < activityCutoff) {
        return false;
      }
      return true;
    }),
  };
}

export function shouldReleaseConversationSearchLock(args: {
  lockedProjectKey: string | null;
  visibleProjects: readonly { projectKey: string }[];
  localPlatform: string;
  machineSelection?: MachineSelection;
}): boolean {
  if (!args.lockedProjectKey) return false;
  if (
    args.machineSelection != null &&
    !lockMatchesMachineSelection(args.lockedProjectKey, args.machineSelection)
  ) {
    return true;
  }
  // Catalogue still empty (first paint / index not loaded): keep the lock so
  // the project-menu fallback session ids / workingDir can apply.
  if (args.visibleProjects.length === 0) return false;
  const lockedComparison = projectKeyComparisonKey(
    args.lockedProjectKey,
    args.localPlatform,
  );
  if (lockedComparison == null) return true;
  return !args.visibleProjects.some((project) => {
    const comparison = projectKeyComparisonKey(project.projectKey, args.localPlatform);
    return comparison != null && comparison === lockedComparison;
  });
}

function lockMatchesMachineSelection(
  projectKey: string,
  selection: MachineSelection,
): boolean {
  if (selection === MACHINE_ALL) return true;
  const deviceId = deviceIdFromProjectKey(projectKey);
  if (deviceId == null) return selection.includes(MACHINE_LOCAL);
  return selection.includes(deviceId);
}

function deviceIdFromProjectKey(projectKey: string): string | null {
  const normalized = normalizeProjectKey(projectKey);
  if (normalized == null || !normalized.startsWith('device:')) return null;
  const rest = normalized.slice('device:'.length);
  const sep = rest.indexOf(':');
  if (sep <= 0) return null;
  try {
    return decodeURIComponent(rest.slice(0, sep));
  } catch {
    return null;
  }
}

export const LEGACY_REMOTE_SESSION_LIST_LIMIT = LEGACY_REMOTE_LIST_LIMIT;

export function sessionToSearchSummary(session: Session): ConversationSearchSessionSummary {
  return {
    id: session.id,
    title: session.title,
    workingDir: session.workingDir,
    workspaceKind: session.workspaceKind,
    agentKind: session.agentKind,
    status: session.status,
    source: session.source,
    orcaRole: session.orcaRole,
    parentSessionId: session.parentSessionId,
    userSendAt: session.userSendAt,
    updatedAt: session.updatedAt,
    createdAt: session.createdAt,
    _count: { messages: session._count?.messages ?? 0 },
    deviceLinkDeviceId: session.deviceLinkDeviceId ?? null,
    deviceLinkDeviceName: session.deviceLinkDeviceName ?? null,
  };
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

function normalizeSessionIds(value: string[] | null | undefined): string[] | null {
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
  session: Pick<Session, 'userSendAt' | 'updatedAt'> | ConversationSearchSessionSummary,
): number {
  return Math.max(parseActivityMs(session.userSendAt), parseActivityMs(session.updatedAt));
}

function parseActivityMs(value: string | null | undefined): number {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

function clampLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 24;
  return Math.max(1, Math.min(Math.floor(value), 50));
}

function sortByRequest(
  results: ConversationSearchResultItem[],
  sortBy: ConversationSearchSortBy | undefined,
): ConversationSearchResultItem[] {
  return [...results].sort((a, b) => compareSearchResults(a, b, sortBy ?? 'relevance'));
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
