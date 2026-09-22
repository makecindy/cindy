import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ key: 'account:1', endpoint: 'https://relay.example.test', authenticated: true, boundary: false, accountId: 'owner', region: 'global', token: 'test-old-token' }));
const http = vi.hoisted(() => vi.fn());
vi.mock('../../appSessionState.js', () => ({ activeOwnerScopeKey: () => state.key, isAppSessionBoundaryPending: () => state.boundary }));
vi.mock('../../authManager.js', () => ({ getAuthState: () => ({ isAuthenticated: state.authenticated }),
  getCurrentUserId: () => state.accountId, getActiveAuthRealm: () => state.region, getAccessToken: () => state.token }));
vi.mock('../../clientEndpointsService.js', () => ({ getClientEndpoint: () => state.endpoint }));
vi.mock('../../serverApiClient.js', () => ({ serverApiFetch: http }));
import { captureSharedTaskBoundaryClose, sharedTaskApi } from '../sharedTaskApi.js';

beforeEach(() => {
  state.key = 'account:1'; state.endpoint = 'https://relay.example.test'; state.authenticated = true; state.boundary = false;
  state.accountId = 'owner'; state.region = 'global'; state.token = 'test-old-token';
  http.mockReset();
});
describe('sharedTask Main HTTP adapter', () => {
  it.each([['NOT_FOUND', 'NOT_FOUND'], ['PERMISSION_DENIED', 'PERMISSION_DENIED'],
    ['INVALID_PARAMS', 'INVALID_PARAMS'], ['NETWORK_ERROR', 'DEVICE_LINK_NOT_CONNECTED']])(
    'retains actionable %s across the Electron boundary without leaking details', async (code, ipcCode) => {
      http.mockRejectedValue(Object.assign(new Error('private invitation details'), { code }));
      const error = await sharedTaskApi.join('x'.repeat(43), 'Guest').catch((error: Error) => error);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('[' + ipcCode + ']');
      expect((error as Error).message).not.toContain('private invitation details');
    });
  it.each(['SHARED_TASK_HOST_LIMIT', 'SHARED_TASK_JOIN_LIMIT', 'SHARED_TASK_GUEST_LIMIT'])(
    'preserves %s through redaction and Electron error serialization', async (code) => {
      http.mockImplementation(async (_path, options) => {
        expect(options.allowedRedactedErrorCodes).toContain(code);
        throw Object.assign(new Error('private server details'), { code });
      });
      await expect(sharedTaskApi.create('session', 'Task')).rejects.toThrow('[' + code + '] Shared task limit reached');
    });
  it('closes across a pending logout with fixed old credentials and no auth side effects', async () => {
    state.boundary = true;
    const close = captureSharedTaskBoundaryClose('owner', 'global')!;
    state.accountId = 'new-owner'; state.region = 'cn';
    state.token = 'test-new-token'; state.endpoint = 'https://new-relay.example.test';
    http.mockResolvedValue({ sharedTaskId: 'sharedTask', status: 'closed' });
    await close('sharedTask');
    expect(http).toHaveBeenCalledExactlyOnceWith('/api/device-link/shared-tasks/sharedTask/close',
      expect.objectContaining({ token: 'test-old-token', baseUrl: 'https://relay.example.test',
        skipAutoRefresh: true, skipSessionInvalidation: true, timeoutMs: 3_000, redactErrorDetails: true }));
  });
  it('cannot capture another account or region, or a cleared credential', () => {
    expect(captureSharedTaskBoundaryClose('another', 'global')).toBeNull();
    expect(captureSharedTaskBoundaryClose('owner', 'cn')).toBeNull();
    state.token = '';
    expect(captureSharedTaskBoundaryClose('owner', 'global')).toBeNull();
    expect(http).not.toHaveBeenCalled();
  });
  it('uses a redacted, bounded request through the existing auth client', async () => {
    http.mockImplementation(async (_path, options) => {
      expect(options.baseUrl()).toBe(state.endpoint);
      expect(options).toMatchObject({ timeoutMs: 15_000, cache: 'no-store', redactErrorDetails: true, logLabel: '/api/device-link/shared-tasks' });
      return { sharedTaskId: 'sharedTask', status: 'closed' };
    });
    await expect(sharedTaskApi.close('sharedTask')).resolves.toMatchObject({ status: 'closed' });
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
    await expect(sharedTaskApi.close('sharedTask')).rejects.toThrow('account or region changed');
  });
  it('rejects late success when logout happens after sending', async () => {
    http.mockImplementation(async () => {
      state.authenticated = false;
      return { sharedTaskId: 'sharedTask', status: 'closed' };
    });
    await expect(sharedTaskApi.close('sharedTask')).rejects.toThrow('account or region changed');
  });
});
