/**
 * github-client HTTP 安全加固回归测试(2026-07 对外安全评估 P2)。
 *
 * github-client 包本身无测试基建,故在 @cindy/mcps(已有 vitest 且依赖该 client)覆盖:
 *  1. assertSafeBaseUrl:GitHub 侧默认强制 https(非 loopback http 拒绝),
 *     userinfo / 非 http(s) / 不可解析一律拒绝。
 *  2. fetchWithSafeRedirect:非 3xx 原样返回;同源 3xx 带凭据继续跟随;跨源 3xx
 *     fail-closed 抛错且**绝不**把 Authorization token 重放到另一个 host;超跳数抛错。
 *  3. 端到端:GithubClient.request() 遇跨 host 重定向时抛错,且 fetch 只打到原 host。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GithubClient,
  GithubApiError,
  assertSafeBaseUrl,
  fetchWithSafeRedirect,
} from '@cindy/github-client';

type RequestFn = (method: string, path: string, body?: unknown) => Promise<unknown>;
function rawRequest(c: GithubClient): RequestFn {
  return (c as unknown as { request: RequestFn }).request.bind(c);
}

/** 显式给 fetch mock 签名,让 spy.mock.calls[i] 是 [url, init] 元组(strict tsc)。 */
type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

afterEach(() => {
  vi.unstubAllGlobals();
});

// Unit: GitHub requires User-Agent to identify the calling application. Cover
// REST, GraphQL and download redirects, which have separate request builders.
it('identifies Cindy on each GitHub API transport without changing authentication', async () => {
  const sent: Headers[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    sent.push(new Headers(init?.headers));
    return String(url).endsWith('/zip')
      ? new Response(null, { status: 302, headers: { location: 'https://example.invalid/archive.zip' } })
      : new Response(JSON.stringify({ data: {}, login: 'fixture' }));
  };
  const client = new GithubClient({ token: 'fixture-token', owner: 'fixture', repo: 'fixture', fetchImpl });
  await client.getUser('fixture');
  await client.graphql('{ viewer { login } }');
  await client.getArtifactDownloadUrl(1);
  expect(sent).toHaveLength(3);
  for (const headers of sent) {
    expect(headers.get('user-agent')).toBe('Cindy (+https://cindy.app)');
    expect(headers.get('authorization')).toBe('Bearer fixture-token');
  }
});

describe('assertSafeBaseUrl (github, https enforced)', () => {
  it('accepts https (github.com + GHE) and loopback http', () => {
    expect(() => assertSafeBaseUrl('https://api.github.com')).not.toThrow();
    expect(() => assertSafeBaseUrl('https://ghe.example.com/api/v3')).not.toThrow();
    expect(() => assertSafeBaseUrl('http://localhost:3000')).not.toThrow();
  });

  it('rejects non-loopback http by default', () => {
    expect(() => assertSafeBaseUrl('http://ghe.internal.example/api/v3')).toThrow(/https/);
  });

  it('rejects userinfo, non-http(s) protocols and unparseable input', () => {
    expect(() => assertSafeBaseUrl('https://api.github.com@evil.example')).toThrow(/userinfo/);
    expect(() => assertSafeBaseUrl('ftp://api.github.com')).toThrow(/http/);
    expect(() => assertSafeBaseUrl('not a url')).toThrow(/invalid baseUrl/);
  });

  it('GithubClient constructor defaults to https api.github.com and rejects unsafe baseUrl', () => {
    expect(() => new GithubClient({ token: 't' })).not.toThrow();
    expect(() => new GithubClient({ token: 't', baseUrl: 'http://ghe.internal.example/api/v3' })).toThrow(/https/);
    expect(() => new GithubClient({ token: 't', baseUrl: 'https://x@evil.example' })).toThrow(/userinfo/);
  });
});

describe('fetchWithSafeRedirect', () => {
  it('returns non-3xx responses unchanged and forces manual redirect', async () => {
    const spy = vi.fn<FetchImpl>(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', spy);
    const res = await fetchWithSafeRedirect('https://api.github.com/user', {
      headers: { Authorization: 'Bearer SECRET' },
    });
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    expect((spy.mock.calls[0][1] as RequestInit).redirect).toBe('manual');
  });

  it('follows same-origin redirects and keeps credentials', async () => {
    const spy = vi
      .fn<FetchImpl>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 301,
          headers: { location: 'https://api.github.com/repos/new' },
        }),
      )
      .mockResolvedValueOnce(new Response('final', { status: 200 }));
    vi.stubGlobal('fetch', spy);
    const res = await fetchWithSafeRedirect('https://api.github.com/repos/old', {
      headers: { Authorization: 'Bearer SECRET' },
    });
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(2);
    for (const call of spy.mock.calls) {
      const init = call[1] as RequestInit;
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer SECRET');
    }
  });

  it('refuses cross-host redirects and never replays the token', async () => {
    const spy = vi.fn<FetchImpl>(async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://evil.example.com/steal' },
      }),
    );
    vi.stubGlobal('fetch', spy);
    await expect(
      fetchWithSafeRedirect('https://api.github.com/user', {
        headers: { Authorization: 'Bearer SECRET' },
      }),
    ).rejects.toThrow(/cross-host/);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe('https://api.github.com/user');
  });

  it('throws on too many redirects with last 3xx status', async () => {
    const spy = vi.fn<FetchImpl>(async () =>
      new Response(null, {
        status: 307,
        headers: { location: 'https://api.github.com/loop' },
      }),
    );
    vi.stubGlobal('fetch', spy);
    const err = await fetchWithSafeRedirect(
      'https://api.github.com/user', { headers: {} }, 1,
    ).catch(e => e);
    expect(err).toBeInstanceOf(GithubApiError);
    expect(err.message).toMatch(/too many redirects/);
    expect(err.status).toBe(307); // last 3xx status, not 0
    expect(spy).toHaveBeenCalledTimes(2); // hop 0,1 then bail
  });

  it('follows HTTP→HTTPS same-host upgrade redirect (loopback GHE dev)', async () => {
    const spy = vi
      .fn<FetchImpl>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 301,
          headers: { location: 'https://localhost:3000/api/v3/user' },
        }),
      )
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', spy);
    const res = await fetchWithSafeRedirect('http://localhost:3000/api/v3/user', {
      headers: { Authorization: 'Bearer SECRET' },
    });
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('refuses HTTPS→HTTP same-host downgrade redirect', async () => {
    const spy = vi.fn<FetchImpl>(async () =>
      new Response(null, {
        status: 301,
        headers: { location: 'http://api.github.com/user' },
      }),
    );
    vi.stubGlobal('fetch', spy);
    await expect(
      fetchWithSafeRedirect('https://api.github.com/user', {
        headers: { Authorization: 'Bearer SECRET' },
      }),
    ).rejects.toThrow(/cross-host/);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('GithubClient.request() end-to-end redirect safety', () => {
  it('throws GithubApiError on cross-host redirect, token not sent to evil host', async () => {
    const spy = vi.fn<FetchImpl>(async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://evil.example.com/steal' },
      }),
    );
    vi.stubGlobal('fetch', spy);
    const client = new GithubClient({ token: 'SECRET-TOKEN', owner: 'makecindy', repo: 'cindy' });
    await expect(rawRequest(client)('GET', '/user')).rejects.toBeInstanceOf(GithubApiError);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe('https://api.github.com/user');
  });
});
