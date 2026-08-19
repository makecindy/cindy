import type {
  ConversationSearchRequest,
  ConversationSearchResponse,
} from '../../shared/conversationSearch';
import type { Session } from '@/lib/ccAgent.types';
import { ApiError } from '@/lib/httpClient';
import { extractIpcError } from '@/utils/ipcError';
import {
  emptyConversationSearchResponse,
  filterResultsByRequestFilters,
  LEGACY_REMOTE_SESSION_LIST_LIMIT,
  remoteIndexedSearchIgnoredWorkingDirs,
  mergeConversationSearchFanout,
  remoteResultsFromFanoutPages,
  requestForOrigin,
  searchCachedSessionsByTitle,
  stampRemoteSearchResponse,
  type ConversationSearchOrigin,
} from './conversationSearchFanout';
import type { ConversationSearchResultItem } from '../../shared/conversationSearch';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';

function wrap<T>(p: Promise<T>): Promise<T> {
  return p.catch((err: unknown) => {
    const ipcError = extractIpcError(err);
    if (ipcError) {
      throw new ApiError(ipcError.code, 0, ipcError.message);
    }
    if (err instanceof Error) {
      throw new ApiError('UNKNOWN', 0, err.message);
    }
    throw new ApiError('UNKNOWN', 0, String(err));
  });
}

export interface ConversationSearchFanoutDeps {
  origins: ConversationSearchOrigin[];
  searchLocal: (request: ConversationSearchRequest) => Promise<ConversationSearchResponse>;
  invokeRemote: (deviceId: string, channel: string, args: unknown[]) => Promise<unknown>;
  listCachedRemoteSessions: (deviceId: string) => Session[];
}

export async function searchConversationsAcrossOrigins(
  request: ConversationSearchRequest,
  deps: ConversationSearchFanoutDeps & {
    reuseRemoteResults?: ConversationSearchResultItem[];
  },
): Promise<ConversationSearchResponse> {
  const query = request.query.trim();
  if (!query) return emptyConversationSearchResponse('');
  const reuseRemote = deps.reuseRemoteResults != null;
  const origins = reuseRemote
    ? deps.origins.filter((origin) => origin.kind === 'local')
    : deps.origins;
  if (origins.length === 0 && !reuseRemote) return emptyConversationSearchResponse(query);

  const pages = await Promise.all(
    origins.map((origin) => searchOneOrigin(request, origin, deps)),
  );
  const present = pages.filter((page): page is ConversationSearchResponse => page !== null);
  if (reuseRemote) {
    if (origins.length > 0 && present.length === 0) {
      throw new ApiError('UNKNOWN', 0, 'conversation search failed');
    }
    present.push({
      query,
      results: deps.reuseRemoteResults ?? [],
      vectorUsed: false,
      vectorSkipReason: null,
      poolCapped: false,
    });
  }
  if (present.length === 0) {
    throw new ApiError('UNKNOWN', 0, 'conversation search failed');
  }
  const merged = mergeConversationSearchFanout(
    present,
    request.limit ?? 24,
    request.sortBy ?? 'relevance',
  );
  return {
    ...merged,
    remoteResults: remoteResultsFromFanoutPages(present),
  };
}

async function searchOneOrigin(
  request: ConversationSearchRequest,
  origin: ConversationSearchOrigin,
  deps: ConversationSearchFanoutDeps,
): Promise<ConversationSearchResponse | null> {
  const originRequest = requestForOrigin(request, origin);
  if (origin.kind === 'local') {
    try {
      return await deps.searchLocal(originRequest);
    } catch {
      return null;
    }
  }

  if (!origin.connected) {
    return finalizeRemoteResponse(
      searchCachedSessionsByTitle(deps.listCachedRemoteSessions(origin.deviceId), originRequest),
      origin,
      originRequest,
    );
  }

  try {
    const response = await searchRemoteIndexed(origin.deviceId, originRequest, deps.invokeRemote);
    if (remoteIndexedSearchIgnoredWorkingDirs(response, origin.workingDirs)) {
      return finalizeRemoteResponse(
        await searchRemoteLegacyByTitle(origin.deviceId, originRequest, deps),
        origin,
        originRequest,
      );
    }
    return finalizeRemoteResponse(response, origin, originRequest);
  } catch (error) {
    if (isDeviceLinkNotConnected(error)) {
      return finalizeRemoteResponse(
        searchCachedSessionsByTitle(deps.listCachedRemoteSessions(origin.deviceId), originRequest),
        origin,
        originRequest,
      );
    }
    if (isChannelNotAllowed(error)) {
      return finalizeRemoteResponse(
        await searchRemoteLegacyByTitle(origin.deviceId, originRequest, deps),
        origin,
        originRequest,
      );
    }
    return finalizeRemoteResponse(
      searchCachedSessionsByTitle(deps.listCachedRemoteSessions(origin.deviceId), originRequest),
      origin,
      originRequest,
    );
  }
}

async function searchRemoteIndexed(
  deviceId: string,
  request: ConversationSearchRequest,
  invokeRemote: ConversationSearchFanoutDeps['invokeRemote'],
): Promise<ConversationSearchResponse> {
  const response = await invokeRemote(deviceId, 'local-db:conversations:search', [request]);
  return response as ConversationSearchResponse;
}

async function searchRemoteLegacyByTitle(
  deviceId: string,
  request: ConversationSearchRequest,
  deps: ConversationSearchFanoutDeps,
): Promise<ConversationSearchResponse> {
  try {
    const sessions = await listRemoteSessions(deviceId, request, deps.invokeRemote);
    return searchCachedSessionsByTitle(sessions, request);
  } catch {
    return searchCachedSessionsByTitle(deps.listCachedRemoteSessions(deviceId), request);
  }
}

async function listRemoteSessions(
  deviceId: string,
  request: ConversationSearchRequest,
  invokeRemote: ConversationSearchFanoutDeps['invokeRemote'],
): Promise<Session[]> {
  const status =
    request.filters?.status === 'active' || request.filters?.status === 'archived'
      ? request.filters.status
      : 'all';
  return (await invokeRemote(deviceId, 'local-db:sessions:list', [
    LEGACY_REMOTE_SESSION_LIST_LIMIT,
    status,
  ])) as Session[];
}

function finalizeRemoteResponse(
  response: ConversationSearchResponse,
  origin: Extract<ConversationSearchOrigin, { kind: 'remote' }>,
  originRequest: ConversationSearchRequest,
): ConversationSearchResponse {
  return filterResultsByRequestFilters(
    stampRemoteSearchResponse(response, {
      deviceId: origin.deviceId,
      deviceName: origin.deviceName,
    }),
    originRequest,
  );
}

function isChannelNotAllowed(error: unknown): boolean {
  const code = extractIpcError(error)?.code ?? (error instanceof ApiError ? error.code : null);
  if (code === 'DEVICE_LINK_CHANNEL_NOT_ALLOWED') return true;
  return error instanceof Error && /CHANNEL_NOT_ALLOWED/.test(error.message);
}

function isDeviceLinkNotConnected(error: unknown): boolean {
  const code = extractIpcError(error)?.code ?? (error instanceof ApiError ? error.code : null);
  return code === 'DEVICE_LINK_NOT_CONNECTED';
}

export function searchConversations(
  request: ConversationSearchRequest,
  options?: {
    origins?: ConversationSearchOrigin[];
    reuseRemoteResults?: ConversationSearchResultItem[];
  },
): Promise<ConversationSearchResponse> {
  return searchConversationsAcrossOrigins(request, {
    origins: options?.origins ?? [
      {
        kind: 'local',
        sessionIds: request.filters?.sessionIds ?? null,
        workingDirs: request.filters?.workingDirs ?? null,
      },
    ],
    reuseRemoteResults: options?.reuseRemoteResults,
    searchLocal: (next) => wrap(window.electronAPI.localDb.conversations.search(next)),
    invokeRemote: (deviceId, channel, args) =>
      window.electronAPI.deviceLink.invoke(deviceId, channel, args),
    listCachedRemoteSessions: (deviceId) =>
      remoteProjectsStore
        .getMergedRemoteSessions()
        .filter((session) => session.deviceLinkDeviceId === deviceId),
  });
}
