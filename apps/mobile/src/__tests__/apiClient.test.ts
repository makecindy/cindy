import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { i18n } from '@/i18n';
import { setMobileDebugSink } from '@/debug/mobileDebugLog';
import { serializeMobileDebugRecord } from '@/debug/mobileDebugRecord';
import {
  ApiError,
  apiFetchRaw,
  registerAccountUnavailableHandler,
} from '@/api/client';

// 文案已 i18n 化;固定 zh-CN 让字面量断言与语言环境解耦(全局 mock 默认 en-US)。
beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});

describe('apiFetchRaw', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    setMobileDebugSink(undefined);
  });

  it.each([
    { response: new Response('private response body'), logged: 'SyntaxError' },
    { response: { ok: true, status: 200,
      json: async () => { throw new TypeError('response stream closed'); } }, logged: 'response stream closed' },
  ])(
    'rejects a failed successful-response body and logs its cause without body excerpts: $logged', async ({ response, logged }) => {
      const logs: string[] = [];
      setMobileDebugSink((level, scope, args) => { logs.push(serializeMobileDebugRecord(level, scope, args)); });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
      await expect(apiFetchRaw('/api/resource', { baseUrl: 'https://api.example.invalid' }))
        .rejects.toMatchObject({ code: 'INVALID_RESPONSE', status: 200 });
      expect(logs.join('')).toContain(logged);
      expect(logs.join('')).not.toContain('private response body');
    },
  );

  it('logs the original transport cause through the existing redactor before mapping the UI error', async () => {
    const logs: string[] = [];
    setMobileDebugSink((level, scope, args) => { logs.push(serializeMobileDebugRecord(level, scope, args)); });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Network request failed', {
      cause: new Error('proxy rejected CONNECT https://api.example.invalid/?key=private-key'),
    })));
    await expect(apiFetchRaw('/api/resource', { baseUrl: 'https://api.example.invalid' }))
      .rejects.toMatchObject({ code: 'NETWORK_UNAVAILABLE' });
    expect(logs.join('')).toContain('proxy rejected CONNECT');
    expect(logs.join('')).not.toContain('private-key');
  });

  it('still accepts an explicitly empty 204 response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    await expect(apiFetchRaw('/api/resource', { baseUrl: 'https://api.example.invalid' })).resolves.toBeNull();
  });

  it('sends extra headers without letting them replace auth or content type', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) });
    vi.stubGlobal('fetch', fetch);
    await apiFetchRaw('/v1/preferences', { baseUrl: 'https://chat.example.invalid', token: 'tok',
      headers: { 'X-Chat-Actor': 'actor-1', Authorization: 'Bearer other', 'Content-Type': 'text/plain' } });
    expect(fetch.mock.calls[0]![1].headers).toMatchObject({ 'X-Chat-Actor': 'actor-1', Authorization: 'Bearer tok', 'Content-Type': 'application/json' });
  });

  it('classifies RN offline failures as a typed NETWORK_UNAVAILABLE ApiError (中文文案,可被重试层识别)', async () => {
    // RN 离线时 fetch 抛 TypeError("Network request failed")——不含 "fetch" 子串,
    // 历史实现匹配不到,英文原文一路透传到 UI。
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Network request failed')));

    const err = await apiFetchRaw('/api/auth/login', { baseUrl: 'https://auth.example.invalid' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('NETWORK_UNAVAILABLE');
    expect((err as ApiError).message).toContain('网络连接不可用');
    // 非 web 环境不追加 CORS 提示
    expect((err as ApiError).message).not.toContain('CORS');
  });

  it('turns browser fetch failures into an actionable local-dev message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    // Web 预览环境(存在 document)才附加 CORS 排查提示
    vi.stubGlobal('document', {});

    const err = await apiFetchRaw('/api/auth/login', { baseUrl: 'https://auth.example.invalid' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('NETWORK_UNAVAILABLE');
    expect((err as ApiError).message).toContain('Web 预览可能被浏览器 CORS 拦截');
  });

  it('allows device-link calls to target a split relay base URL', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ devices: [] }),
    } as Response));
    vi.stubGlobal('fetch', fetchMock);

    await expect(apiFetchRaw('/api/device-link/devices', {
      baseUrl: 'https://relay.example.com',
      token: 'access-token',
    })).resolves.toEqual({ devices: [] });

    expect(fetchMock).toHaveBeenCalledWith('https://relay.example.com/api/device-link/devices', expect.objectContaining({
      method: 'GET',
      headers: {
        Authorization: 'Bearer access-token',
        'Content-Type': 'application/json',
      },
      body: undefined,
    }));
  });

  it('passes no-store to fetch and HTTP cache directives for native transports', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ iceServers: [], expiresAt: null }),
    } as Response));
    vi.stubGlobal('fetch', fetchMock);
    await apiFetchRaw('/api/device-link/ice-servers', {
      baseUrl: 'https://relay.example.com',
      token: 'access-token',
      cache: 'no-store',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://relay.example.com/api/device-link/ice-servers',
      expect.objectContaining({
        cache: 'no-store',
        headers: {
          Authorization: 'Bearer access-token',
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache, no-store',
          Pragma: 'no-cache',
        },
      }),
    );
  });

  it('aborts hung requests instead of leaving the UI in a connecting state', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
      });
    }));
    vi.stubGlobal('fetch', fetchMock);

    const request = apiFetchRaw('/api/device-link/devices', {
      baseUrl: 'https://relay.example.com',
      timeoutMs: 100,
    });

    const assertion = expect(request).rejects.toMatchObject({
      code: 'REQUEST_TIMEOUT',
      status: 0,
      message: '请求超时，请稍后重试',
    });
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
  });

  it('keeps the timeout active while a response body is still being parsed', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"devices":'));
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const request = apiFetchRaw('/api/device-link/devices', {
      baseUrl: 'https://relay.example.com',
      timeoutMs: 100,
    });

    const assertion = expect(request).rejects.toMatchObject({
      code: 'REQUEST_TIMEOUT',
      status: 0,
    });
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
  });

  it('parses top-level device-link relay errors', async () => {
    const logs: string[] = [];
    setMobileDebugSink((level, scope, args) => { logs.push(serializeMobileDebugRecord(level, scope, args)); });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 403,
      json: async () => ({ code: 'REMOTE_DISABLED', message: 'remote disabled',
        details: { reason: 'private server details' } }),
    } as Response)));

    await expect(apiFetchRaw('/api/device-link/devices', {
      baseUrl: 'https://relay.example.com',
    })).rejects.toMatchObject({
      code: 'REMOTE_DISABLED',
      status: 403,
      message: 'remote disabled',
      details: { reason: 'private server details' },
    });
    expect(logs).toEqual([]);
  });

  it('notifies the terminal auth boundary for ACCOUNT_UNAVAILABLE', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const dispose = registerAccountUnavailableHandler(handler);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            ok: false,
            status: 401,
            json: async () => ({
              error: {
                code: 'ACCOUNT_UNAVAILABLE',
                message: 'account unavailable',
              },
            }),
          }) as Response,
      ),
    );

    try {
      await expect(
        apiFetchRaw('/api/resource', {
          baseUrl: 'https://resource.example.com',
          token: 'access-token',
        }),
      ).rejects.toMatchObject({
        code: 'ACCOUNT_UNAVAILABLE',
        status: 401,
      });
      expect(handler).toHaveBeenCalledTimes(1);
    } finally {
      dispose();
    }
  });
});
