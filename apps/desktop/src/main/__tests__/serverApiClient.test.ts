/**
 * serverApiClient retry contract: auth refresh may switch memberships, so
 * dynamic request bodies must be rebuilt together with the refreshed token.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  netFetch: vi.fn(),
  getAccessToken: vi.fn(),
  refresh: vi.fn(),
  invalidateSession: vi.fn(),
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('electron', () => ({ net: { fetch: mocks.netFetch } }));
vi.mock('../authManager', () => ({
  getAccessToken: mocks.getAccessToken,
  refresh: mocks.refresh,
  invalidateSession: mocks.invalidateSession,
}));
vi.mock('../logger', () => ({
  createLogger: () => mocks.logger,
}));

import { serverApiFetch } from '../serverApiClient';

describe('serverApiFetch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('TOKEN_EXPIRED refresh 后用新 token 和重新生成的 body 重试', async () => {
    mocks.getAccessToken.mockReturnValueOnce('token-a').mockReturnValueOnce('token-b');
    mocks.refresh.mockResolvedValue(true);
    mocks.netFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ error: { code: 'TOKEN_EXPIRED' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      });
    const bodyFactory = vi
      .fn<() => { userName: string }>()
      .mockReturnValueOnce({ userName: 'Account A' })
      .mockReturnValueOnce({ userName: 'Account B' });

    await expect(
      serverApiFetch('/api/github/issues', {
        method: 'POST',
        bodyFactory,
        baseUrl: 'https://github-api.example.com',
      }),
    ).resolves.toEqual({ ok: true });

    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(bodyFactory).toHaveBeenCalledTimes(2);
    expect(mocks.netFetch).toHaveBeenNthCalledWith(
      1,
      'https://github-api.example.com/api/github/issues',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer token-a' }),
        body: JSON.stringify({ userName: 'Account A' }),
      }),
    );
    expect(mocks.netFetch).toHaveBeenNthCalledWith(
      2,
      'https://github-api.example.com/api/github/issues',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer token-b' }),
        body: JSON.stringify({ userName: 'Account B' }),
      }),
    );
  });

  it('ACCOUNT_UNAVAILABLE 不 refresh，直接完整退登', async () => {
    mocks.getAccessToken.mockReturnValue('token-a');
    mocks.invalidateSession.mockResolvedValue(undefined);
    mocks.netFetch.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: { code: 'ACCOUNT_UNAVAILABLE' } }),
    });

    await expect(
      serverApiFetch('/api/resource', {
        baseUrl: 'https://resource.example.com',
      }),
    ).rejects.toMatchObject({
      code: 'ACCOUNT_UNAVAILABLE',
      statusCode: 401,
    });

    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.invalidateSession).toHaveBeenCalledWith('account-unavailable');
  });

  it.each(['INVALID_TOKEN', 'UNAUTHORIZED'])('%s refresh 一次后重试', async (code) => {
    mocks.getAccessToken.mockReturnValueOnce('token-a').mockReturnValueOnce('token-b');
    mocks.refresh.mockResolvedValue(true);
    mocks.netFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ error: { code } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      });

    await expect(
      serverApiFetch('/api/resource', {
        baseUrl: 'https://resource.example.com',
      }),
    ).resolves.toEqual({ ok: true });
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.invalidateSession).not.toHaveBeenCalled();
  });

  it('refresh 后仍返回可恢复 401 时完整退登', async () => {
    mocks.getAccessToken.mockReturnValue('token-a');
    mocks.refresh.mockResolvedValue(true);
    mocks.invalidateSession.mockResolvedValue(undefined);
    mocks.netFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ error: { code: 'TOKEN_EXPIRED' } }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ error: { code: 'UNAUTHORIZED' } }),
      });

    await expect(
      serverApiFetch('/api/resource', {
        baseUrl: 'https://resource.example.com',
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED', statusCode: 401 });
    expect(mocks.invalidateSession).toHaveBeenCalledWith('resource-unauthorized-after-refresh');
  });

  it.each([
    { name: '403', response: { ok: false, status: 403, json: async () => ({}) } },
    { name: 'network failure', response: new Error('offline') },
  ])('$name 不触发退登', async ({ response }) => {
    mocks.getAccessToken.mockReturnValue('token-a');
    if (response instanceof Error) mocks.netFetch.mockRejectedValue(response);
    else mocks.netFetch.mockResolvedValue(response);

    await expect(
      serverApiFetch('/api/resource', {
        baseUrl: 'https://resource.example.com',
      }),
    ).rejects.toBeTruthy();
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.invalidateSession).not.toHaveBeenCalled();
  });

  it('redacted requests do not persist upstream messages, bodies, or network errors', async () => {
    mocks.getAccessToken.mockReturnValue('token-a');
    mocks.netFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 502,
        json: async () => ({
          error: {
            code: 'PROVIDER_PRIVATE_FAILURE',
            message: 'merchant private response body',
          },
        }),
      })
      .mockRejectedValueOnce(new Error('network URL contained private detail'));

    await expect(
      serverApiFetch('/api/billing/orders/order-1', {
        baseUrl: 'https://model-access.example.com',
        redactErrorDetails: true,
      }),
    ).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      statusCode: 502,
      message: '请求失败 (502)',
    });
    await expect(
      serverApiFetch('/api/billing/orders/order-1', {
        baseUrl: 'https://model-access.example.com',
        redactErrorDetails: true,
      }),
    ).rejects.toBeTruthy();

    const logged = JSON.stringify({
      error: mocks.logger.error.mock.calls,
      warn: mocks.logger.warn.mock.calls,
    });
    expect(logged).not.toContain('PROVIDER_PRIVATE_FAILURE');
    expect(logged).not.toContain('merchant private response body');
    expect(logged).not.toContain('private detail');
    expect(logged).not.toContain('order-1');
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      'serverApiFetch.redacted_not_ok',
      'path=/api/billing/orders',
      'method=GET',
      'status=502',
      'code=INTERNAL_ERROR',
    );
    expect(mocks.logger.error).toHaveBeenCalledWith(
      'serverApiFetch.redacted_network_error',
      'path=/api/billing/orders',
      'method=GET',
    );
  });

  it('surfaces only explicitly allowed business codes on redacted requests', async () => {
    mocks.getAccessToken.mockReturnValue('token-a');
    mocks.netFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: async () => ({
          error: {
            code: 'PLAN_CHANGE_NOT_AVAILABLE',
            message: 'private subscription detail',
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: async () => ({
          error: {
            code: 'PRIVATE_SUBSCRIPTION_STATE',
            message: 'another private subscription detail',
          },
        }),
      });

    await expect(
      serverApiFetch('/api/billing/subscription/plan-change-quotes', {
        baseUrl: 'https://model-access.example.com',
        redactErrorDetails: true,
        allowedRedactedErrorCodes: ['PLAN_CHANGE_NOT_AVAILABLE'],
      }),
    ).rejects.toMatchObject({
      code: 'PLAN_CHANGE_NOT_AVAILABLE',
      statusCode: 409,
      message: '请求失败 (409)',
    });
    await expect(
      serverApiFetch('/api/billing/subscription/plan-change-quotes', {
        baseUrl: 'https://model-access.example.com',
        redactErrorDetails: true,
        allowedRedactedErrorCodes: ['PLAN_CHANGE_NOT_AVAILABLE'],
      }),
    ).rejects.toMatchObject({
      code: 'HTTP_409',
      statusCode: 409,
      message: '请求失败 (409)',
    });

    const logged = JSON.stringify(mocks.logger.warn.mock.calls);
    expect(logged).not.toContain('private subscription detail');
    expect(logged).not.toContain('PRIVATE_SUBSCRIPTION_STATE');
  });
});
