import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ key: 'account:1', endpoint: 'https://relay.example.test', authenticated: true, boundary: false, accountId: 'owner', region: 'global', token: 'test-old-token' }));
const http = vi.hoisted(() => vi.fn());
vi.mock('../../appSessionState.js', () => ({ activeOwnerScopeKey: () => state.key, isAppSessionBoundaryPending: () => state.boundary }));
vi.mock('../../authManager.js', () => ({ getAuthState: () => ({ isAuthenticated: state.authenticated }),
  getCurrentUserId: () => state.accountId, getActiveAuthRealm: () => state.region, getAccessToken: () => state.token }));
vi.mock('../../clientEndpointsService.js', () => ({ getClientEndpoint: () => state.endpoint }));
vi.mock('../../serverApiClient.js', () => ({ serverApiFetch: http }));
import { captureSessionMeetingBoundaryClose, sessionMeetingApi } from '../sessionMeetingApi.js';

beforeEach(() => {
  state.key = 'account:1'; state.endpoint = 'https://relay.example.test'; state.authenticated = true; state.boundary = false;
  state.accountId = 'owner'; state.region = 'global'; state.token = 'test-old-token';
  http.mockReset();
});
describe('meeting Main HTTP adapter', () => {
  it('closes across a pending logout with fixed old credentials and no auth side effects', async () => {
    state.boundary = true;
    const close = captureSessionMeetingBoundaryClose('owner', 'global')!;
    state.accountId = 'new-owner'; state.region = 'cn';
    state.token = 'test-new-token'; state.endpoint = 'https://new-relay.example.test';
    http.mockResolvedValue({ meetingId: 'meeting', status: 'closed' });
    await close('meeting');
    expect(http).toHaveBeenCalledExactlyOnceWith('/api/device-link/meetings/meeting/close',
      expect.objectContaining({ token: 'test-old-token', baseUrl: 'https://relay.example.test',
        skipAutoRefresh: true, skipSessionInvalidation: true, timeoutMs: 3_000, redactErrorDetails: true }));
  });
  it('cannot capture another account or region, or a cleared credential', () => {
    expect(captureSessionMeetingBoundaryClose('another', 'global')).toBeNull();
    expect(captureSessionMeetingBoundaryClose('owner', 'cn')).toBeNull();
    state.token = '';
    expect(captureSessionMeetingBoundaryClose('owner', 'global')).toBeNull();
    expect(http).not.toHaveBeenCalled();
  });
  it('uses a redacted, bounded request through the existing auth client', async () => {
    http.mockImplementation(async (_path, options) => {
      expect(options.baseUrl()).toBe(state.endpoint);
      expect(options).toMatchObject({ timeoutMs: 15_000, cache: 'no-store', redactErrorDetails: true, logLabel: '/api/device-link/meetings' });
      return { meetingId: 'meeting', status: 'closed' };
    });
    await expect(sessionMeetingApi.close('meeting')).resolves.toMatchObject({ status: 'closed' });
  });
  it.each(['account', 'region', 'logout', 'boundary'])('blocks a retry after %s changes', async (change) => {
    http.mockImplementation(async (_path, options) => {
      expect(options.baseUrl()).toBe(state.endpoint);
      if (change === 'account') state.key = 'account:2';
      if (change === 'region') state.endpoint = 'https://other-relay.example.test';
      if (change === 'logout') state.authenticated = false;
      if (change === 'boundary') state.boundary = true;
      return { endpoint: options.baseUrl() };
    });
    await expect(sessionMeetingApi.close('meeting')).rejects.toThrow('account or region changed');
  });
  it('rejects late success when logout happens after sending', async () => {
    http.mockImplementation(async () => {
      state.authenticated = false;
      return { meetingId: 'meeting', status: 'closed' };
    });
    await expect(sessionMeetingApi.close('meeting')).rejects.toThrow('account or region changed');
  });
});
