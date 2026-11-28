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
  ownerScope: 'cloud:account-a:1',
  authRealm: 'global',
  ownerInvalidations: new Set<() => void>(),
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('electron', () => ({ net: { fetch: mocks.netFetch } }));
vi.mock('../appSessionState.js', () => ({
  activeOwnerScopeKey: () => mocks.ownerScope,
  getActiveAppSession: () => ({ mode: 'cloud', dataOwnerId: mocks.ownerScope.split(':')[1], generation: Number(mocks.ownerScope.split(':')[2]) }),
  isAppSessionBoundaryPending: () => false,
  onAppSessionInvalidated: (listener: () => void) => {
    mocks.ownerInvalidations.add(listener);
    return () => mocks.ownerInvalidations.delete(listener);
  },
}));
vi.mock('../authManager', () => ({
  getActiveAuthRealm: () => mocks.authRealm,
  getAccessToken: mocks.getAccessToken,
  refresh: mocks.refresh,
  invalidateSession: mocks.invalidateSession,
}));
vi.mock('../i18n.desktop.js', () => ({
  getResolvedMainLocale: () => 'zh-CN',
}));
vi.mock('../clientEndpointsService.js', () => ({
  getClientEndpoint: () => 'https://models.example.test',
}));
vi.mock('../logger', () => ({
  createLogger: () => mocks.logger,
}));

import { serverApiFetch, ServerApiError } from '../serverApiClient.desktop';
import { createServerApiClient } from '../serverApiClient.js';
import { createCreditUsageRateLimitFetch } from '../model-access/creditUsageRateLimit.js';

function creditHarness() {
  const state = { owner: 'member-a', generation: 1, enabled: true, endpoint: 'https://credit-a.example.test' };
  const transport = vi.fn();
  const refresh = vi.fn(async () => true);
  const fetch = createCreditUsageRateLimitFetch(createServerApiClient({
    fetch: transport, locale: () => 'en', log: mocks.logger,
    auth: { getAccessToken: () => 'fixture-token', refresh, invalidateSession: vi.fn() },
  }), () => state.enabled ? state : null);
  const read = (options = {}) => fetch('/api/model-access/credit-usage', { baseUrl: () => state.endpoint, ...options });
  const limited = () => new Response('{}', { status: 429, headers: { 'Retry-After': '120' } });
  return { state, transport, refresh, fetch, read, limited };
}

describe('serverApiFetch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authRealm = 'global';
  });

  // Unit, engineering-conventions §3.2: the shared production HTTP entry must
  // honor credit-usage Retry-After across callers. Existing tests only checked
  // header parsing. Minimal regression: 429, then a second read before expiry.
  it('does not physically reread credit usage before Retry-After expires', async () => {
    vi.useFakeTimers();
    const baseUrl = 'https://credit-limit.example.test';
    const request = () => serverApiFetch('/api/model-access/credit-usage', { baseUrl });
    try {
      mocks.netFetch.mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'Retry-After': '120' } }));
      await expect(request()).rejects.toMatchObject({ statusCode: 429 });
      mocks.netFetch.mockResolvedValue(new Response('{"available":"7"}'));
      await expect(request()).rejects.toMatchObject({ statusCode: 429, retryAt: Date.now() + 120_000 });
      expect(mocks.netFetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(120_000);
      await expect(request()).resolves.toEqual({ available: '7' });
      expect(mocks.netFetch).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); mocks.netFetch.mockReset(); }
  });

  it('isolates the same membership and endpoint in different authenticated realms', async () => {
    const baseUrl = 'https://credit-realms.example.test';
    const read = () => serverApiFetch('/api/model-access/credit-usage', { baseUrl });
    mocks.netFetch.mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'Retry-After': '120' } }));
    await expect(read()).rejects.toMatchObject({ statusCode: 429 });
    mocks.authRealm = 'cn';
    mocks.netFetch.mockResolvedValueOnce(new Response('{"available":"3"}'));
    await expect(read()).resolves.toEqual({ available: '3' });
    mocks.authRealm = 'global';
    await expect(read()).rejects.toMatchObject({ statusCode: 429 });
    expect(mocks.netFetch).toHaveBeenCalledTimes(2);
  });

  // Same production client/fake transport, unit: isolate members and endpoints,
  // but retain the server's deadline when only the window generation is repaired.
  it('keeps retry deadlines scoped to membership and endpoint across generation repairs', async () => {
    const h = creditHarness();
    h.transport.mockResolvedValueOnce(h.limited());
    await expect(h.read()).rejects.toMatchObject({ statusCode: 429 });
    h.state.generation++;
    await expect(h.read()).rejects.toMatchObject({ statusCode: 429 });
    h.transport.mockImplementation(async () => new Response('{"available":"8"}'));
    h.state.owner = 'member-b';
    await expect(h.read()).resolves.toEqual({ available: '8' });
    h.state.owner = 'member-a'; h.state.endpoint = 'https://credit-b.example.test';
    await expect(h.read()).resolves.toEqual({ available: '8' });
    h.state.endpoint = 'https://credit-a.example.test';
    await expect(h.read()).rejects.toMatchObject({ statusCode: 429 });
    expect(h.transport).toHaveBeenCalledTimes(3);
  });

  // #13008 review: the production HTTP entry must stop another Credits read
  // as soon as 429 headers arrive. Existing tests waited for rejection/abort,
  // missing the interval where the response body was still pending. Unit;
  // minimal input: a 429 with Retry-After and an unresolved body, then reread.
  it('blocks another credit read while the rate-limited response body is still pending', async () => {
    const h = creditHarness();
    let entered!: () => void, finish!: (body: object) => void;
    const bodyStarted = new Promise<void>(resolve => { entered = resolve; });
    const body = new Promise<object>(resolve => { finish = resolve; });
    h.transport.mockResolvedValueOnce({ status: 429, ok: false, headers: new Headers({ 'Retry-After': '120' }),
      json: () => { entered(); return body; },
    });
    const pending = h.read();
    try {
      await bodyStarted;
      h.transport.mockImplementation(async () => new Response('{}'));
      await expect(h.read()).rejects.toMatchObject({ statusCode: 429 });
      expect(h.transport).toHaveBeenCalledOnce();
      h.state.endpoint = 'https://credit-b.example.test';
      await expect(h.read()).resolves.toEqual({});
      expect(h.transport).toHaveBeenCalledTimes(2);
    } finally {
      finish({});
      await expect(pending).rejects.toMatchObject({ statusCode: 429 });
    }
  });

  it('preserves the HTTP rejection when a retry deadline observer throws', async () => {
    const h = creditHarness();
    h.transport.mockResolvedValueOnce(h.limited());
    await expect(h.read({ onRetryAfter: () => { throw new Error('private observer details'); } }))
      .rejects.toMatchObject({ statusCode: 429 });
    expect(JSON.stringify(mocks.logger.warn.mock.calls)).not.toContain('private observer details');
    expect(h.transport).toHaveBeenCalledOnce();
  });

  it('rechecks the refreshed physical endpoint before sending a 401 retry', async () => {
    const h = creditHarness();
    h.state.endpoint = 'https://credit-b.example.test';
    h.transport.mockResolvedValueOnce(h.limited());
    await expect(h.read()).rejects.toMatchObject({ statusCode: 429 });
    h.state.endpoint = 'https://credit-a.example.test';
    h.transport.mockResolvedValueOnce(new Response('{"error":{"code":"TOKEN_EXPIRED"}}', { status: 401 }));
    h.refresh.mockImplementationOnce(async () => { h.state.endpoint = 'https://credit-b.example.test'; return true; });
    await expect(h.read()).rejects.toMatchObject({ statusCode: 429, servedBaseUrl: 'https://credit-b.example.test' });
    expect(h.refresh).toHaveBeenCalledOnce();
    expect(h.transport).toHaveBeenCalledTimes(2);
  });

  it('does not clear a concurrent 429 when an earlier success arrives late', async () => {
    const h = creditHarness();
    let finish!: (response: Response) => void;
    h.transport.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
    const earlier = h.read();
    h.transport.mockResolvedValueOnce(h.limited());
    await expect(h.read()).rejects.toMatchObject({ statusCode: 429 });
    finish(new Response('{"available":"9"}'));
    await expect(earlier).resolves.toEqual({ available: '9' });
    await expect(h.read()).rejects.toMatchObject({ statusCode: 429 });
    expect(h.transport).toHaveBeenCalledTimes(2);
  });

  it.each(['account', 'generation', 'endpoint', 'disabled'] as const)('drops a credit result overtaken by %s change', async change => {
    const h = creditHarness();
    let finish!: (response: Response) => void;
    h.transport.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
    const pending = h.read();
    if (change === 'account') h.state.owner = 'member-b';
    if (change === 'generation') h.state.generation++;
    if (change === 'endpoint') h.state.endpoint = 'https://credit-b.example.test';
    if (change === 'disabled') h.state.enabled = false;
    finish(new Response('{"available":"9"}'));
    await expect(pending).rejects.toMatchObject({ statusCode: 409 });
    expect(h.transport).toHaveBeenCalledOnce();
  });

  it('keeps a Retry-After learned before a caller aborts a stalled 429 body', async () => {
    const h = creditHarness();
    const controller = new AbortController();
    let entered!: () => void;
    const bodyStarted = new Promise<void>(resolve => { entered = resolve; });
    h.transport.mockImplementationOnce((_url: string, init: RequestInit) => Promise.resolve({
      status: 429, ok: false, headers: new Headers({ 'Retry-After': '120' }),
      json: () => new Promise((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
        entered();
      }),
    }));
    const pending = h.read({ signal: controller.signal });
    await bodyStarted;
    const reason = new Error('caller stopped waiting');
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    await expect(h.read()).rejects.toMatchObject({ statusCode: 429 });
    expect(h.transport).toHaveBeenCalledOnce();
  });

  it('does not let an obsolete generation record a deadline for the new generation', async () => {
    const h = creditHarness();
    let finish!: (response: Response) => void;
    h.transport.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
    const pending = h.read();
    h.state.generation++;
    finish(h.limited());
    await expect(pending).rejects.toMatchObject({ statusCode: 409 });
    h.transport.mockResolvedValueOnce(new Response('{"available":"4"}'));
    await expect(h.read()).resolves.toEqual({ available: '4' });
    expect(h.transport).toHaveBeenCalledTimes(2);
  });

  it('does not throttle other routes, writes, explicit credentials or a 429 without a deadline', async () => {
    const h = creditHarness();
    h.transport.mockResolvedValueOnce(new Response('{}', { status: 429 }));
    await expect(h.read()).rejects.toMatchObject({ statusCode: 429 });
    h.transport.mockResolvedValueOnce(h.limited());
    await expect(h.read()).rejects.toMatchObject({ statusCode: 429 });
    h.transport.mockImplementation(async () => new Response('{}'));
    await expect(h.fetch('/api/model-access/balance', { baseUrl: h.state.endpoint })).resolves.toEqual({});
    await expect(h.fetch('/api/model-access/models', { baseUrl: h.state.endpoint })).resolves.toEqual({});
    await expect(h.read({ method: 'POST', body: {} })).resolves.toEqual({});
    await expect(h.read({ token: 'explicit-fixture-token' })).resolves.toEqual({});
    expect(h.transport).toHaveBeenCalledTimes(6);
  });

  // Unit: cancellation must cover HTTP and a shared auth refresh. Existing retry
  // tests did not abort during either stage, allowing a late query after its deadline.
  it.each(['fetch', 'refresh'] as const)('cancels during %s without a late HTTP retry or logout', async stage => {
    const controller = new AbortController(), expired = new Error('query deadline expired');
    let entered!: () => void, finish!: (value: boolean) => void;
    const started = new Promise<void>(yes => { entered = yes; });
    const refreshing = new Promise<boolean>(yes => { finish = yes; });
    if (stage === 'fetch') {
      mocks.netFetch.mockImplementationOnce((_url: string, opts: RequestInit) => new Promise((_yes, no) => {
        opts.signal?.addEventListener('abort', () => no(opts.signal!.reason), { once: true });
        entered();
      }));
    } else {
      mocks.getAccessToken.mockReturnValue('token-a');
      mocks.netFetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'TOKEN_EXPIRED' } }), { status: 401 }));
      mocks.refresh.mockImplementationOnce(() => { entered(); return refreshing; });
    }
    let observed: unknown;
    const result = serverApiFetch('/api/device-link/provider-shares/delegations/check', {
      baseUrl: 'https://api.example.invalid', signal: controller.signal,
    }).then(() => { observed = 'success'; }, error => { observed = error; });
    try {
      await started;
      controller.abort(expired);
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(observed).toBe(expired);
      await result;
      finish(true);
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(mocks.netFetch).toHaveBeenCalledTimes(1);
      expect(mocks.invalidateSession).not.toHaveBeenCalled();
    } finally { finish(true); }
  });

  // Unit: a real HTTP rejection must retain only its parsed retry deadline.
  // Previously rawFetch discarded headers, so delegation checks could not obey 429.
  it.each([
    { retryAfter: '120', delay: 120_000 },
    { retryAfter: 'Wed, 07 Oct 2026 06:02:00 GMT', date: 'Wed, 07 Oct 2026 06:00:00 GMT', delay: 120_000 },
    { retryAfter: 'not-a-date', delay: undefined },
  ])('exposes a safe retry deadline for 429: $retryAfter', async ({ retryAfter, date, delay }) => {
    const now = Date.now();
    const headers = new Headers({ 'Retry-After': retryAfter });
    if (date) headers.set('Date', date);
    mocks.netFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      error: { code: 'RATE_LIMITED', message: 'private upstream details' },
    }), { status: 429, headers }));
    try {
      await serverApiFetch('/api/device-link/provider-shares/delegations/check', {
        baseUrl: 'https://api.example.invalid', redactErrorDetails: true,
      });
      expect.fail('the verification must reject');
    } catch (error) {
      expect(error).toMatchObject({ code: 'RATE_LIMITED', statusCode: 429 });
      if (!(error instanceof ServerApiError)) throw error;
      if (delay === undefined) expect(error.retryAt).toBeUndefined();
      else {
        expect(error).toHaveProperty('retryAt', expect.any(Number));
        expect(error.retryAt).toBeGreaterThanOrEqual(now + delay);
        expect(error.retryAt).toBeLessThanOrEqual(Date.now() + delay);
      }
    }
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(JSON.stringify(mocks.logger.warn.mock.calls)).not.toContain('private upstream details');
  });

  // Unit: a response body that stalls past our own deadline is a **timeout**, not
  // an empty 200. Swallowing it made the caller see EMPTY_RESPONSE/200, which reads
  // as an authoritative answer — the device directory then dropped its bounded
  // snapshot for a failure it had meant to treat as temporary.
  it('reports a stalled response body as a temporary status-0 failure', async () => {
    mocks.netFetch.mockImplementationOnce((_url: string, opts: RequestInit) => Promise.resolve({
      ok: true,
      status: 200,
      json: () => new Promise((_yes, no) => {
        opts.signal?.addEventListener('abort', () => {
          const error = new Error('the body read was aborted');
          error.name = 'AbortError';
          no(error);
        }, { once: true });
      }),
    } as unknown as Response));
    try {
      await serverApiFetch('/api/device-link/devices', {
        baseUrl: 'https://api.example.invalid', timeoutMs: 5,
      });
      expect.fail('the stalled body must reject');
    } catch (error) {
      expect(error).toMatchObject({ code: 'NETWORK_ERROR', statusCode: 0 });
    }
  });

  // Unit: a 429 whose **body** stalls must still carry the server's retry deadline.
  // The deadline lives in the response headers; reading the body first used to lose
  // it, so the caller kept polling on its own cadence and the limit window slid.
  it('keeps the 429 retry deadline when the response body stalls', async () => {
    const now = Date.now();
    const headers = new Headers({ 'Retry-After': '120' });
    mocks.netFetch.mockImplementationOnce((_url: string, opts: RequestInit) => Promise.resolve({
      ok: false,
      status: 429,
      headers,
      json: () => new Promise((_yes, no) => {
        opts.signal?.addEventListener('abort', () => {
          const error = new Error('the body read was aborted');
          error.name = 'AbortError';
          no(error);
        }, { once: true });
      }),
    } as unknown as Response));
    try {
      await serverApiFetch('/api/device-link/devices', {
        baseUrl: 'https://api.example.invalid', timeoutMs: 5,
      });
      expect.fail('the stalled body must reject');
    } catch (error) {
      expect(error).toBeInstanceOf(ServerApiError);
      expect(error).toHaveProperty('retryAt', expect.any(Number));
      expect((error as ServerApiError).retryAt).toBeGreaterThanOrEqual(now + 120_000);
    }
  });

  // 限流期限要记在**真正服务了这次响应**的线路上:401 之后的共享刷新会把重试发到另一个
  // 端点,抛出的 ServerApiError 必须带出那一跳实际用的 base URL(servedBaseUrl)——
  // 调用方按它分桶记限流期限,记错桶会把没限流的端点也限住(Codex review #9360)。
  it('carries the base URL that actually served the 429 (servedBaseUrl) after a region-switching refresh', async () => {
    let baseUrl = 'https://resource.cn.example.com';
    mocks.getAccessToken.mockReturnValueOnce('token-cn').mockReturnValueOnce('token-global');
    mocks.refresh.mockImplementation(async () => {
      baseUrl = 'https://resource.global.example.com';
      return true;
    });
    mocks.netFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ error: { code: 'TOKEN_EXPIRED' } }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: new Headers({ 'Retry-After': '60' }),
        json: async () => ({ error: { code: 'RATE_LIMITED', message: 'rate limited' } }),
      } as unknown as Response);
    const error = await serverApiFetch('/api/resource', {
      baseUrl: () => baseUrl,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServerApiError);
    expect((error as ServerApiError).statusCode).toBe(429);
    expect((error as ServerApiError).retryAt).toBeGreaterThan(Date.now());
    // 服务这次响应的是刷新后的新端点:期限属于它,不是进请求时的旧端点。
    expect((error as ServerApiError).servedBaseUrl).toBe('https://resource.global.example.com');
  });

  // Unit: a 429 whose **headers** arrived but whose body stalls must still hand the
  // caller its rate-limit deadline when the **caller's** own deadline fires. The
  // device-link reader arms a signal for the whole read and registers it first, so
  // rawFetch rethrows the bare abort reason — without the deadline the caller keeps
  // polling inside the server's window (Codex review #9360).
  it('keeps the 429 retry deadline when the caller deadline fires while the body stalls', async () => {
    const now = Date.now();
    const headers = new Headers({ 'Retry-After': '120' });
    mocks.netFetch.mockImplementationOnce((_url: string, opts: RequestInit) => Promise.resolve({
      ok: false,
      status: 429,
      headers,
      json: () => new Promise((_yes, no) => {
        opts.signal?.addEventListener('abort', () => {
          const error = new Error('the body read was aborted');
          error.name = 'AbortError';
          no(error);
        }, { once: true });
      }),
    } as unknown as Response));
    const controller = new AbortController();
    const expired = Object.assign(new Error('device directory read deadline'), { name: 'TimeoutError' });
    const pending = serverApiFetch('/api/device-link/devices', {
      baseUrl: 'https://api.example.invalid', signal: controller.signal,
    }).then(() => { throw new Error('the aborted request must not succeed'); }, (error: unknown) => error);
    await vi.waitFor(() => expect(mocks.netFetch).toHaveBeenCalledTimes(1));
    controller.abort(expired);
    const error = await pending;
    // 中止本身照样是调用方给的那个原因(身份不变),只是上面补了期限与线路。
    expect(error).toBe(expired);
    expect(error).toHaveProperty('retryAt', expect.any(Number));
    expect((error as { retryAt: number }).retryAt).toBeGreaterThanOrEqual(now + 120_000);
  });

  // 测试价值
  // - 生产入口与可观察结果:`serverApiFetch` 读响应体时调用方总期限到点,抛给调用方的
  //   中止原因上带出的 `httpStatus`。
  // - Bug/规则依据:Codex review #9360「Preserve terminal status across response-body
  //   timeouts」—— 响应头已到、服务端已表态(401/403/404/429),只是正文卡住。状态被丢掉
  //   后调用方只能把它归一成「连不上」:设备目录那一路的失效广播不触发、终态也不停重读,
  //   渲染侧退避带着旧快照每 5–60 秒重试那个端点。
  // - 现有覆盖缺口:上面两个「正文卡住」用例只断言 retryAt(429)与身份不变,没有一个
  //   覆盖「非 OK 状态要被带出去」;也没有覆盖反例(200 + 卡住的正文不该带状态)。
  // - 最小失败输入:响应 ok:false/status:401 + json() 永不 settle + 调用方 abort。
  // - tier:unit(electron net 为进程内 fake)。
  it('carries the already-known non-OK status on the abort reason when the body stalls', async () => {
    mocks.netFetch.mockImplementationOnce((_url: string, opts: RequestInit) => Promise.resolve({
      ok: false,
      status: 401,
      json: () => new Promise((_yes, no) => {
        opts.signal?.addEventListener('abort', () => {
          const error = new Error('the body read was aborted');
          error.name = 'AbortError';
          no(error);
        }, { once: true });
      }),
    } as unknown as Response));
    const controller = new AbortController();
    const expired = Object.assign(new Error('device directory read deadline'), { name: 'TimeoutError' });
    const pending = serverApiFetch('/api/device-link/devices', {
      baseUrl: 'https://api.example.invalid', signal: controller.signal,
    }).then(() => { throw new Error('the aborted request must not succeed'); }, (error: unknown) => error);
    await vi.waitFor(() => expect(mocks.netFetch).toHaveBeenCalledTimes(1));
    controller.abort(expired);
    const error = await pending;
    // 身份不变(仍是调用方给的中止原因),只是上面补了已知的响应状态。
    expect(error).toBe(expired);
    expect(error).toHaveProperty('httpStatus', 401);
  });

  // 反例:200 + 卡住的正文是**暂时性**失败。带了状态上去,调用方会把一次超时当成权威
  // 响应处理,把有界旧快照一起丢掉(Codex review #9360 同一处)。
  it('does not attach a status when a 200 response body stalls', async () => {
    mocks.netFetch.mockImplementationOnce((_url: string, opts: RequestInit) => Promise.resolve({
      ok: true,
      status: 200,
      json: () => new Promise((_yes, no) => {
        opts.signal?.addEventListener('abort', () => {
          const error = new Error('the body read was aborted');
          error.name = 'AbortError';
          no(error);
        }, { once: true });
      }),
    } as unknown as Response));
    const controller = new AbortController();
    const expired = Object.assign(new Error('device directory read deadline'), { name: 'TimeoutError' });
    const pending = serverApiFetch('/api/device-link/devices', {
      baseUrl: 'https://api.example.invalid', signal: controller.signal,
    }).then(() => { throw new Error('the aborted request must not succeed'); }, (error: unknown) => error);
    await vi.waitFor(() => expect(mocks.netFetch).toHaveBeenCalledTimes(1));
    controller.abort(expired);
    const error = await pending;
    expect(error).toBe(expired);
    expect(error).not.toHaveProperty('httpStatus');
  });

  // 测试价值
  // - 生产入口与可观察结果:`serverApiFetch` 的真实入口,**只有 timeoutMs**(没有调用方
  //   signal)时响应头已到但正文卡住 → 抛出的 ServerApiError 带真实状态码,且 401 仍然
  //   走共享刷新路径。
  // - Bug/规则依据:Codex review #9360「Preserve HTTP status on internal response-body
  //   timeouts」—— 自己的超时把正文掐断时状态被归一成 0,已知的 401 不再进刷新 / 登出
  //   路径,400/403/404 也被当成连不上。
  // - 现有覆盖缺口:上面两个「正文卡住」用例都带调用方 signal(状态挂在中止原因上),
  //   没有覆盖**只有 timeoutMs** 的调用方(状态无处可挂,只能由响应本身带出去)。
  // - 最小失败输入:ok:false/status:401 + json() 永不 settle + 只传 timeoutMs。
  // - tier:unit(electron net 为进程内 fake)。
  it('keeps the known status when our own deadline cuts a non-OK body short', async () => {
    mocks.getAccessToken.mockReturnValue('token-a');
    mocks.netFetch.mockImplementation((_url: string, opts: RequestInit) => Promise.resolve({
      ok: false,
      status: 401,
      json: () => new Promise((_yes, no) => {
        opts.signal?.addEventListener('abort', () => {
          const error = new Error('the body read was aborted');
          error.name = 'AbortError';
          no(error);
        }, { once: true });
      }),
    } as unknown as Response));
    const error = await serverApiFetch('/api/device-link/devices', {
      baseUrl: 'https://api.example.invalid', timeoutMs: 5,
    }).then(() => { throw new Error('the stalled body must reject'); }, (error: unknown) => error);
    expect(error).toBeInstanceOf(ServerApiError);
    expect((error as ServerApiError).statusCode).toBe(401);
    // 状态保住之后,401 仍然走共享刷新(归一成 status 0 时这一步不会发生)。
    expect(mocks.refresh).toHaveBeenCalled();
  });

  it('keeps an unfamiliar original error and its cause while redacting secrets before logging', async () => {
    const cause = Object.assign(new Error('proxy refused tunnel https://api.example.invalid/account/private-account#private-fragment'),
      { code: 'NEW_PROXY_FAILURE' });
    const error = new TypeError('fetch failed: https://api.example.invalid/?key=private-value', { cause });
    Object.assign(error, { request: { body: 'private request body', token: 'private-token' } });
    mocks.netFetch.mockRejectedValueOnce(error);
    await expect(serverApiFetch('/api/resource', { baseUrl: 'https://api.example.invalid' })).rejects.toBeTruthy();
    const logged = JSON.stringify(mocks.logger.error.mock.calls);
    expect(logged).toContain('fetch failed');
    expect(logged).toContain('proxy refused tunnel');
    expect(logged).toContain('NEW_PROXY_FAILURE');
    expect(logged).toContain('https://api.example.invalid');
    expect(logged).not.toContain('private-account');
    expect(logged).not.toContain('private-fragment');
    expect(logged).not.toContain('private-value');
    expect(logged).not.toContain('private request body');
    expect(logged).not.toContain('private-token');
  });

  // Native JSON errors can quote the response body; transport read failures must stay diagnosable.
  it.each([
    { response: new Response('private display name'), logged: 'SyntaxError' },
    { response: { ok: true, status: 200,
      json: async () => { throw new TypeError('response stream closed'); } }, logged: 'response stream closed' },
  ])('logs a response failure without exposing its body or changing EMPTY_RESPONSE: $logged', async ({ response, logged }) => {
    mocks.netFetch.mockResolvedValueOnce(response);
    await expect(serverApiFetch('/api/resource', { baseUrl: 'https://api.example.invalid' }))
      .rejects.toMatchObject({ code: 'EMPTY_RESPONSE', statusCode: 200 });
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      'response read failed', '/api/resource', { status: 200 }, logged,
    );
    expect(JSON.stringify(mocks.logger.warn.mock.calls)).not.toContain('private display name');
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
    expect(mocks.refresh).toHaveBeenCalledWith({ serverRejectedToken: true });
    expect(bodyFactory).toHaveBeenCalledTimes(2);
    expect(mocks.netFetch).toHaveBeenNthCalledWith(
      1,
      'https://github-api.example.com/api/github/issues',
      expect.objectContaining({
        headers: expect.objectContaining({
          'Accept-Language': 'zh-CN',
          Authorization: 'Bearer token-a',
        }),
        body: JSON.stringify({ userName: 'Account A' }),
      }),
    );
    expect(mocks.netFetch).toHaveBeenNthCalledWith(
      2,
      'https://github-api.example.com/api/github/issues',
      expect.objectContaining({
        headers: expect.objectContaining({
          'Accept-Language': 'zh-CN',
          Authorization: 'Bearer token-b',
        }),
        body: JSON.stringify({ userName: 'Account B' }),
      }),
    );
  });

  it('refresh 切换区域后重新解析业务端点，避免新 token 重试到旧区域', async () => {
    let baseUrl = 'https://resource.cn.example.com';
    mocks.getAccessToken.mockReturnValueOnce('token-cn').mockReturnValueOnce('token-global');
    mocks.refresh.mockImplementation(async () => {
      baseUrl = 'https://resource.global.example.com';
      return true;
    });
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
    const resolveBaseUrl = vi.fn(() => baseUrl);

    await expect(
      serverApiFetch('/api/resource', {
        baseUrl: resolveBaseUrl,
      }),
    ).resolves.toEqual({ ok: true });

    expect(resolveBaseUrl).toHaveBeenCalledTimes(2);
    expect(mocks.netFetch).toHaveBeenNthCalledWith(
      1,
      'https://resource.cn.example.com/api/resource',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer token-cn' }),
      }),
    );
    expect(mocks.netFetch).toHaveBeenNthCalledWith(
      2,
      'https://resource.global.example.com/api/resource',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer token-global',
        }),
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

  it.each(['ACCOUNT_UNAVAILABLE', 'TOKEN_EXPIRED'])('detached teardown %s cannot refresh or invalidate the next account', async (code) => {
    mocks.getAccessToken.mockReturnValue('test-new-token');
    mocks.netFetch.mockResolvedValue({ ok: false, status: 401, json: async () => ({ error: { code } }) });
    await expect(serverApiFetch('/api/resource', {
      baseUrl: 'https://old-resource.example.test', token: 'test-old-token',
      skipAutoRefresh: true, skipSessionInvalidation: true,
    })).rejects.toMatchObject({ code, statusCode: 401 });
    expect(mocks.netFetch).toHaveBeenCalledWith('https://old-resource.example.test/api/resource',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer test-old-token' }) }));
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.invalidateSession).not.toHaveBeenCalled();
    expect(mocks.getAccessToken).not.toHaveBeenCalled();
  });

  it.each([
    ['read', 'ACCOUNT_UNAVAILABLE'], ['select', 'TOKEN_EXPIRED'], ['renew', 'ACCOUNT_UNAVAILABLE'],
  ] as const)('cancels the automation host %s request when its account changes', async (action, code) => {
    const { pluginAutomationAccount } = await import('../device-link/pluginAutomationHost.desktop.js');
    mocks.ownerScope = 'cloud:account-a:1';
    mocks.getAccessToken.mockReturnValue('test-token-a');
    let finish!: (response: Response) => void;
    mocks.netFetch.mockReturnValueOnce(new Promise<Response>(resolve => { finish = resolve; }));
    const account = pluginAutomationAccount('public/cindy-contacts');
    const requests = {
      read: () => account.read(),
      select: () => account.select(1, true),
      renew: () => account.run('renew', 'test-run', new AbortController().signal),
    };
    const pending = requests[action]();
    expect(mocks.netFetch).toHaveBeenCalledOnce();
    const requestSignal: AbortSignal = mocks.netFetch.mock.calls[0][1].signal;
    for (const invalidate of mocks.ownerInvalidations) invalidate();
    mocks.ownerScope = 'cloud:account-b:2';
    finish(new Response(JSON.stringify({ error: { code } }), { status: 401 }));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(requestSignal.aborted).toBe(true);
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.invalidateSession).not.toHaveBeenCalled();
    expect(mocks.ownerInvalidations.size).toBe(0);
  });

  it('retries a host selection for the same account and releases its listener on success', async () => {
    const { pluginAutomationAccount } = await import('../device-link/pluginAutomationHost.desktop.js');
    mocks.getAccessToken.mockReturnValue('test-token');
    mocks.refresh.mockResolvedValueOnce(true);
    const choice = { revision: 2, selected: true, isPrimary: true, deviceName: 'Home' };
    mocks.netFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'TOKEN_EXPIRED' } }), { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(choice)));
    await expect(pluginAutomationAccount('public/cindy-contacts').select(1, true)).resolves.toEqual(choice);
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(mocks.ownerInvalidations.size).toBe(0);
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
    expect(mocks.refresh).toHaveBeenCalledWith({ serverRejectedToken: true });
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

  it('⚠️ logLabel 路由模板代替真实 path 记日志（插件 ID 在浅层、redactedLogPath 挡不住）', async () => {
    // 2026-08-06 review：`/api/plugins/<pluginId>` 的 id 是第 3 段,redactedLogPath 会保留它 →
    // 外泄用户装的第三方插件身份。带 logLabel 的调用一律用模板记日志,真实 path / id 不落日志。
    mocks.getAccessToken.mockReturnValue('token-a');
    mocks.netFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({ error: { code: 'X', message: 'plugin cindy-github not found' } }),
      })
      .mockRejectedValueOnce(new Error('boom cindy-github'));

    await expect(
      serverApiFetch('/api/plugins/cindy-github/releases/rel-9/download', {
        baseUrl: 'https://plugins.example.com',
        redactErrorDetails: true,
        logLabel: '/api/plugins',
      }),
    ).rejects.toBeTruthy();
    await expect(
      serverApiFetch('/api/plugins/cindy-github', {
        baseUrl: 'https://plugins.example.com',
        redactErrorDetails: true,
        logLabel: '/api/plugins',
      }),
    ).rejects.toBeTruthy();

    const logged = JSON.stringify({
      error: mocks.logger.error.mock.calls,
      warn: mocks.logger.warn.mock.calls,
    });
    expect(logged).not.toContain('cindy-github'); // 插件身份不进日志
    expect(logged).not.toContain('rel-9');
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      'serverApiFetch.redacted_not_ok',
      'path=/api/plugins',
      'method=GET',
      'status=404',
      'code=HTTP_404',
    );
  });

  it('logLabel 在非 redact 分支也代替真实 path 且省掉 msg（上游 msg 可能回显身份）', async () => {
    mocks.getAccessToken.mockReturnValue('token-a');
    mocks.netFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({
        error: { code: 'SKILL_NOT_FOUND', message: 'skill secret-skill-name not found' },
      }),
    });
    await expect(
      serverApiFetch('/api/skills-hub/skills/secret-skill-name', {
        baseUrl: 'https://skills.example.com',
        logLabel: '/api/skills-hub',
      }),
    ).rejects.toMatchObject({ code: 'SKILL_NOT_FOUND' }); // 抛出的 code 不受影响,业务分支仍可用
    const logged = JSON.stringify(mocks.logger.warn.mock.calls);
    expect(logged).not.toContain('secret-skill-name'); // path 与 msg 都不外泄身份
    expect(logged).not.toContain('msg=');
    expect(logged).toContain('path=/api/skills-hub');
    expect(logged).toContain('code=SKILL_NOT_FOUND'); // 业务 code 仍记(它不是身份)
  });

  it.each(['providers', 'credentials'])('logs the BYOK %s endpoint and allowed upstream code without response details', async (endpoint) => {
    mocks.netFetch.mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: async () => ({
        error: { code: 'ORG_AI_GATEWAY_ERROR', message: 'private upstream body' },
        apiKey: 'invalid-test-secret',
      }),
    });
    const path = `/api/model-access/byok/${endpoint}`;
    await expect(serverApiFetch(`${path}?schemaVersion=1`, {
      baseUrl: 'https://model-access.example.com',
      redactErrorDetails: true,
      logLabel: path,
      allowedRedactedErrorCodes: ['ORG_AI_GATEWAY_ERROR'],
    })).rejects.toMatchObject({ code: 'ORG_AI_GATEWAY_ERROR', message: '请求失败 (502)' });
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      'serverApiFetch.redacted_not_ok',
      `path=${path}`,
      'method=GET',
      'status=502',
      'code=ORG_AI_GATEWAY_ERROR',
    );
    const logged = JSON.stringify(mocks.logger.warn.mock.calls);
    expect(logged).not.toContain('private upstream body');
    expect(logged).not.toContain('invalid-test-secret');
    expect(logged).not.toContain('schemaVersion');
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
    expect(logged).toContain('code=PLAN_CHANGE_NOT_AVAILABLE');
    expect(logged).not.toContain('private subscription detail');
    expect(logged).not.toContain('PRIVATE_SUBSCRIPTION_STATE');
  });

  // Regression: a 401 from an unauthenticated request (no Authorization header sent)
  // is not evidence of a rejected/expired token and must not trigger auth.refresh().
  it('does not auto-refresh on 401 when no Authorization token was sent', async () => {
    mocks.getAccessToken.mockReturnValue(null);
    mocks.netFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ error: { code: 'UNAUTHORIZED', message: '缺少 Bearer token' } }),
    });

    await expect(
      serverApiFetch('/api/device-link/devices', {
        baseUrl: 'https://device-link.example.com',
      }),
    ).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      statusCode: 401,
    });

    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.invalidateSession).not.toHaveBeenCalled();
  });
});
