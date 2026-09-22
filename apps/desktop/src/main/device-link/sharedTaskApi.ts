import { createSharedTaskApi, SharedTaskScopeChangedError } from '@cindy/device-link';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import { getAccessToken, getActiveAuthRealm, getAuthState, getCurrentUserId } from '../authManager.js';
import { getClientEndpoint } from '../clientEndpointsService.js';
import { serverApiFetch } from '../serverApiClient.js';
import { throwIpcError } from '../utils/ipcValidate.js';

/** Main-owned adapter. Tokens remain inside the existing authenticated HTTP client. */
export const sharedTaskApi = createSharedTaskApi({
  captureScope() {
    const key = activeOwnerScopeKey();
    const endpoint = getClientEndpoint('deviceLinkApiBaseUrl');
    return { isCurrent: () => getAuthState().isAuthenticated && !isAppSessionBoundaryPending() &&
      activeOwnerScopeKey() === key && getClientEndpoint('deviceLinkApiBaseUrl') === endpoint };
  },
  async request(path, options) {
    try {
      return await serverApiFetch<unknown>(path, {
        method: options.method,
        body: options.body,
        // Executed before EACH physical attempt, including automatic token refresh.
        // A new account/region cannot submit an old invitation or moderation action.
        baseUrl: () => {
          if (!options.isCurrent()) throw new SharedTaskScopeChangedError();
          return getClientEndpoint('deviceLinkApiBaseUrl');
        },
        timeoutMs: 15_000,
        cache: 'no-store',
        logLabel: '/api/device-link/shared-tasks',
        redactErrorDetails: true,
        allowedRedactedErrorCodes: ['NOT_FOUND', 'CONFLICT', 'PERMISSION_DENIED', 'INVALID_PARAMS', 'RATE_LIMITED',
          'SHARED_TASK_HOST_LIMIT', 'SHARED_TASK_JOIN_LIMIT', 'SHARED_TASK_GUEST_LIMIT'],
      });
    } catch (error) {
      const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
      if (code === 'SHARED_TASK_HOST_LIMIT' || code === 'SHARED_TASK_JOIN_LIMIT' || code === 'SHARED_TASK_GUEST_LIMIT') {
        throwIpcError(code, 'Shared task limit reached');
      }
      // Error properties do not survive Electron serialization. Preserve only
      // actionable codes, never the server response or invitation details.
      if (code === 'NOT_FOUND' || code === 'PERMISSION_DENIED' || code === 'INVALID_PARAMS') {
        throwIpcError(code, 'Shared task request rejected');
      }
      if (code === 'NETWORK_ERROR') throwIpcError('DEVICE_LINK_NOT_CONNECTED', 'Shared task service unreachable');
      throw error;
    }
  },
});

/** Capture only while the outgoing identity still owns the credentials. Unlike
 * ordinary requests, this close-only cleanup may cross the pending boundary:
 * its endpoint/token never refresh, and errors cannot log out the next account. */
export function captureSharedTaskBoundaryClose(ownerAccountId: string, region: ReturnType<typeof getActiveAuthRealm>) {
  if (getCurrentUserId() !== ownerAccountId || getActiveAuthRealm() !== region) return null;
  const token = getAccessToken();
  if (!token) return null;
  const endpoint = getClientEndpoint('deviceLinkApiBaseUrl');
  const api = createSharedTaskApi({
    captureScope: () => ({ isCurrent: () => true }),
    request: (path, options) => serverApiFetch<unknown>(path, {
      method: options.method, body: options.body, token, baseUrl: endpoint,
      skipAutoRefresh: true, skipSessionInvalidation: true, timeoutMs: 3_000,
      cache: 'no-store', redactErrorDetails: true, logLabel: '/api/device-link/shared-tasks',
    }),
  });
  return (sharedTaskId: string) => api.close(sharedTaskId);
}
