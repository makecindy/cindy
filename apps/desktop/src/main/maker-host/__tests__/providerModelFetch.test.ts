/**
 * provider-model-fetch 单测：URL 推导（modelsUrl 优先 / baseUrl 推导）、cc vs codex 鉴权头、
 * 响应三形状解析（{data} / {models} / 字符串数组）与错误分类。fetch 注入不联网
 * （模式同 providerDiagnostics.test.ts）。
 */

import { describe, it, expect, vi } from 'vitest';

import {
  buildModelsFetchRequest,
  fetchProviderModels,
  type ProviderModelsFetchSpec,
} from '../provider-model-fetch.js';

function spec(over: Partial<ProviderModelsFetchSpec> = {}): ProviderModelsFetchSpec {
  return { agent: 'claude-code', baseUrl: 'https://api.acme.example/anthropic', apiKey: 'sk-test', ...over };
}

function fakeResponse(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

describe('buildModelsFetchRequest', () => {
  it('derives {base}/v1/models for non-/vN baseUrl; appends /models when baseUrl ends with /vN', () => {
    expect(buildModelsFetchRequest(spec()).url).toBe('https://api.acme.example/anthropic/v1/models');
    expect(
      buildModelsFetchRequest(spec({ agent: 'codex', baseUrl: 'https://openrouter.ai/api/v1' })).url,
    ).toBe('https://openrouter.ai/api/v1/models');
  });

  it('preserves base URL query parameters while appending the discovery pathname', () => {
    expect(
      buildModelsFetchRequest(
        spec({ agent: 'codex', baseUrl: 'https://openrouter.ai/api/v1?tenant=a#ignored' }),
      ).url,
    ).toBe('https://openrouter.ai/api/v1/models?tenant=a');
  });

  it('explicit modelsUrl wins over derivation only when same-host as baseUrl', () => {
    // 同主机（Moonshot 形态：baseUrl …/anthropic，列模型在同 host 的 /v1/models）→ 采用。
    expect(
      buildModelsFetchRequest(
        spec({ baseUrl: 'https://api.moonshot.cn/anthropic', modelsUrl: 'https://api.moonshot.cn/v1/models' }),
      ).url,
    ).toBe('https://api.moonshot.cn/v1/models');
    // 跨主机（用户改了 baseUrl、快照仍指旧主机）→ 忽略隐藏字段，回退 baseUrl 推导，防 key 误投。
    expect(
      buildModelsFetchRequest(spec({ modelsUrl: 'https://api.moonshot.cn/v1/models' })).url,
    ).toBe('https://api.acme.example/anthropic/v1/models');
  });

  it('cc wire sends anthropic-version + x-api-key + Bearer; codex wire sends Bearer only', () => {
    const cc = buildModelsFetchRequest(spec({
      headers: {
        Authorization: 'Bearer stale',
        'X-API-Key': 'stale',
        'x-extra': '1',
      },
    })).init.headers as Record<string, string>;
    expect(cc['anthropic-version']).toBe('2023-06-01');
    expect(cc['x-api-key']).toBe('sk-test');
    expect(cc['authorization']).toBe('Bearer sk-test');
    expect(cc.Authorization).toBeUndefined();
    expect(cc['X-API-Key']).toBeUndefined();
    expect(cc['x-extra']).toBe('1');

    const codex = buildModelsFetchRequest(spec({ agent: 'codex' })).init.headers as Record<string, string>;
    expect(codex['anthropic-version']).toBeUndefined();
    expect(codex['x-api-key']).toBeUndefined();
    expect(codex['authorization']).toBe('Bearer sk-test');
  });

  it('omits auth headers without apiKey and keeps custom headers', () => {
    const h = buildModelsFetchRequest(spec({ apiKey: null, headers: { 'x-extra': '1' } })).init
      .headers as Record<string, string>;
    expect(h['x-api-key']).toBeUndefined();
    expect(h['authorization']).toBeUndefined();
    expect(h['x-extra']).toBe('1');
  });

  it.each(['none', 'oauth'] as const)(
    'strips legacy credential headers for %s auth even without an apiKey',
    (authMethod) => {
      const h = buildModelsFetchRequest(spec({
        authMethod,
        apiKey: null,
        headers: {
          Authorization: 'Bearer legacy',
          'X-API-Key': 'legacy',
          'x-extra': '1',
        },
      })).init.headers as Record<string, string>;

      expect(h.Authorization).toBeUndefined();
      expect(h['X-API-Key']).toBeUndefined();
      expect(h.authorization).toBeUndefined();
      expect(h['x-api-key']).toBeUndefined();
      expect(h['x-extra']).toBe('1');
    },
  );
});

describe('fetchProviderModels', () => {
  it.each([
    {
      baseUrl: 'https://remote.example/v1',
      modelsUrl: null,
    },
    {
      baseUrl: 'http://127.0.0.1:4000/v1',
      modelsUrl: 'https://remote.example/v1/models',
    },
  ])('returns a structured failure for non-loopback no-auth discovery: %j', async (urls) => {
    const fetchImpl = vi.fn<typeof fetch>();
    const result = await fetchProviderModels(
      spec({
        ...urls,
        authMethod: 'none',
        apiKey: null,
      }),
      fetchImpl,
    );

    expect(result).toEqual({
      ok: false,
      code: 'UNKNOWN',
      detail: 'no-auth provider model discovery requires loopback URLs',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('parses OpenAI {data:[{id}]} shape, preferring display_name/name for labels', async () => {
    const r = await fetchProviderModels(spec(), async () =>
      fakeResponse(
        200,
        JSON.stringify({
          data: [
            { id: 'kimi-k3', display_name: 'Kimi K3' },
            { id: 'kimi-k2.6', name: 'Kimi K2.6' },
            { id: 'kimi-k2.6' }, // 重复 id 去重
            { id: 'bare-id' },
          ],
        }),
      ),
    );
    expect(r.ok).toBe(true);
    expect(r.models).toEqual([
      { id: 'kimi-k3', name: 'Kimi K3' },
      { id: 'kimi-k2.6', name: 'Kimi K2.6' },
      { id: 'bare-id', name: 'bare-id' },
    ]);
  });

  it('parses {models:[...]} and plain string-array shapes', async () => {
    const a = await fetchProviderModels(spec(), async () =>
      fakeResponse(200, JSON.stringify({ models: [{ id: 'm1' }] })),
    );
    expect(a.models).toEqual([{ id: 'm1', name: 'm1' }]);

    const b = await fetchProviderModels(spec(), async () =>
      fakeResponse(200, JSON.stringify({ data: ['m1', 'm2'] })),
    );
    expect(b.models).toEqual([
      { id: 'm1', name: 'm1' },
      { id: 'm2', name: 'm2' },
    ]);
  });

  it('classifies 401 as AUTH_INVALID with status', async () => {
    const r = await fetchProviderModels(spec(), async () =>
      fakeResponse(401, JSON.stringify({ error: { message: 'invalid api key' } })),
    );
    expect(r).toMatchObject({ ok: false, code: 'AUTH_INVALID', status: 401 });
  });

  it('classifies network failure as UPSTREAM_UNREACHABLE', async () => {
    const r = await fetchProviderModels(spec(), async () => {
      throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    });
    expect(r).toMatchObject({ ok: false, code: 'UPSTREAM_UNREACHABLE' });
  });

  it('returns non-ok UNKNOWN for 200 with unrecognized / empty payload', async () => {
    const empty = await fetchProviderModels(spec(), async () => fakeResponse(200, JSON.stringify({ data: [] })));
    expect(empty).toMatchObject({ ok: false, code: 'UNKNOWN' });
    const weird = await fetchProviderModels(spec(), async () => fakeResponse(200, '"not-a-list"'));
    expect(weird).toMatchObject({ ok: false, code: 'UNKNOWN' });
    const notJson = await fetchProviderModels(spec(), async () => fakeResponse(200, '<html>'));
    expect(notJson).toMatchObject({ ok: false, code: 'UNKNOWN' });
  });

  it('end-to-end asserts the request URL and auth headers reach fetch', async () => {
    let seenUrl = '';
    let seenHeaders: Record<string, string> = {};
    await fetchProviderModels(
      spec({ baseUrl: 'https://api.moonshot.cn/anthropic', modelsUrl: 'https://api.moonshot.cn/v1/models' }),
      async (url, init) => {
        seenUrl = String(url);
        seenHeaders = (init?.headers ?? {}) as Record<string, string>;
        return fakeResponse(200, JSON.stringify({ data: [{ id: 'kimi-k3' }] }));
      },
    );
    expect(seenUrl).toBe('https://api.moonshot.cn/v1/models');
    expect(seenHeaders['x-api-key']).toBe('sk-test');
    expect(seenHeaders['anthropic-version']).toBe('2023-06-01');
  });
});
