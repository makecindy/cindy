/**
 * provider-manifest-fetch 单测：URL 复核、SSRF 守卫拒绝 / 超时 / 重定向 / 非 2xx /
 * 声明与流式双重大小限量 / 非 JSON 的结构化失败、fail-closed 内容校验透传，以及
 * 成功路径的 origin 与 preset.id 命名空间重写。guardedFetch 注入不联网
 * （模式同 publicImageFetch / providerModelFetch.test.ts）。
 */

import { describe, it, expect, vi } from 'vitest';

import {
  fetchProviderManifest,
  type GuardedManifestFetch,
} from '../provider-manifest-fetch.js';

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

function guardedResponse(status: number, body: string | ReadableStream<Uint8Array>, headers?: Record<string, string>) {
  const release = vi.fn(async () => undefined);
  const guardedFetch = vi.fn(async () => ({
    response: new Response(body, {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    }),
    finalUrl: MANIFEST_URL,
    release,
  }));
  return { guardedFetch: guardedFetch as unknown as GuardedManifestFetch, release, mock: guardedFetch };
}

function guardedThrow(err: Error) {
  return vi.fn(async () => {
    throw err;
  }) as unknown as GuardedManifestFetch;
}

describe('fetchProviderManifest — URL 复核', () => {
  it('rejects non-https / credentialed / malformed URLs without fetching', async () => {
    const guardedFetch = vi.fn();
    for (const url of [
      'http://gateway.example.com/m.json',
      'https://u:p@gateway.example.com/m.json',
      'not a url',
      '',
    ]) {
      expect(
        await fetchProviderManifest(url, guardedFetch as unknown as GuardedManifestFetch),
      ).toEqual({ ok: false, reason: 'invalid-url' });
    }
    expect(guardedFetch).not.toHaveBeenCalled();
  });
});

describe('fetchProviderManifest — 守卫 / 响应层失败', () => {
  it('classifies timeout aborts', async () => {
    const err = new Error('operation timed out');
    err.name = 'TimeoutError';
    expect(await fetchProviderManifest(MANIFEST_URL, guardedThrow(err))).toEqual({
      ok: false,
      reason: 'timeout',
    });
  });

  it('classifies SSRF-blocked targets (loopback / private / rebound DNS)', async () => {
    const err = new Error('Blocked: resolves to private/internal/special-use IP address');
    err.name = 'SsrFBlockedError';
    expect(await fetchProviderManifest(MANIFEST_URL, guardedThrow(err))).toEqual({
      ok: false,
      reason: 'blocked-address',
    });
  });

  it('classifies redirects rejected by maxRedirects=0', async () => {
    expect(
      await fetchProviderManifest(MANIFEST_URL, guardedThrow(new Error('Too many redirects (>0)'))),
    ).toEqual({ ok: false, reason: 'redirect' });
  });

  it('rejects 3xx responses defensively when the guard returns them', async () => {
    const { guardedFetch, release } = guardedResponse(302, '', { location: 'https://elsewhere.example' });
    expect(await fetchProviderManifest(MANIFEST_URL, guardedFetch)).toEqual({
      ok: false,
      reason: 'redirect',
    });
    expect(release).toHaveBeenCalled();
  });

  it('classifies other network failures', async () => {
    expect(
      await fetchProviderManifest(
        MANIFEST_URL,
        guardedThrow(Object.assign(new Error('socket hang up'), { name: 'FetchError' })),
      ),
    ).toEqual({ ok: false, reason: 'network' });
  });

  it('returns http-status with the status code for non-2xx responses', async () => {
    const { guardedFetch } = guardedResponse(404, 'not found');
    expect(await fetchProviderManifest(MANIFEST_URL, guardedFetch)).toEqual({
      ok: false,
      reason: 'http-status',
      status: 404,
    });
  });

  it('rejects an oversized declared Content-Length before reading the body', async () => {
    const { guardedFetch } = guardedResponse(200, VALID_MANIFEST_TEXT, {
      'content-length': String(10 * 1024 * 1024),
    });
    expect(await fetchProviderManifest(MANIFEST_URL, guardedFetch)).toEqual({
      ok: false,
      reason: 'oversize',
    });
  });

  it('cancels the stream and rejects once the cumulative body exceeds the cap', async () => {
    // 无 Content-Length 的流式超大响应:读到 64 KiB 即取消,不整段入内存。
    let pulls = 0;
    const chunk = new Uint8Array(16 * 1024);
    const cancel = vi.fn();
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(chunk);
      },
      cancel,
    });
    const { guardedFetch } = guardedResponse(200, endless);
    expect(await fetchProviderManifest(MANIFEST_URL, guardedFetch)).toEqual({
      ok: false,
      reason: 'oversize',
    });
    expect(cancel).toHaveBeenCalled();
    // 只读了刚超限的几片(64 KiB / 16 KiB ≈ 5 次上下),不是无限吞流。
    expect(pulls).toBeLessThan(10);
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
      const { guardedFetch } = guardedResponse(200, body);
      expect(await fetchProviderManifest(MANIFEST_URL, guardedFetch)).toEqual({
        ok: false,
        reason,
      });
    }
  });

  it('returns the manifest origin and rewrites preset.id into the manifest:<host> namespace', async () => {
    const { guardedFetch, release, mock } = guardedResponse(200, VALID_MANIFEST_TEXT);
    const result = await fetchProviderManifest(MANIFEST_URL, guardedFetch);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.origin).toBe('https://gateway.example.com');
    // 重写后的 id 含 `:`——永不与 catalog preset id / 内置 provider id / 本机检测特例碰撞。
    expect(result.preset.id).toBe('manifest:gateway.example.com');
    expect(result.preset.name).toBe('Acme Gateway');
    expect(result.preset.runtimes['claude-code']?.baseUrl).toBe('https://gateway.example.com');
    // 请求形态:https 强制 + 拒绝重定向 + 超时信号;守卫连接资源已释放。
    const [params] = mock.mock.calls[0] as unknown as [
      { requireHttps: boolean; maxRedirects: number; signal: AbortSignal },
    ];
    expect(params.requireHttps).toBe(true);
    expect(params.maxRedirects).toBe(0);
    expect(params.signal).toBeInstanceOf(AbortSignal);
    expect(release).toHaveBeenCalled();
  });
});
