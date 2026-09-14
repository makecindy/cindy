/**
 * networkSlot · OAuth 凭证注入(source:'oauth')单测。独立文件(不并入
 * networkSlot.test.ts):覆盖 access token 现取注入、authAccount 透传、
 * 结构化错误折叠成人话、401 作废重刷整链重试一次、令牌不回流沙箱。
 */
import { describe, expect, it, vi } from 'vitest';

import { GhostNetworkSlot, type NetworkSlotDeps } from '../networkSlot';
import type { GhostNetworkNeeds, InstalledGhost } from '../../../shared/ghost';

const HOSTS = ['api.example.com', 'accounts.example.com'];

function oauthGhost(): InstalledGhost {
  const network: GhostNetworkNeeds = {
    hosts: HOSTS,
    secrets: [
      {
        key: 'acct',
        label: 'Example 账号',
        source: 'oauth',
        inject: { header: 'Authorization', format: 'Bearer {value}', hosts: ['api.example.com'] },
        oauth: {
          authorizeUrl: 'https://accounts.example.com/authorize',
          tokenUrl: 'https://accounts.example.com/token',
          scopes: ['read.a'],
        },
      },
    ],
  };
  return {
    manifest: {
      schemaVersion: 2,
      id: 'g-oauth',
      name: 'OAuth 意识',
      version: '1.0.0',
      kind: 'chip',
      entry: 'main.js',
      tools: [{ name: 't', description: 'x' }],
      network,
    },
    dir: '/fake/brain/g-oauth',
    enabled: true,
  } as InstalledGhost;
}

function fakeResponse(status = 200, body = '{"ok":1}'): Response {
  const buf = new TextEncoder().encode(body).buffer;
  return {
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    arrayBuffer: async () => buf,
  } as unknown as Response;
}

function makeSlot(params: {
  fetchImpl?: ReturnType<typeof vi.fn>;
  oauthTokens?: NetworkSlotDeps['oauthTokens'];
}): { slot: GhostNetworkSlot; fetchImpl: ReturnType<typeof vi.fn> } {
  const fetchImpl = params.fetchImpl ?? vi.fn(async () => fakeResponse());
  const deps: NetworkSlotDeps = {
    getGhost: () => oauthGhost(),
    readSecret: () => null,
    getLoginEmail: () => null,
    fetchImpl: fetchImpl as unknown as NetworkSlotDeps['fetchImpl'],
    fetchPublicImpl: async () => ({ response: fakeResponse(), release: async () => undefined }),
    saveGhostMedia: async () => ({ url: 'cindy-media://blobs/a.png', hash: 'a'.repeat(64), ext: '.png' }),
    isSupportedMediaMime: () => false,
    readGhostMedia: async () => null,
    takeDirDeposit: () => null,
    writeSaveDeposit: async () => null,
    oauthTokens: params.oauthTokens,
  };
  return { slot: new GhostNetworkSlot(deps), fetchImpl };
}

const API_URL = 'https://api.example.com/v1/data';

describe('networkSlot · oauth 凭证注入', () => {
  it('现取 access token 注入 Authorization;accountId 缺省不传', async () => {
    const getFreshAccessToken = vi.fn(async () => ({ ok: true as const, accessToken: 'at-live', accountId: 'acc-1' }));
    const { slot, fetchImpl } = makeSlot({
      oauthTokens: { getFreshAccessToken, invalidateAccessToken: vi.fn() },
    });

    const r = await slot.handleFetchRequest('g-oauth', { type: 'fetch-request', url: API_URL });
    expect(r.ok).toBe(true);
    expect(getFreshAccessToken).toHaveBeenCalledWith('g-oauth', 'acct', expect.objectContaining({
      tokenUrl: 'https://accounts.example.com/token',
    }), undefined);
    const [, init] = fetchImpl.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers.Authorization).toBe('Bearer at-live');
    // 令牌不回流沙箱(响应体是服务端 JSON,不含令牌)。
    if (r.ok && 'body' in r) expect(String((r as { body?: string }).body ?? '')).not.toContain('at-live');
  });

  it('authAccount 透传给令牌管理器;形状非法拒单', async () => {
    const getFreshAccessToken = vi.fn(async () => ({ ok: true as const, accessToken: 'at', accountId: 'acc-2' }));
    const { slot } = makeSlot({
      oauthTokens: { getFreshAccessToken, invalidateAccessToken: vi.fn() },
    });
    const ok = await slot.handleFetchRequest('g-oauth', { type: 'fetch-request', url: API_URL, authAccount: 'acc-2' });
    expect(ok.ok).toBe(true);
    expect(getFreshAccessToken).toHaveBeenCalledWith('g-oauth', 'acct', expect.anything(), 'acc-2');

    expect((await slot.handleFetchRequest('g-oauth', { url: API_URL, authAccount: '' })).ok).toBe(false);
    expect((await slot.handleFetchRequest('g-oauth', { url: API_URL, authAccount: 'x'.repeat(65) })).ok).toBe(false);
  });

  it('管理器结构化错误折叠成人话(NO_ACCOUNT / AUTH_EXPIRED / NO_CLIENT_CONFIG),不发请求', async () => {
    for (const [error, keyword] of [
      ['NO_CLIENT_CONFIG', '客户端凭证'],
      ['NO_ACCOUNT', '连接账号'],
      ['AUTH_EXPIRED', '重新连接'],
    ] as const) {
      const { slot, fetchImpl } = makeSlot({
        oauthTokens: {
          getFreshAccessToken: vi.fn(async () => ({ ok: false as const, error })),
          invalidateAccessToken: vi.fn(),
        },
      });
      const r = await slot.handleFetchRequest('g-oauth', { type: 'fetch-request', url: API_URL });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toContain(keyword);
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it('oauthTokens 未接线 → 快速失败(主机 bug 不静默)', async () => {
    const { slot, fetchImpl } = makeSlot({ oauthTokens: undefined });
    const r = await slot.handleFetchRequest('g-oauth', { type: 'fetch-request', url: API_URL });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('未就绪');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('上游 401 → 作废该账号缓存重刷,整链重试一次;第二次 401 原样回', async () => {
    let tokenSeq = 0;
    const getFreshAccessToken = vi.fn(async () => ({
      ok: true as const,
      accessToken: `at-${++tokenSeq}`,
      accountId: 'acc-1',
    }));
    const invalidateAccessToken = vi.fn();
    // 第一单 401,重试后 200。
    const fetchImpl = vi.fn(async () => (fetchImpl.mock.calls.length <= 1 ? fakeResponse(401, '{"e":1}') : fakeResponse()));
    const { slot } = makeSlot({ fetchImpl, oauthTokens: { getFreshAccessToken, invalidateAccessToken } });

    const r = await slot.handleFetchRequest('g-oauth', { type: 'fetch-request', url: API_URL });
    expect(r.ok).toBe(true);
    expect(invalidateAccessToken).toHaveBeenCalledWith('g-oauth', 'acct', 'acc-1');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [, init2] = fetchImpl.mock.calls[1] as unknown as [string, { headers: Record<string, string> }];
    expect(init2.headers.Authorization).toBe('Bearer at-2');

    // 一直 401:只重试一次,最终把 401 原样回给意识。
    const always401 = vi.fn(async () => fakeResponse(401, '{"e":1}'));
    const { slot: slot2 } = makeSlot({
      fetchImpl: always401,
      oauthTokens: { getFreshAccessToken, invalidateAccessToken },
    });
    const r2 = await slot2.handleFetchRequest('g-oauth', { type: 'fetch-request', url: API_URL });
    expect(always401).toHaveBeenCalledTimes(2);
    expect(r2.ok).toBe(true);
    if (r2.ok) expect((r2 as { status?: number }).status).toBe(401);
  });

  it('凭证只流向 inject.hosts 声明域名(accounts 域名不带 Authorization)', async () => {
    const getFreshAccessToken = vi.fn(async () => ({ ok: true as const, accessToken: 'at', accountId: 'acc-1' }));
    const { slot, fetchImpl } = makeSlot({
      oauthTokens: { getFreshAccessToken, invalidateAccessToken: vi.fn() },
    });
    const r = await slot.handleFetchRequest('g-oauth', {
      type: 'fetch-request',
      url: 'https://accounts.example.com/some-page',
    });
    expect(r.ok).toBe(true);
    const [, init] = fetchImpl.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers.Authorization).toBeUndefined();
    expect(getFreshAccessToken).not.toHaveBeenCalled();
  });
});
