import { createSessionMeetingApi, SessionMeetingScopeChangedError } from '@cindy/device-link';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import { getAccessToken, getActiveAuthRealm, getAuthState, getCurrentUserId } from '../authManager.js';
import { getClientEndpoint } from '../clientEndpointsService.js';
import { serverApiFetch } from '../serverApiClient.js';

/** Main-owned adapter. Tokens remain inside the existing authenticated HTTP client. */
export const sessionMeetingApi = createSessionMeetingApi({
  captureScope() {
    const key = activeOwnerScopeKey();
    const endpoint = getClientEndpoint('deviceLinkApiBaseUrl');
    return { isCurrent: () => getAuthState().isAuthenticated && !isAppSessionBoundaryPending() &&
      activeOwnerScopeKey() === key && getClientEndpoint('deviceLinkApiBaseUrl') === endpoint };
  },
  request(path, options) {
    return serverApiFetch<unknown>(path, {
      method: options.method,
      body: options.body,
      // Executed before EACH physical attempt, including automatic token refresh.
      // A new account/region cannot submit an old invitation or moderation action.
      baseUrl: () => {
        if (!options.isCurrent()) throw new SessionMeetingScopeChangedError();
        return getClientEndpoint('deviceLinkApiBaseUrl');
      },
      timeoutMs: 15_000,
      cache: 'no-store',
      logLabel: '/api/device-link/meetings',
      redactErrorDetails: true,
      allowedRedactedErrorCodes: ['NOT_FOUND', 'CONFLICT', 'PERMISSION_DENIED', 'INVALID_PARAMS', 'RATE_LIMITED'],
    });
  },
});

/** Capture only while the outgoing identity still owns the credentials. Unlike
 * ordinary requests, this close-only cleanup may cross the pending boundary:
 * its endpoint/token never refresh, and errors cannot log out the next account. */
export function captureSessionMeetingBoundaryClose(ownerAccountId: string, region: ReturnType<typeof getActiveAuthRealm>) {
  if (getCurrentUserId() !== ownerAccountId || getActiveAuthRealm() !== region) return null;
  const token = getAccessToken();
  if (!token) return null;
  const endpoint = getClientEndpoint('deviceLinkApiBaseUrl');
  const api = createSessionMeetingApi({
    captureScope: () => ({ isCurrent: () => true }),
    request: (path, options) => serverApiFetch<unknown>(path, {
      method: options.method, body: options.body, token, baseUrl: endpoint,
      skipAutoRefresh: true, skipSessionInvalidation: true, timeoutMs: 3_000,
      cache: 'no-store', redactErrorDetails: true, logLabel: '/api/device-link/meetings',
    }),
  });
  return (meetingId: string) => api.close(meetingId);
}
