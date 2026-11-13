import { buildSharedTaskInvitationLink, createSharedTaskApi, parseSharedTaskInvitation, sharedTaskAccountName, SharedTaskScopeChangedError, type SharedTaskListItem } from '@cindy/device-link';
import { AsyncLocalStorage } from 'node:async_hooks';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import { getAccessToken, getActiveAuthRealm, getAuthState, getCurrentUserId } from '../authManager.js';
import { getClientEndpoint } from '../clientEndpointsService.js';
import { serverApiFetch } from '../serverApiClient.desktop.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { agentNetSelectionKey, isAgentNetActive, agentNetAllowsLegacy } from './agentNetRuntime.js';
import { agentNetSharingInvitation, agentNetSharingRoute, joinAgentNetSharedTask, listAgentNetSharedTasks,
  rememberAgentNetSharingHost, rememberAgentNetSharingService, requestAgentNetSharing, selectedAgentNetSharingRoute,
  captureAgentNetSharingBoundaryClose, retireAgentNetSharingGuest } from './agentNetSharing.js';

// Agent management must keep the input/permission boundary through queued work
// and auth refresh retries. Native UI and background reconciliation have no caller guard.
const callerGuard = new AsyncLocalStorage<() => void>();
export function runWithSharedTaskCallerGuard<T>(assertCurrent: () => void, work: () => Promise<T>): Promise<T> {
  return callerGuard.run(assertCurrent, work);
}

// The host runtime and the guest directory both read the same account list.
// Concurrent and closely spaced reads share one request; any write, including
// one still in flight, makes earlier lists unusable.
const LIST_REUSE_MS = 5_000;
let listWrites = 0;
let listCache: { key: string; writes: number; settledAt: number | null; result: Promise<SharedTaskListItem[]> } | null = null;
function trackListWrite<T>(method: string, work: () => Promise<T>): Promise<T> {
  if (method === 'GET') return work();
  listWrites++;
  return work().finally(() => { listWrites++; });
}

/** The next list() is a real request: an external event (reconnect, revocation) may postdate the cache. */
export function forgetSharedTaskList(): void {
  listCache = null;
}

/** Main-owned adapter. Tokens remain inside the existing authenticated HTTP client. */
const accountApi = createSharedTaskApi({
  captureScope() {
    const key = activeOwnerScopeKey();
    const endpoint = getClientEndpoint('deviceLinkApiBaseUrl');
    const selection = agentNetSelectionKey();
    const assertCallerCurrent = callerGuard.getStore();
    return { isCurrent: () => {
      assertCallerCurrent?.();
      return getAuthState().isAuthenticated && !isAppSessionBoundaryPending() &&
        activeOwnerScopeKey() === key && getClientEndpoint('deviceLinkApiBaseUrl') === endpoint && agentNetSelectionKey() === selection;
    } };
  },
  async request(path, options) {
    try {
      return await trackListWrite(options.method, async () => {
        const legacy = (timeoutMs = 15_000) => {
          if (!agentNetAllowsLegacy()) throwIpcError('DEVICE_LINK_NOT_CONNECTED', 'Encrypted sharing route required');
          return serverApiFetch<unknown>(path, {
        method: options.method,
        body: options.body,
        // Executed before EACH physical attempt, including automatic token refresh.
        // A new account/region cannot submit an old invitation or moderation action.
        baseUrl: () => {
          if (!options.isCurrent()) throw new SharedTaskScopeChangedError();
          return getClientEndpoint('deviceLinkApiBaseUrl');
        },
        timeoutMs,
        cache: 'no-store',
        logLabel: '/api/device-link/shared-tasks',
        redactErrorDetails: true,
        allowedRedactedErrorCodes: ['NOT_FOUND', 'CONFLICT', 'PERMISSION_DENIED', 'INVALID_PARAMS', 'RATE_LIMITED',
          'SHARED_TASK_HOST_LIMIT', 'SHARED_TASK_JOIN_LIMIT', 'SHARED_TASK_GUEST_LIMIT', 'SHARED_TASK_SELF_JOIN'],
        }); };
        if (path === '/api/device-link/shared-tasks') {
          if (options.method === 'GET') {
            const value = await listAgentNetSharedTasks(() => legacy(1500)); return value ?? legacy();
          }
          const selected = selectedAgentNetSharingRoute('shared-task');
          if (selected) {
            rememberAgentNetSharingService(selected);
            const value = await requestAgentNetSharing(selected, path, options) as { sharedTaskId?: unknown };
            if (options.isCurrent() && typeof value.sharedTaskId === 'string') rememberAgentNetSharingHost('shared-task', value.sharedTaskId, selected);
            return value;
          }
          if (isAgentNetActive()) throwIpcError('DEVICE_LINK_NOT_CONNECTED', 'Agent-Net is not ready');
        }
        const match = /^\/api\/device-link\/shared-tasks\/([^/]+)/.exec(path);
        const route = match && match[1] !== 'join' ? agentNetSharingRoute('shared-task', decodeURIComponent(match[1])) : null;
        if (!route) return legacy();
        const value = await requestAgentNetSharing(route, path, options);
        if (path.endsWith('/leave')) retireAgentNetSharingGuest('shared-task', route.resourceId);
        return value;
      });
    } catch (error) {
      const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
      if (code === 'SHARED_TASK_HOST_LIMIT' || code === 'SHARED_TASK_JOIN_LIMIT' || code === 'SHARED_TASK_GUEST_LIMIT') {
        throwIpcError(code, 'Shared task limit reached');
      }
      // Error properties do not survive Electron serialization. Preserve only
      // actionable codes, never the server response or invitation details.
      if (code === 'NOT_FOUND' || code === 'PERMISSION_DENIED' || code === 'INVALID_PARAMS' || code === 'SHARED_TASK_SELF_JOIN') {
        throwIpcError(code, 'Shared task request rejected');
      }
      if (code === 'NETWORK_ERROR') throwIpcError('DEVICE_LINK_NOT_CONNECTED', 'Shared task service unreachable');
      throw error;
    }
  },
});

export const sharedTaskApi = {
  ...accountApi,
  list(): Promise<SharedTaskListItem[]> {
    // A tool's recovery query needs fresh authority and must not share its input guard with UI/background reads.
    if (callerGuard.getStore()) return accountApi.list();
    // Signed-out or boundary callers fail inside the adapter, never from cache.
    if (!getAuthState().isAuthenticated || isAppSessionBoundaryPending()) return accountApi.list();
    const key = [activeOwnerScopeKey(), getActiveAuthRealm(), getClientEndpoint('deviceLinkApiBaseUrl'), agentNetSelectionKey()].join('\n');
    const cached = listCache;
    // A negative age means the clock moved backwards; treat that list as stale.
    const age = cached?.settledAt == null ? 0 : Date.now() - cached.settledAt;
    if (cached && cached.key === key && cached.writes === listWrites && age >= 0 && age < LIST_REUSE_MS) return cached.result;
    const entry: NonNullable<typeof listCache> = { key, writes: listWrites, settledAt: null, result: accountApi.list() };
    listCache = entry;
    entry.result.then(() => { entry.settledAt = Date.now(); }, () => { if (listCache === entry) listCache = null; });
    return entry.result;
  },
  async invite(sharedTaskId: string) {
    const endpoint = getClientEndpoint('deviceLinkApiBaseUrl');
    const result = await accountApi.invite(sharedTaskId);
    // Keep the bare token for older controlling clients; new clients copy the link.
    const region = import.meta.env.VITE_CINDY_AUTH_REGION;
    const app = region === 'cn' ? 'cindycn' : region === 'dev' ? 'cindydev' : 'cindy';
    return { ...result, invitationLink: agentNetSharingInvitation('shared-task', sharedTaskId, result.invitation, app)
      ?? buildSharedTaskInvitationLink(result.invitation, endpoint, app) };
  },
  async join(input: string, _displayName: string) {
    const value = await joinAgentNetSharedTask(input, sharedTaskAccountName(getAuthState().user?.name));
    if (value) { forgetSharedTaskList(); return value; }
    const parsed = parseSharedTaskInvitation(input, getClientEndpoint('deviceLinkApiBaseUrl'));
    if (!parsed.ok) throwIpcError(parsed.reason === 'different-server' ? 'REGION_MISMATCH' : 'INVALID_PARAMS', 'Invalid shared task invitation or service mismatch');
    return accountApi.join(parsed.invitation, sharedTaskAccountName(getAuthState().user?.name));
  },
};

/** Capture only while the outgoing identity still owns the credentials. Unlike
 * ordinary requests, this close-only cleanup may cross the pending boundary:
 * its endpoint/token never refresh, and errors cannot log out the next account. */
export function captureSharedTaskBoundaryClose(ownerAccountId: string, region: ReturnType<typeof getActiveAuthRealm>) {
  if (getCurrentUserId() !== ownerAccountId || getActiveAuthRealm() !== region) return null;
  const token = getAccessToken();
  if (!token) return null;
  const endpoint = getClientEndpoint('deviceLinkApiBaseUrl');
  // Agent-Net close is an extra route, never a precondition for the handover:
  // a failure to capture it falls back to the legacy close and the journal retry.
  let closeV2: (sharedTaskId: string) => Promise<unknown> | null = () => null;
  try { closeV2 = captureAgentNetSharingBoundaryClose(token, getClientEndpoint('authApiBaseUrl')); }
  catch { /* The durable local-close journal still records the closure. */ }
  const api = createSharedTaskApi({
    captureScope: () => ({ isCurrent: () => true }),
    request: (path, options) => trackListWrite(options.method, () => serverApiFetch<unknown>(path, {
      method: options.method, body: options.body, token, baseUrl: endpoint,
      skipAutoRefresh: true, skipSessionInvalidation: true, timeoutMs: 3_000,
      cache: 'no-store', redactErrorDetails: true, logLabel: '/api/device-link/shared-tasks',
    })),
  });
  return (sharedTaskId: string) => closeV2(sharedTaskId) ?? api.close(sharedTaskId);
}
