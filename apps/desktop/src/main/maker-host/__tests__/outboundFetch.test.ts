import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Agent as UndiciAgent, Dispatcher, ProxyAgent } from 'undici';

import { Socks5HttpsAgent, TunnelingHttpsAgent } from '@cindy/anthropic-compat-proxy';

const resolverState = vi.hoisted(() => ({
  resolve: vi.fn<(url: string) => Promise<string | null>>(async () => null),
}));

const undiciState = vi.hoisted(() => ({
  fetch: vi.fn(async () => ({ ok: true, status: 200, headers: new Headers(), body: null })),
}));

/** 造一个 3xx 响应桩(带可取消的 body,验证我们会归还连接)。 */
function redirectResponse(status: number, location: string): {
  status: number;
  headers: Headers;
  body: { cancel: () => Promise<void> };
} {
  return {
    status,
    headers: new Headers({ location }),
    body: { cancel: async () => undefined },
  };
}

const loggerState = vi.hoisted(() => ({
  warn: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('../logger-adapter.js', () => ({
  createMakerLogger: () => ({
    trace: vi.fn(),
    debug: loggerState.debug,
    info: vi.fn(),
    warn: loggerState.warn,
    error: vi.fn(),
    child: vi.fn(),
    isDebugEnabled: () => false,
  }),
}));

vi.mock('../outbound-proxy-resolver.js', () => ({
  resolveDesktopOutboundProxy: (url: string) => resolverState.resolve(url),
}));

// 只替换 fetch:ProxyAgent / Agent 用真实类,断言才能验证选型。
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, fetch: (...args: unknown[]) => undiciState.fetch(...(args as [])) };
});

import {
  createOutboundHttpAgent,
  createPinnedProxyDispatcher,
  guardedOutboundFetch,
  outboundFetch,
  outboundUndiciFetch,
  resetOutboundFetchStateForTest,
  rewritePinnedProxyDispatchOptions,
  resolveConnectOptions,
  resolveOutboundDispatcher,
} from '../outbound-fetch.js';

/** 取包装 dispatcher 对某个目标 URL 实际选中的底层 dispatcher(重定向选路即走这条)。 */
function pick(dispatcher: unknown, url: string): unknown {
  return (dispatcher as { pickForUrlForTest(u: string): unknown }).pickForUrlForTest(url);
}

beforeEach(() => {
  resolverState.resolve.mockReset();
  resolverState.resolve.mockResolvedValue(null);
  undiciState.fetch.mockReset();
  undiciState.fetch.mockResolvedValue({ ok: true, status: 200, headers: new Headers(), body: null });
  loggerState.warn.mockClear();
  resetOutboundFetchStateForTest();
});

afterEach(() => {
  resetOutboundFetchStateForTest();
});

describe('resolveOutboundDispatcher', () => {
  it('returns the caller fallback when the resolver says direct', async () => {
    const fallback = new UndiciAgent();
    await expect(resolveOutboundDispatcher('https://platform.claude.com/v1/oauth/token', { fallback }))
      .resolves.toBe(fallback);
    await expect(resolveOutboundDispatcher('https://platform.claude.com/v1/oauth/token'))
      .resolves.toBeUndefined();
    await fallback.close();
  });

  it('never consults the resolver for loopback upstreams', async () => {
    resolverState.resolve.mockResolvedValue('http://127.0.0.1:7890');
    await expect(resolveOutboundDispatcher('http://localhost:51730/v1/messages')).resolves.toBeUndefined();
    await expect(resolveOutboundDispatcher('http://127.0.0.1:51730/v1/messages')).resolves.toBeUndefined();
    expect(resolverState.resolve).not.toHaveBeenCalled();
  });

  it('resolves per origin + path (query stripped) and builds a ProxyAgent for http proxies', async () => {
    resolverState.resolve.mockResolvedValue('http://127.0.0.1:7890');
    const dispatcher = await resolveOutboundDispatcher('https://platform.claude.com/v1/oauth/token?x=1');
    expect(pick(dispatcher, 'https://platform.claude.com/v1/oauth/token')).toBeInstanceOf(ProxyAgent);
    // PAC 的 FindProxyForURL 可以按路径判定 → 必须把 path 带上;query 可能含令牌,剥掉。
    expect(resolverState.resolve).toHaveBeenCalledWith('https://platform.claude.com/v1/oauth/token');
  });

  it('keeps per-path PAC decisions apart on the same origin', async () => {
    // 「/internal 直连、其余走代理」这类 PAC 配置必须逐路径生效。
    resolverState.resolve.mockImplementation(async (target: string) =>
      new URL(target).pathname === '/internal' ? null : 'http://127.0.0.1:7890',
    );
    const proxied = await resolveOutboundDispatcher('https://api.example.com/public');
    expect(proxied).toBeDefined();
    await expect(resolveOutboundDispatcher('https://api.example.com/internal')).resolves.toBeUndefined();
    // 重定向选路也查同一份「origin + path」快照,不会把 /internal 拖进代理。
    expect(pick(proxied, 'https://api.example.com/internal')).not.toBeInstanceOf(ProxyAgent);
  });

  it('lets caller connect tuning win over the built-in default', async () => {
    // 合并规则(纯函数):默认值只补缺,调用方给的值优先,自定义 connector 原样保留。
    expect(resolveConnectOptions(undefined)).toEqual({ autoSelectFamilyAttemptTimeout: 2500 });
    expect(
      resolveConnectOptions({ connect: { autoSelectFamilyAttemptTimeout: 9999 } }),
    ).toEqual({ autoSelectFamilyAttemptTimeout: 9999 });
    expect(resolveConnectOptions({ connect: { maxCachedSessions: 0 } })).toEqual({
      autoSelectFamilyAttemptTimeout: 2500,
      maxCachedSessions: 0,
    });
    const connector = (): void => {};
    expect(resolveConnectOptions({ connect: connector as never })).toBe(connector);

    // 端到端:带自定义 connect 调优时仍建得出 ProxyAgent。
    resolverState.resolve.mockResolvedValue('http://127.0.0.1:7890');
    const dispatcher = await resolveOutboundDispatcher('https://chatgpt.com/backend-api/codex', {
      agentOptions: { connect: { autoSelectFamilyAttemptTimeout: 9999 } },
    });
    expect(pick(dispatcher, 'https://chatgpt.com/backend-api/codex')).toBeInstanceOf(ProxyAgent);
  });

  it('builds a plain Agent with a socks5 connector for socks5 proxies', async () => {
    resolverState.resolve.mockResolvedValue('socks5://127.0.0.1:7891');
    const dispatcher = await resolveOutboundDispatcher('https://api.anthropic.com/api/oauth/profile');
    const base = pick(dispatcher, 'https://api.anthropic.com/api/oauth/profile');
    expect(base).toBeInstanceOf(UndiciAgent);
    expect(base).not.toBeInstanceOf(ProxyAgent);
  });

  it('reuses one dispatcher per proxy + tuning, and separates different tuning', async () => {
    resolverState.resolve.mockResolvedValue('http://127.0.0.1:7890');
    const a = await resolveOutboundDispatcher('https://chatgpt.com/backend-api/codex');
    const b = await resolveOutboundDispatcher('https://chatgpt.com/backend-api/codex');
    expect(b).toBe(a);
    const tuned = await resolveOutboundDispatcher('https://chatgpt.com/backend-api/codex', {
      agentOptions: { keepAliveTimeout: 60_000 },
    });
    expect(tuned).not.toBe(a);
    expect(pick(tuned, 'https://chatgpt.com/backend-api/codex')).toBeInstanceOf(ProxyAgent);
    // 不同调优 = 不同底层池,不能共享连接。
    expect(pick(tuned, 'https://chatgpt.com/backend-api/codex')).not.toBe(
      pick(a, 'https://chatgpt.com/backend-api/codex'),
    );
  });

  it('separates pools per custom connect function (functions vanish in JSON.stringify)', async () => {
    resolverState.resolve.mockResolvedValue('http://127.0.0.1:7890');
    const connectA = ((_o: unknown, cb: (e: Error | null) => void) => cb(null)) as never;
    const connectB = ((_o: unknown, cb: (e: Error | null) => void) => cb(null)) as never;
    const url = 'https://example.com/x';
    const a = await resolveOutboundDispatcher(url, { agentOptions: { connect: connectA } });
    const b = await resolveOutboundDispatcher(url, { agentOptions: { connect: connectB } });
    const aAgain = await resolveOutboundDispatcher(url, { agentOptions: { connect: connectA } });
    // 不同 connector → 不同底层池;同一 connector → 复用同一个。
    expect(pick(b, url)).not.toBe(pick(a, url));
    expect(pick(aAgain, url)).toBe(pick(a, url));
  });

  it('separates dispatchers per upstream protocol', async () => {
    resolverState.resolve.mockResolvedValue('http://127.0.0.1:7890');
    const https = await resolveOutboundDispatcher('https://example.com/a');
    const http = await resolveOutboundDispatcher('http://example.com/a');
    expect(pick(http, 'http://example.com/a')).not.toBe(pick(https, 'https://example.com/a'));
  });

  it('re-routes per hop so redirects cannot drag loopback or bypassed hosts through the proxy', async () => {
    resolverState.resolve.mockResolvedValue('http://127.0.0.1:7890');
    const dispatcher = await resolveOutboundDispatcher('https://platform.claude.com/v1/oauth/token');
    const proxied = pick(dispatcher, 'https://platform.claude.com/v1/oauth/token');
    expect(proxied).toBeInstanceOf(ProxyAgent);

    // loopback 同步可判:重定向到本机一律直连,「loopback 恒直连」在跳转后依然成立。
    const loopback = pick(dispatcher, 'http://127.0.0.1:51730/v1/messages');
    expect(loopback).not.toBe(proxied);
    expect(loopback).not.toBeInstanceOf(ProxyAgent);
    // 同一个直连池复用,不会每跳新建。
    expect(pick(dispatcher, 'http://localhost:51730/v1/messages')).toBe(loopback);

    // 快照里记着「该 origin 直连」(NO_PROXY 命中等)→ 也走直连池。
    resolverState.resolve.mockResolvedValue(null);
    await resolveOutboundDispatcher('https://intranet.example.com/x');
    expect(pick(dispatcher, 'https://intranet.example.com/x')).toBe(loopback);

    // 从没解析过的 origin:同步拿不到结论,本跳沿用首跳出口(不阻塞热路径)。
    expect(pick(dispatcher, 'https://unknown.example.org/x')).toBe(proxied);
  });

  it('never hands out an evicted base dispatcher (wrapper re-derives from the pool)', async () => {
    resolverState.resolve.mockResolvedValue('http://127.0.0.1:7890');
    const wrapper = await resolveOutboundDispatcher('https://a0.example.com/x');
    const before = pick(wrapper, 'https://a0.example.com/x');

    // 把底层池顶过上限,逼出 a0 那一项(wrapper 仍在 routingPool 里被复用)。
    for (let i = 1; i <= 8; i += 1) {
      await resolveOutboundDispatcher('https://a0.example.com/x', {
        agentOptions: { keepAliveTimeout: 2000 + i },
      });
    }
    const again = await resolveOutboundDispatcher('https://a0.example.com/x');
    expect(again).toBe(wrapper); // 同一个 wrapper 实例
    const after = pick(wrapper, 'https://a0.example.com/x');
    // 但它派发到的底层已经是重建后的新实例,不是那个被安排关闭的旧实例。
    expect(after).not.toBe(before);
    expect(after).toBeInstanceOf(ProxyAgent);
  });

  it('backfills the snapshot under the path-bearing key so the next hop stops missing', async () => {
    // wrapper 兜底路径(voice 客户端把它直接交给 undici):未命中时后台补解析,
    // 必须按「origin + path」写快照,否则查的键永远 miss、永远沿用首跳代理。
    resolverState.resolve.mockImplementation(async (target: string) =>
      new URL(target).pathname === '/direct' ? null : 'http://127.0.0.1:7890',
    );
    const wrapper = await resolveOutboundDispatcher('https://api.example.com/first');
    const proxied = pick(wrapper, 'https://api.example.com/first');

    // 第一次访问 /direct:快照还没有 → 本跳沿用首跳出口,并触发后台解析。
    expect(pick(wrapper, 'https://api.example.com/direct')).toBe(proxied);
    expect(resolverState.resolve).toHaveBeenCalledWith('https://api.example.com/direct');
    await vi.waitFor(() => {
      // 后台解析落盘后,同一路径不再 miss —— 走直连池。
      expect(pick(wrapper, 'https://api.example.com/direct')).not.toBe(proxied);
    });
    expect(pick(wrapper, 'https://api.example.com/direct')).not.toBeInstanceOf(ProxyAgent);
  });

  it('does not close an evicted dispatcher immediately (it may already be in a caller hand)', async () => {
    vi.useFakeTimers();
    try {
      resolverState.resolve.mockResolvedValue('http://127.0.0.1:7890');
      const first = await resolveOutboundDispatcher('https://a0.example.com/x');
      const evictable = pick(first, 'https://a0.example.com/x') as { close: () => Promise<void> };
      const closeSpy = vi.spyOn(evictable, 'close').mockResolvedValue(undefined);

      // 用不同的池调优把底层池顶过上限(8),逼出最旧的那一项。
      for (let i = 1; i <= 8; i += 1) {
        await resolveOutboundDispatcher('https://a0.example.com/x', {
          agentOptions: { keepAliveTimeout: 1000 + i },
        });
      }
      expect(closeSpy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(60_000);
      expect(closeSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails open to the fallback when the resolver throws', async () => {
    resolverState.resolve.mockRejectedValue(new Error('boom'));
    await expect(resolveOutboundDispatcher('https://auth.x.ai/oauth2/token')).resolves.toBeUndefined();
    expect(loggerState.warn).toHaveBeenCalled();
  });

  it('falls back to direct for unsupported proxy schemes and warns once per origin', async () => {
    resolverState.resolve.mockResolvedValue('https://secure.proxy:443');
    await expect(resolveOutboundDispatcher('https://auth.x.ai/oauth2/token')).resolves.toBeUndefined();
    await expect(resolveOutboundDispatcher('https://auth.x.ai/.well-known/openid-configuration'))
      .resolves.toBeUndefined();
    expect(loggerState.warn).toHaveBeenCalledTimes(1);
  });

  it('keeps proxy credentials out of the logs', async () => {
    resolverState.resolve.mockResolvedValue('https://user:sekret@secure.proxy:443');
    await resolveOutboundDispatcher('https://auth.x.ai/oauth2/token');
    const logged = JSON.stringify([...loggerState.warn.mock.calls, ...loggerState.debug.mock.calls]);
    expect(logged).not.toContain('sekret');
  });

  it('tolerates unparseable urls by treating them as direct', async () => {
    await expect(resolveOutboundDispatcher('/v1/oauth/token')).resolves.toBeUndefined();
    expect(resolverState.resolve).not.toHaveBeenCalled();
  });
});

describe('outboundFetch', () => {
  it('rewrites proxy dial origin to the vetted IP while preserving the original Host', () => {
    const rewritten = rewritePinnedProxyDispatchOptions(
      {
        origin: 'https://api.example.com',
        path: '/data',
        method: 'GET',
        headers: ['accept', 'application/json'],
      },
      new URL('https://api.example.com/data'),
      '2001:db8::1',
    );

    expect(rewritten.origin).toBe('https://[2001:db8::1]');
    expect(rewritten.headers).toEqual([
      'accept',
      'application/json',
      'host',
      'api.example.com',
    ]);
  });

  it('fails over between vetted proxy targets only before the request starts', async () => {
    const dispatchSpy = vi.spyOn(ProxyAgent.prototype, 'dispatch');
    const controller = {} as Dispatcher.DispatchController;
    const responseError = vi.fn();
    let authorizeRetry!: () => void;
    const retryAuthorization = new Promise<void>((resolve) => {
      authorizeRetry = resolve;
    });
    const beforeRetry = vi.fn(() => retryAuthorization);
    try {
      dispatchSpy
        .mockImplementationOnce((_options, handler) => {
          handler.onResponseError?.(controller, new Error('first address unreachable'));
          return true;
        })
        .mockImplementationOnce((_options, handler) => {
          handler.onRequestStart?.(controller, null);
          handler.onResponseError?.(controller, new Error('request failed after start'));
          return true;
        });
      const dispatcher = createPinnedProxyDispatcher(
        {
          kind: 'http',
          url: 'http://127.0.0.1:7890',
          hostname: '127.0.0.1',
          port: 7890,
        },
        new URL('https://api.example.com/data'),
        ['203.0.113.10', '203.0.113.11'],
        beforeRetry,
      );

      dispatcher.dispatch(
        { origin: 'https://api.example.com', path: '/data', method: 'POST', body: 'payload' },
        { onRequestStart: vi.fn(), onResponseError: responseError },
      );

      expect(dispatchSpy).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(beforeRetry).toHaveBeenCalledTimes(1));
      authorizeRetry();
      await vi.waitFor(() => expect(dispatchSpy).toHaveBeenCalledTimes(2));
      expect(dispatchSpy.mock.calls.map(([options]) => options.origin)).toEqual([
        'https://203.0.113.10',
        'https://203.0.113.11',
      ]);
      expect(responseError).toHaveBeenCalledTimes(1);
      expect(responseError).toHaveBeenCalledWith(
        controller,
        expect.objectContaining({ message: 'request failed after start' }),
      );
      await dispatcher.close();
    } finally {
      dispatchSpy.mockRestore();
    }
  });

  it('does not try another proxy target when retry authorization has expired', async () => {
    const dispatchSpy = vi.spyOn(ProxyAgent.prototype, 'dispatch');
    const controller = {} as Dispatcher.DispatchController;
    const responseError = vi.fn();
    const authorizationError = new Error('authorization expired');
    try {
      dispatchSpy.mockImplementationOnce((_options, handler) => {
        handler.onResponseError?.(controller, new Error('first address unreachable'));
        return true;
      });
      const dispatcher = createPinnedProxyDispatcher(
        {
          kind: 'http',
          url: 'http://127.0.0.1:7890',
          hostname: '127.0.0.1',
          port: 7890,
        },
        new URL('https://api.example.com/data'),
        ['203.0.113.10', '203.0.113.11'],
        () => Promise.reject(authorizationError),
      );

      dispatcher.dispatch(
        { origin: 'https://api.example.com', path: '/data', method: 'POST', body: 'payload' },
        { onResponseError: responseError },
      );

      await vi.waitFor(() =>
        expect(responseError).toHaveBeenCalledWith(controller, authorizationError),
      );
      expect(dispatchSpy).toHaveBeenCalledTimes(1);
      await dispatcher.close();
    } finally {
      dispatchSpy.mockRestore();
    }
  });

  it.each([
    'http://127.0.0.1:7890',
    'socks5://127.0.0.1:7891',
  ])('keeps the pinned public-target guard on the %s proxy path', async (proxyUrl) => {
    resolverState.resolve.mockResolvedValue(proxyUrl);
    const beforeDispatch = vi.fn(() => {
      throw new Error('authorization expired');
    });

    await expect(
      guardedOutboundFetch('https://93.184.216.34/data', { method: 'GET' }, beforeDispatch),
    ).rejects.toThrow('authorization expired');

    expect(resolverState.resolve).toHaveBeenCalledWith('https://93.184.216.34/data');
    expect(loggerState.debug).toHaveBeenCalledWith(
      'creating outbound proxy dispatcher',
      expect.objectContaining({ protocol: 'https:' }),
    );
    expect(beforeDispatch).toHaveBeenCalledTimes(1);
    expect(undiciState.fetch).not.toHaveBeenCalled();
  });

  it.each([
    'https://198.18.0.1/data',
    'https://[fc00::1]/data',
  ])('does not treat selecting a proxy as authorization for special-use target %s', async (url) => {
    resolverState.resolve.mockResolvedValue('http://127.0.0.1:7890');
    loggerState.debug.mockClear();

    await expect(guardedOutboundFetch(url, { method: 'GET' }, vi.fn())).rejects.toThrow(/blocked/i);

    expect(undiciState.fetch).not.toHaveBeenCalled();
    expect(loggerState.debug).not.toHaveBeenCalledWith(
      'creating outbound proxy dispatcher',
      expect.anything(),
    );
  });

  it('passes the proxy dispatcher through to undici fetch', async () => {
    resolverState.resolve.mockResolvedValue('http://127.0.0.1:7890');
    await outboundFetch('https://platform.claude.com/v1/oauth/token', { method: 'POST' });
    expect(undiciState.fetch).toHaveBeenCalledTimes(1);
    const [, init] = undiciState.fetch.mock.calls[0] as unknown as [unknown, Record<string, unknown>];
    expect(init.method).toBe('POST');
    expect(pick(init.dispatcher, 'https://platform.claude.com/v1/oauth/token')).toBeInstanceOf(ProxyAgent);
  });

  it('delegates to globalThis.fetch verbatim when the upstream is direct', async () => {
    // 直连必须与改造前逐字节一致 —— 包括「宿主/单测替换了全局 fetch」这件事继续生效。
    const globalFetch = vi.fn(async () => new Response('ok'));
    const original = globalThis.fetch;
    globalThis.fetch = globalFetch as unknown as typeof globalThis.fetch;
    try {
      await outboundFetch('https://platform.claude.com/v1/oauth/token', { method: 'POST' });
      expect(undiciState.fetch).not.toHaveBeenCalled();
      expect(globalFetch).toHaveBeenCalledTimes(1);
      const [, init] = globalFetch.mock.calls[0] as unknown as [unknown, Record<string, unknown>];
      expect(init).toEqual({ method: 'POST' });
    } finally {
      globalThis.fetch = original;
    }
  });

  it('accepts URL inputs', async () => {
    resolverState.resolve.mockResolvedValue('http://127.0.0.1:7890');
    await outboundFetch(new URL('https://api.anthropic.com/v1/models'));
    expect(resolverState.resolve).toHaveBeenCalledWith('https://api.anthropic.com/v1/models');
  });

  it('normalizes global FormData bodies for the npm-undici proxy path', async () => {
    // 全局 FormData 来自 Node 内置 undici;npm undici 的 instanceof 认不出来,不归一化
    // 就会被序列化成 [object FormData](review 2026-07-27 P1)。
    resolverState.resolve.mockResolvedValue('http://127.0.0.1:7890');
    const form = new FormData();
    form.set('model', 'elevenlabs/scribe_v2');
    form.set('file', new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mpeg' }), 'a.mp3');
    await outboundFetch('https://gateway.example.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: 'Bearer k' },
      body: form,
    });
    const [url, init] = undiciState.fetch.mock.calls[0] as unknown as [
      string,
      { method: string; body: unknown; headers: Array<[string, string]> },
    ];
    expect(url).toBe('https://gateway.example.com/v1/audio/transcriptions');
    expect(init.method).toBe('POST');
    expect(Buffer.isBuffer(init.body)).toBe(true);
    expect((init.body as Buffer).includes('elevenlabs/scribe_v2')).toBe(true);
    const headers = new Map(init.headers.map(([k, v]) => [k.toLowerCase(), v]));
    // boundary 由全局 Request 生成,必须随字节一起传下去,否则服务端解不出 multipart。
    expect(headers.get('content-type')).toMatch(/^multipart\/form-data; boundary=/);
    expect(headers.get('authorization')).toBe('Bearer k');
  });

  it('follows redirects itself, re-resolving the proxy for every hop', async () => {
    // 首跳走代理;第二跳的目标 host 在快照里是「直连」→ 不能再被塞进代理隧道。
    // 用 URL.origin 精确比较,不做前缀匹配(前缀匹配会把 oauth.example.com.evil.test
    // 也算命中,CodeQL 的 incomplete-url-substring-sanitization 正是这个)。
    resolverState.resolve.mockImplementation(async (target: string) =>
      new URL(target).origin === 'https://oauth.example.com' ? 'http://127.0.0.1:7890' : null,
    );
    undiciState.fetch
      .mockResolvedValueOnce(redirectResponse(302, 'https://cdn.example.net/final') as never)
      .mockResolvedValueOnce({ ok: true, status: 200, headers: new Headers(), body: null } as never);

    await outboundFetch('https://oauth.example.com/token', { method: 'POST', body: '{}' });

    expect(undiciState.fetch).toHaveBeenCalledTimes(2);
    const [firstUrl, firstInit] = undiciState.fetch.mock.calls[0] as unknown as [
      string,
      { redirect: string; dispatcher?: unknown },
    ];
    const [secondUrl, secondInit] = undiciState.fetch.mock.calls[1] as unknown as [
      string,
      { method: string; dispatcher?: unknown },
    ];
    expect(firstUrl).toBe('https://oauth.example.com/token');
    // 自己跟随 → 每跳都用 manual 拿 Location,不把选路交给 undici 内部。
    expect(firstInit.redirect).toBe('manual');
    expect(firstInit.dispatcher).toBeDefined();
    expect(secondUrl).toBe('https://cdn.example.net/final');
    // 第二跳解析为直连 → 不带 dispatcher(走 undici 自己的全局池)。
    expect(secondInit.dispatcher).toBeUndefined();
    expect(resolverState.resolve).toHaveBeenCalledWith('https://cdn.example.net/final');
  });

  it('turns 303 into GET, drops the body, and never replays credentials cross-origin', async () => {
    resolverState.resolve.mockResolvedValue('http://127.0.0.1:7890');
    undiciState.fetch
      .mockResolvedValueOnce(redirectResponse(303, 'https://other.example.org/done') as never)
      .mockResolvedValueOnce({ ok: true, status: 200, headers: new Headers(), body: null } as never);

    await outboundFetch('https://api.example.com/submit', {
      method: 'POST',
      headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
      body: '{"a":1}',
    });

    const [, second] = undiciState.fetch.mock.calls[1] as unknown as [
      string,
      { method: string; body?: unknown; headers: Array<[string, string]> },
    ];
    expect(second.method).toBe('GET');
    expect(second.body).toBeUndefined();
    const headers = new Map(second.headers.map(([k, v]) => [k.toLowerCase(), v]));
    expect(headers.has('authorization')).toBe(false);
    expect(headers.has('content-type')).toBe(false);
  });

  it('only rewrites POST on 301/302 and never rewrites HEAD on 303', async () => {
    resolverState.resolve.mockResolvedValue('http://127.0.0.1:7890');
    // 301 + PUT:fetch 规范只把 POST 转 GET,PUT 必须带着方法和 body 继续。
    undiciState.fetch
      .mockResolvedValueOnce(redirectResponse(301, 'https://api.example.com/moved') as never)
      .mockResolvedValueOnce({ ok: true, status: 200, headers: new Headers(), body: null } as never);
    await outboundFetch('https://api.example.com/old', { method: 'PUT', body: 'payload' });
    const [, put] = undiciState.fetch.mock.calls[1] as unknown as [
      string,
      { method: string; body?: Buffer },
    ];
    expect(put.method).toBe('PUT');
    expect(put.body?.toString()).toBe('payload');

    // 303 + HEAD:探测请求不该变成 GET。
    undiciState.fetch.mockReset();
    undiciState.fetch
      .mockResolvedValueOnce(redirectResponse(303, 'https://api.example.com/probe2') as never)
      .mockResolvedValueOnce({ ok: true, status: 200, headers: new Headers(), body: null } as never);
    await outboundFetch('https://api.example.com/probe', { method: 'HEAD' });
    const [, head] = undiciState.fetch.mock.calls[1] as unknown as [string, { method: string }];
    expect(head.method).toBe('HEAD');
  });

  it('does not follow non-redirect 3xx statuses that happen to carry Location', async () => {
    resolverState.resolve.mockResolvedValue('http://127.0.0.1:7890');
    // 304 / 300 在直连路径(globalThis.fetch)是原样返回的;开代理不该把它们吞掉。
    for (const status of [300, 304]) {
      undiciState.fetch.mockReset();
      undiciState.fetch.mockResolvedValue(
        redirectResponse(status, 'https://elsewhere.example.com/x') as never,
      );
      const res = (await outboundFetch('https://api.example.com/thing')) as unknown as {
        status: number;
      };
      expect(undiciState.fetch).toHaveBeenCalledTimes(1);
      expect(res.status).toBe(status);
    }
  });

  it('replays method and body on 307 and stops after too many hops', async () => {
    resolverState.resolve.mockResolvedValue('http://127.0.0.1:7890');
    undiciState.fetch.mockImplementation(
      async () => redirectResponse(307, 'https://api.example.com/loop') as never,
    );
    await expect(
      outboundFetch('https://api.example.com/loop', { method: 'PUT', body: 'payload' }),
    ).rejects.toThrow(/too many redirects/);
    const [, second] = undiciState.fetch.mock.calls[1] as unknown as [
      string,
      { method: string; body?: Buffer },
    ];
    expect(second.method).toBe('PUT');
    expect(second.body?.toString()).toBe('payload');
  });

  it('rejects with the abort reason instead of hanging on proxy resolution', async () => {
    const controller = new AbortController();
    resolverState.resolve.mockImplementation(() => new Promise(() => {}));
    const inflight = outboundFetch('https://platform.claude.com/v1/oauth/token', {
      signal: controller.signal,
    });
    controller.abort(new Error('caller gave up'));
    await expect(inflight).rejects.toThrow('caller gave up');
    expect(undiciState.fetch).not.toHaveBeenCalled();
  });

  it('falls back to direct when proxy resolution itself times out', async () => {
    vi.useFakeTimers();
    try {
      resolverState.resolve.mockImplementation(() => new Promise(() => {}));
      const globalFetch = vi.fn(async () => new Response('ok'));
      const original = globalThis.fetch;
      globalThis.fetch = globalFetch as unknown as typeof globalThis.fetch;
      try {
        const inflight = outboundFetch('https://platform.claude.com/v1/oauth/token');
        await vi.advanceTimersByTimeAsync(2000);
        await inflight;
        expect(globalFetch).toHaveBeenCalledTimes(1);
        expect(undiciState.fetch).not.toHaveBeenCalled();
      } finally {
        globalThis.fetch = original;
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps json string bodies and abort signals on the proxy path', async () => {
    resolverState.resolve.mockResolvedValue('http://127.0.0.1:7890');
    const controller = new AbortController();
    await outboundFetch('https://platform.claude.com/v1/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code' }),
      signal: controller.signal,
    });
    const [, init] = undiciState.fetch.mock.calls[0] as unknown as [
      string,
      { body: Buffer; signal?: AbortSignal; redirect?: string },
    ];
    expect(init.body.toString()).toBe('{"grant_type":"authorization_code"}');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    // 调用方要的是默认 follow,由我们逐跳跟随实现 → 每跳对 undici 用 manual。
    expect(init.redirect).toBe('manual');
  });

  it('hands manual/error redirect modes straight to undici (plugin network slot守门靠它)', async () => {
    resolverState.resolve.mockResolvedValue('http://127.0.0.1:7890');
    undiciState.fetch.mockResolvedValue(
      redirectResponse(302, 'https://elsewhere.example.com/x') as never,
    );
    await outboundFetch('https://api.example.com/x', { redirect: 'manual' });
    // 显式 manual:只发一次,3xx 原样回给调用方(它要自己逐跳校验白名单)。
    expect(undiciState.fetch).toHaveBeenCalledTimes(1);
    const [, init] = undiciState.fetch.mock.calls[0] as unknown as [string, { redirect: string }];
    expect(init.redirect).toBe('manual');
  });
});

describe('outboundUndiciFetch', () => {
  it('honors the caller abort signal while resolving the proxy', async () => {
    const controller = new AbortController();
    resolverState.resolve.mockImplementation(() => new Promise(() => {}));
    const inflight = outboundUndiciFetch('https://chatgpt.com/backend-api/codex', {
      signal: controller.signal,
    });
    controller.abort(new Error('stopped mid-refine'));
    await expect(inflight).rejects.toThrow('stopped mid-refine');
    expect(undiciState.fetch).not.toHaveBeenCalled();
  });

  it('keeps using undici on both paths (callers consume undici Response)', async () => {
    await outboundUndiciFetch('https://api.openai.com/v1/models');
    expect(undiciState.fetch).toHaveBeenCalledTimes(1);
    resolverState.resolve.mockResolvedValue('http://127.0.0.1:7890');
    await outboundUndiciFetch('https://api.openai.com/v1/models');
    const [, init] = undiciState.fetch.mock.calls[1] as unknown as [unknown, Record<string, unknown>];
    expect(pick(init.dispatcher, 'https://api.openai.com/v1/models')).toBeInstanceOf(ProxyAgent);
  });
});

describe('createOutboundHttpAgent', () => {
  it('returns undefined when the upstream is direct', async () => {
    await expect(createOutboundHttpAgent('wss://api.elevenlabs.io/v1/x')).resolves.toBeUndefined();
  });

  it('tunnels wss upstreams through http proxies', async () => {
    resolverState.resolve.mockResolvedValue('http://127.0.0.1:7890');
    const agent = await createOutboundHttpAgent('wss://api.elevenlabs.io/v1/x');
    expect(agent).toBeInstanceOf(TunnelingHttpsAgent);
    expect(resolverState.resolve).toHaveBeenCalledWith('https://api.elevenlabs.io/v1/x');
    agent?.destroy();
  });

  it('uses the socks5 agent for wss upstreams behind socks5 proxies', async () => {
    resolverState.resolve.mockResolvedValue('socks5://127.0.0.1:7891');
    const agent = await createOutboundHttpAgent('wss://api.elevenlabs.io/v1/x');
    expect(agent).toBeInstanceOf(Socks5HttpsAgent);
    agent?.destroy();
  });

  it('declines plaintext ws upstreams behind http proxies, warning once', async () => {
    resolverState.resolve.mockResolvedValue('http://127.0.0.1:7890');
    await expect(createOutboundHttpAgent('ws://relay.example.com/socket')).resolves.toBeUndefined();
    await expect(createOutboundHttpAgent('ws://relay.example.com/socket')).resolves.toBeUndefined();
    expect(loggerState.warn).toHaveBeenCalledTimes(1);
  });

  it('never proxies loopback websockets', async () => {
    resolverState.resolve.mockResolvedValue('http://127.0.0.1:7890');
    await expect(createOutboundHttpAgent('ws://127.0.0.1:8123/hooks')).resolves.toBeUndefined();
    expect(resolverState.resolve).not.toHaveBeenCalled();
  });
});
