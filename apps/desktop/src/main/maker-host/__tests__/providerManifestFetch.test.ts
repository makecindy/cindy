/**
 * provider-manifest-fetch 单测：URL 复核、超时 / 重定向 / 非 2xx / 超限 / 非 JSON 的
 * 结构化失败、fail-closed 内容校验透传，以及成功路径的 origin 与 preset.id 命名空间
 * 重写。fetch 注入不联网（模式同 providerModelFetch.test.ts）。
 */

import { describe, it, expect, vi } from 'vitest';

import { fetchProviderManifest } from '../provider-manifest-fetch.js';

const MANIFEST_URL = 'https://gateway.example.com/.well-known/cindy-provider.json';

const VALID_MANIFEST_TEXT = JSON.stringify({
  id: 'acme-gateway',
  name: 'Acme Gateway',
  runtimes: {
    'claude-code': {
      baseUrl: 'https://gateway.example.com',
      modelsUrl: 'https://gateway.example.com/v1/models',
      models: [{ id: 'acme-large', name: 'Acme Large' }],
    },
  },
});

function fakeResponse(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

describe('fetchProviderManifest — URL 复核', () => {
  it('rejects non-https / credentialed / malformed URLs without fetching', async () => {
    const fetchImpl = vi.fn();
    for (const url of [
      'http://gateway.example.com/m.json',
      'https://u:p@gateway.example.com/m.json',
      'not a url',
      '',
    ]) {
      expect(await fetchProviderManifest(url, fetchImpl)).toEqual({
        ok: false,
        reason: 'invalid-url',
      });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('fetchProviderManifest — 网络 / 响应层失败', () => {
  it('classifies timeout aborts', async () => {
    const fetchImpl = vi.fn(async () => {
      const err = new Error('operation timed out');
      err.name = 'TimeoutError';
      throw err;
    });
    expect(await fetchProviderManifest(MANIFEST_URL, fetchImpl as unknown as typeof fetch)).toEqual(
      { ok: false, reason: 'timeout' },
    );
  });

  it('classifies redirect: error hits (undici wraps them into TypeError)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') });
    });
    expect(await fetchProviderManifest(MANIFEST_URL, fetchImpl as unknown as typeof fetch)).toEqual(
      { ok: false, reason: 'redirect' },
    );
  });

  it('rejects 3xx responses defensively when the impl does not throw', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(null, { status: 302, headers: { location: 'https://elsewhere.example' } }),
    );
    expect(await fetchProviderManifest(MANIFEST_URL, fetchImpl as unknown as typeof fetch)).toEqual(
      { ok: false, reason: 'redirect' },
    );
  });

  it('classifies other network failures', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }) });
    });
    expect(await fetchProviderManifest(MANIFEST_URL, fetchImpl as unknown as typeof fetch)).toEqual(
      { ok: false, reason: 'network' },
    );
  });

  it('returns http-status with the status code for non-2xx responses', async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(404, 'not found'));
    expect(await fetchProviderManifest(MANIFEST_URL, fetchImpl as unknown as typeof fetch)).toEqual(
      { ok: false, reason: 'http-status', status: 404 },
    );
  });

  it('rejects oversized bodies', async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(200, 'x'.repeat(64 * 1024 + 1)));
    expect(await fetchProviderManifest(MANIFEST_URL, fetchImpl as unknown as typeof fetch)).toEqual(
      { ok: false, reason: 'oversize' },
    );
  });
});

describe('fetchProviderManifest — 内容校验与成功路径', () => {
  it('passes fail-closed parse rejections through as the failure reason', async () => {
    const cases: [string, string][] = [
      ['not json {', 'invalid-json'],
      [JSON.stringify({ id: 'a', name: 'A', runtimes: {}, extra: 1 }), 'unknown-root-field'],
      [
        JSON.stringify({
          id: 'a',
          name: 'A',
          runtimes: {
            codex: { baseUrl: 'https://x.example', models: [], headers: { h: 'v' } },
          },
        }),
        'forbidden-runtime-field',
      ],
    ];
    for (const [body, reason] of cases) {
      const fetchImpl = vi.fn(async () => fakeResponse(200, body));
      expect(
        await fetchProviderManifest(MANIFEST_URL, fetchImpl as unknown as typeof fetch),
      ).toEqual({ ok: false, reason });
    }
  });

  it('returns the manifest origin and rewrites preset.id into the manifest:<host> namespace', async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(200, VALID_MANIFEST_TEXT));
    const result = await fetchProviderManifest(MANIFEST_URL, fetchImpl as unknown as typeof fetch);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.origin).toBe('https://gateway.example.com');
    // 重写后的 id 含 `:`——永不与 catalog preset id / 内置 provider id / 本机检测特例碰撞。
    expect(result.preset.id).toBe('manifest:gateway.example.com');
    expect(result.preset.name).toBe('Acme Gateway');
    expect(result.preset.runtimes['claude-code']?.baseUrl).toBe('https://gateway.example.com');
    // 请求形态：GET + redirect: 'error' + 超时信号。
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe('GET');
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
