/**
 * ghostOauthBroker 单测:XDT server 授权 broker 调用器的错误映射口径
 * (规则 14,deps 全假体,零 Electron / 零真网络)。
 * 核心回归面:登录层 401 与服务商拒绝 401 的区分——前者绝不能触发
 * invalidGrant(会连带作废用户的 refresh token)。
 */
import { describe, expect, it, vi } from 'vitest';

import { createGhostOauthBrokerClient, SUPPORTED_TOKEN_BROKERS } from '../ghostOauthBroker.js';

function apiError(code: string, statusCode: number, message = 'x'): Error {
  const err = new Error(message) as Error & { code: string; statusCode: number };
  err.code = code;
  err.statusCode = statusCode;
  return err;
}

describe('createGhostOauthBrokerClient', () => {
  it('exchange:POST 到 /api/integrations/<slug>/oauth/exchange 并映射 bundle', async () => {
    const apiPost = vi.fn(async (path: string, body: Record<string, unknown>) => {
      expect(path).toBe('/api/integrations/jira/oauth/exchange');
      expect(body).toEqual({ code: 'c1', redirectUri: 'http://127.0.0.1:53682/callback' });
      return { accessToken: 'at-1', refreshToken: 'rt-1', expiresIn: 3600, scope: 'read:jira-work' };
    });
    const client = createGhostOauthBrokerClient({ apiPost, hasLoginToken: () => true });
    const result = await client.exchange('jira', { code: 'c1', redirectUri: 'http://127.0.0.1:53682/callback' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bundle.accessToken).toBe('at-1');
      expect(result.bundle.refreshToken).toBe('rt-1');
      expect(result.bundle.grantedScope).toBe('read:jira-work');
      expect(result.bundle.expiresAt).toBeGreaterThan(Date.now());
    }
  });

  it('refresh:server 401 + 业务错误码(上游拒绝)→ invalidGrant:true', async () => {
    const client = createGhostOauthBrokerClient({
      apiPost: vi.fn(async () => {
        throw apiError('JIRA_OAUTH_FAILED', 401, 'upstream rejected');
      }),
      hasLoginToken: () => true,
    });
    await expect(client.refresh('jira', { refreshToken: 'rt-x' })).resolves.toMatchObject({
      ok: false,
      error: 'EXCHANGE_FAILED',
      invalidGrant: true,
    });
  });

  it('登录层 401(TOKEN_EXPIRED / UNAUTHORIZED / INVALID_TOKEN / USER_NOT_FOUND)与未知 401 码 → 绝不判 invalidGrant', async () => {
    // INVALID_TOKEN = server JWT secret 轮换 / 本地 token 损坏(authenticate 中间件),
    // 全员性登录层故障,误判 invalidGrant 会连带销毁所有人的第三方授权(review P1-1)。
    for (const code of ['TOKEN_EXPIRED', 'UNAUTHORIZED', 'INVALID_TOKEN', 'USER_NOT_FOUND', 'SOME_FUTURE_CODE']) {
      const client = createGhostOauthBrokerClient({
        apiPost: vi.fn(async () => {
          throw apiError(code, 401);
        }),
        hasLoginToken: () => true,
      });
      await expect(client.refresh('jira', { refreshToken: 'rt-x' })).resolves.toMatchObject({
        ok: false,
        invalidGrant: false,
      });
    }
  });

  it('未登录:不打请求,结构化提示先登录', async () => {
    const apiPost = vi.fn();
    const client = createGhostOauthBrokerClient({ apiPost, hasLoginToken: () => false });
    const result = await client.exchange('jira', { code: 'c', redirectUri: 'r' });
    expect(result).toMatchObject({ ok: false, error: 'EXCHANGE_FAILED', invalidGrant: false });
    if (!result.ok) expect(result.detail).toContain('登录');
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('网络不通(statusCode 0 / NETWORK_ERROR)→ NETWORK', async () => {
    const client = createGhostOauthBrokerClient({
      apiPost: vi.fn(async () => {
        throw apiError('NETWORK_ERROR', 0);
      }),
      hasLoginToken: () => true,
    });
    await expect(client.refresh('jira', { refreshToken: 'rt' })).resolves.toMatchObject({
      ok: false,
      error: 'NETWORK',
      invalidGrant: false,
    });
  });

  it('账号能力切换等非传输异常→ EXCHANGE_FAILED,不误报 NETWORK', async () => {
    const client = createGhostOauthBrokerClient({
      apiPost: vi.fn(async () => {
        throw Object.assign(new Error('[PRECONDITION_FAILED] app session is switching'), {
          code: 'PRECONDITION_FAILED',
        });
      }),
      hasLoginToken: () => true,
    });
    await expect(client.refresh('jira', { refreshToken: 'rt' })).resolves.toMatchObject({
      ok: false,
      error: 'EXCHANGE_FAILED',
      invalidGrant: false,
    });
  });

  it.each([
    ['HTTP_404', 404],
    ['INTERNAL_ERROR', 503],
  ])('broker 路由或服务不可用(%s / %i)→ SERVICE_UNAVAILABLE', async (code, statusCode) => {
    const client = createGhostOauthBrokerClient({
      apiPost: vi.fn(async () => {
        throw apiError(code, statusCode, 'upstream detail must stay in Main');
      }),
      hasLoginToken: () => true,
    });
    await expect(
      client.exchange('feishu', { code: 'c', redirectUri: 'http://127.0.0.1/callback' }),
    ).resolves.toEqual({
      ok: false,
      error: 'SERVICE_UNAVAILABLE',
      invalidGrant: false,
    });
  });

  it('未知 slug:不打请求直接拒;白名单认 feishu / jira(slack 已随意识退役)', async () => {
    expect(SUPPORTED_TOKEN_BROKERS.has('jira')).toBe(true);
    expect(SUPPORTED_TOKEN_BROKERS.has('feishu')).toBe(true);
    expect(SUPPORTED_TOKEN_BROKERS.has('slack')).toBe(false);
    const apiPost = vi.fn();
    const client = createGhostOauthBrokerClient({ apiPost, hasLoginToken: () => true });
    await expect(client.exchange('nope', { code: 'c', redirectUri: 'r' })).resolves.toMatchObject({
      ok: false,
      error: 'EXCHANGE_FAILED',
    });
    // 退役 slug 同样不放行、不打请求
    await expect(client.exchange('slack', { code: 'c', redirectUri: 'r' })).resolves.toMatchObject({
      ok: false,
      error: 'EXCHANGE_FAILED',
    });
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('feishu:401 + FEISHU_OAUTH_FAILED(上游拒绝)→ invalidGrant:true;未知 401 码 → false', async () => {
    const rejected = createGhostOauthBrokerClient({
      apiPost: vi.fn(async () => {
        throw apiError('FEISHU_OAUTH_FAILED', 401, 'feishu rejected');
      }),
      hasLoginToken: () => true,
    });
    await expect(rejected.refresh('feishu', { refreshToken: 'rt-x' })).resolves.toMatchObject({
      ok: false,
      error: 'EXCHANGE_FAILED',
      invalidGrant: true,
    });
    // 不认识的 401 码同样按登录层故障处理(fail-safe,不销毁授权)。
    const unknown = createGhostOauthBrokerClient({
      apiPost: vi.fn(async () => {
        throw apiError('SOME_FUTURE_CODE', 401);
      }),
      hasLoginToken: () => true,
    });
    await expect(unknown.refresh('feishu', { refreshToken: 'rt-x' })).resolves.toMatchObject({
      ok: false,
      invalidGrant: false,
    });
  });

  it('响应缺 accessToken → EXCHANGE_FAILED', async () => {
    const client = createGhostOauthBrokerClient({
      apiPost: vi.fn(async () => ({ refreshToken: 'rt-only' })),
      hasLoginToken: () => true,
    });
    await expect(client.exchange('jira', { code: 'c', redirectUri: 'r' })).resolves.toMatchObject({
      ok: false,
      error: 'EXCHANGE_FAILED',
    });
  });
});
