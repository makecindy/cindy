// Test value: preparePluginShare exposes only validated public material and keeps
// anonymous reads separate from account-bound attribution (scope contract).
// Existing install/deep-link suites do not exercise this IPC business entry.
// Minimal failures include malformed material, an expired token and an owner
// switch during refresh; unit fakes avoid Electron, external HTTP and accounts.
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  endpoint: vi.fn(),
  fetch: vi.fn(),
  state: vi.fn(),
  realm: vi.fn(),
  token: vi.fn(),
  refresh: vi.fn(),
  region: 'global',
}));
vi.mock('../../authManager.js', () => ({
  getAuthState: mocks.state,
  getActiveAuthRealm: mocks.realm,
  getAccessToken: mocks.token,
  refresh: mocks.refresh,
}));
vi.mock('../../clientEndpointsService.js', () => ({
  getBuildClientEndpoint: mocks.endpoint,
}));
vi.mock('../../../shared/brandRegion.js', () => ({
  get CURRENT_CINDY_REGION() {
    return mocks.region;
  },
}));
vi.mock('../../serverApiClient.js', () => ({
  serverApiFetch: mocks.fetch,
  ServerApiError: class extends Error {
    constructor(public readonly code: string, public readonly statusCode: number, message: string) {
      super(message);
    }
  },
}));
vi.mock('../../utils/ipcValidate.js', () => ({
  throwIpcError: (code: string) => {
    throw new Error(code);
  },
}));
import { preparePluginShare } from '../sharing';
import { isIpcErrorCode } from '../../../shared/ipc-errors';
import { extractIpcError } from '../../../shared/ipcError';
import { ServerApiError } from '../../serverApiClient';
const pluginId = 'c123456789012345678901234';
const shareId = 's'.repeat(32);
const expiredError = new ServerApiError('TOKEN_EXPIRED', 401, 'Fixture token expired');
const response = {
  schemaVersion: 1,
  kind: 'plugin',
  shareId,
  includeAttribution: false,
  url: `https://share.example.test/s/${shareId}`,
  imageSvg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
  plugin: {
    schemaVersion: 1,
    pluginId,
    name: 'Example',
    description: null,
    author: null,
    version: '1.0.0',
    publishedAt: '2026-10-15T00:00:00.000Z',
  },
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.region = 'global';
  mocks.realm.mockReturnValue('global');
  mocks.token.mockReturnValue('fixture-access-token');
  mocks.refresh.mockResolvedValue(true);
  mocks.endpoint.mockReturnValue('https://share.example.test');
  mocks.fetch.mockResolvedValue(response);
  mocks.state.mockReturnValue({
    ownerGeneration: 1,
    mode: 'cloud',
    isAuthenticated: true,
    user: { id: 'fixture-member' },
  });
});
describe('public sharing preparation', () => {
  it.each(['SHARE_NOT_CONFIGURED', 'SHARE_UNAVAILABLE', 'SHARE_READ_FAILED'])(
    'preserves %s across Electron error serialization',
    (code) => {
      expect(isIpcErrorCode(code)).toBe(true);
      expect(
        extractIpcError(new Error(`Error invoking remote method: Error: [${code}] Failed`))?.code,
      ).toBe(code);
    },
  );
  it('creates anonymous shares without credentials or identity refresh', async () => {
    expect(await preparePluginShare(pluginId)).toEqual({
      title: 'Example',
      url: response.url,
      imageSvg: response.imageSvg,
    });
    expect(mocks.fetch).toHaveBeenCalledWith(
      '/api/shares',
      expect.objectContaining({
        method: 'POST',
        body: { kind: 'plugin', reference: pluginId, includeAttribution: false, region: 'global', lang: 'en' },
        token: null,
        skipAutoRefresh: true,
        skipSessionInvalidation: true,
        cache: 'no-store',
      }),
    );
    expect(mocks.token).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
  it.each(['cn', 'dev'])(
    'keeps %s creation in Chinese with a clean returned link',
    async (region) => {
      mocks.region = region;
      const url = `https://share.example.test/s/${shareId}`;
      mocks.fetch.mockResolvedValue({ ...response, url });
      expect((await preparePluginShare(pluginId)).url).toBe(url);
      expect(mocks.fetch).toHaveBeenCalledWith(
        '/api/shares',
        expect.objectContaining({
          token: null,
          body: { kind: 'plugin', reference: pluginId, includeAttribution: false, region: 'cn', lang: 'zh-CN' },
        }),
      );
    },
  );
  it.each(['?region=cn', '?lang=zh-CN'])('rejects a returned link with unexpected query %s', async (query) => {
    mocks.fetch.mockResolvedValue({
      ...response,
      url: `${response.url}${query}`,
    });
    await expect(preparePluginShare(pluginId)).rejects.toThrow('SHARE_READ_FAILED');
  });
  it('rejects a foreign landing origin', async () => {
    mocks.fetch.mockResolvedValue({ ...response, url: 'https://attacker.example.test' });
    await expect(preparePluginShare(pluginId)).rejects.toThrow('SHARE_READ_FAILED');
  });
  it('does not make a request before sharing is configured', async () => {
    mocks.endpoint.mockReturnValue('');
    await expect(preparePluginShare(pluginId)).rejects.toThrow('SHARE_NOT_CONFIGURED');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it('rejects arbitrary URLs before network access', async () => {
    await expect(preparePluginShare('https://example.test')).rejects.toThrow('INVALID_PARAMS');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it('requests a server-owned signed share using only the frozen current identity', async () => {
    mocks.fetch.mockResolvedValue({ ...response, includeAttribution: true, attribution: { displayName: 'Current nickname' } });
    const result = await preparePluginShare(pluginId, { includeAttribution: true });
    expect(result.attribution?.displayName).toBe('Current nickname');
    expect(mocks.fetch).toHaveBeenCalledWith('/api/shares', expect.objectContaining({
      token: 'fixture-access-token', skipAutoRefresh: true,
      body: { kind: 'plugin', reference: pluginId, includeAttribution: true, authRealm: 'global', region: 'global', lang: 'en' },
    }));
    expect(result.url).not.toContain('source=');
  });
  it('refreshes an expired signed share once and retries with the current token of the same owner', async () => {
    mocks.fetch.mockRejectedValueOnce(expiredError)
      .mockResolvedValueOnce({ ...response, includeAttribution: true });
    mocks.refresh.mockImplementationOnce(async () => {
      mocks.token.mockReturnValue('fixture-refreshed-token');
      return true;
    });
    expect((await preparePluginShare(pluginId, { includeAttribution: true })).url).toBe(response.url);
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(mocks.fetch.mock.calls[0]?.[1]).toMatchObject({
      token: 'fixture-access-token', allowedRedactedErrorCodes: ['TOKEN_EXPIRED'],
    });
    expect(mocks.fetch.mock.calls[1]?.[1]).toMatchObject({
      token: 'fixture-refreshed-token', skipAutoRefresh: true, skipSessionInvalidation: true,
      body: { includeAttribution: true, authRealm: 'global' },
    });
  });
  it('does not retry again if the refreshed signed request is rejected', async () => {
    mocks.fetch.mockRejectedValue(expiredError);
    await expect(preparePluginShare(pluginId, { includeAttribution: true })).rejects.toThrow('SHARE_READ_FAILED');
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });
  it.each([
    [false, 'TOKEN_EXPIRED', 401],
    [true, 'UNAUTHORIZED', 401],
    [true, 'ACCOUNT_UNAVAILABLE', 401],
    [true, 'TOKEN_EXPIRED', 503],
  ] as const)('does not refresh for attribution=%s, code=%s, status=%s', async (includeAttribution, code, status) => {
    mocks.fetch.mockRejectedValueOnce(new ServerApiError(code, status, 'Fixture request rejected'));
    await expect(preparePluginShare(pluginId, { includeAttribution })).rejects.toThrow('SHARE_READ_FAILED');
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
  it('does not refresh another account when the owner changes before the first rejection', async () => {
    mocks.fetch.mockImplementationOnce(async () => {
      mocks.state.mockReturnValue({ ownerGeneration: 2, mode: 'cloud', isAuthenticated: true, user: { id: 'other-member' } });
      throw expiredError;
    });
    await expect(preparePluginShare(pluginId, { includeAttribution: true })).rejects.toThrow('SHARE_READ_FAILED');
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
  it.each(['owner', 'realm', 'logout'] as const)('stops the retry if %s changes during refresh', async (change) => {
    mocks.fetch.mockRejectedValueOnce(expiredError);
    mocks.refresh.mockImplementationOnce(async () => {
      if (change === 'realm') mocks.realm.mockReturnValue('cn');
      else if (change === 'logout') mocks.state.mockReturnValue({ ownerGeneration: 2, mode: 'signed-out', user: null });
      else mocks.state.mockReturnValue({ ownerGeneration: 2, mode: 'cloud', isAuthenticated: true, user: { id: 'other-member' } });
      mocks.token.mockReturnValue('fixture-other-owner-token');
      return true;
    });
    await expect(preparePluginShare(pluginId, { includeAttribution: true })).rejects.toThrow('SHARE_READ_FAILED');
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
  it('stops if login refresh fails', async () => {
    mocks.fetch.mockRejectedValueOnce(expiredError);
    mocks.refresh.mockResolvedValueOnce(false);
    await expect(preparePluginShare(pluginId, { includeAttribution: true })).rejects.toThrow('SHARE_READ_FAILED');
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
  it('does not send a signed retry without a token', async () => {
    mocks.fetch.mockRejectedValueOnce(expiredError);
    mocks.refresh.mockImplementationOnce(async () => {
      mocks.token.mockReturnValue(null);
      return true;
    });
    await expect(preparePluginShare(pluginId, { includeAttribution: true })).rejects.toThrow('SHARE_READ_FAILED');
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
  it('keeps the signed binding when the current profile cannot be displayed', async () => {
    mocks.fetch.mockResolvedValue({ ...response, includeAttribution: true });
    const result = await preparePluginShare(pluginId, { includeAttribution: true });
    expect(result.url).toBe(response.url);
    expect(result.attribution).toBeUndefined();
  });
  it('rejects invalid share identifiers and silently downgraded attribution', async () => {
    mocks.fetch.mockResolvedValue({ ...response, shareId: '../other', includeAttribution: true });
    await expect(preparePluginShare(pluginId, { includeAttribution: true })).rejects.toThrow('SHARE_READ_FAILED');
    mocks.fetch.mockResolvedValue(response);
    await expect(preparePluginShare(pluginId, { includeAttribution: true })).rejects.toThrow('SHARE_READ_FAILED');
  });
  it('rejects a result if the account changes while material is loading', async () => {
    mocks.fetch.mockImplementationOnce(async () => {
      mocks.state.mockReturnValue({ ownerGeneration: 2, mode: 'local', user: null });
      return response;
    });
    await expect(preparePluginShare(pluginId, { includeAttribution: true })).rejects.toThrow(
      'SHARE_READ_FAILED',
    );
  });
});
