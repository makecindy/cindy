/**
 * claudeProxyScopeGate.test.ts
 * ---------------------------------------------------------------------------
 * issue #886 端到端回归:cc routingTransform ① 段的 modelPrefixes 服务范围门。
 *
 * 现场:会话选了 xAI(SuperGrok 订阅直连,xai/grok-*)后,Claude Code CLI 内部的
 * 辅助调用(权限 auto 模式的安全分类器,wire model 为 claude-haiku-*)带着同一个
 * session header 进 proxy —— 修复前被 ① 段整会话路由拽到 api.x.ai(oauth-passthrough,
 * 凭证也不对)→ 必 4xx → 分类器 fail-closed → 该会话所有 Bash 命令被拦。
 *
 * 本测试用**真实** provider-route + session-provider-store + active-catalog(bundled),
 * 只 mock 触电模块,验证决策级行为:
 *   - xai 会话的 claude-* 请求落回 ② 段 spawn 默认路由(网关换 key / 直连订阅)
 *   - 显式选了供应商的会话,② 段不再写入计费路由观察表(registry 语义:只记默认路由会话)
 * (xai/ 前缀主请求由 ⓪ 段 bridge 接管,在 ①/② 之前,不受本改动影响 —— 该路径依赖
 *  bridge handler 注册,scope 门单测见 providerRoute.test.ts。)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../appCapabilities.js', () => ({
  getAppCapabilities: () => ({ canUseCindyGateway: true }),
}));

vi.mock('../logger-adapter', () => ({
  createMakerLogger: () => ({
    trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    child: vi.fn(function self() { return { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: self }; }),
  }),
  desktopMakerLogger: {
    trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    child: vi.fn(() => ({ trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
  },
}));
vi.mock('../runtime-configs', () => ({
  claudeUpstreamEndpoint: () => 'https://gateway.example.com',
}));
vi.mock('../silent-encrypted-retry-store', () => ({
  readSilentEncryptedRetrySettings: () => ({ enabled: false }),
}));
vi.mock('../claude-fast-mode-log', () => ({
  createClaudeFastModeRequestTransform: () => () => null,
  createClaudeFastModeResponseObserver: () => () => undefined,
}));

// 对外 token 鉴权:默认关闭 + 不命中(与真实 store 默认态一致,上面既有 scope-gate / Pi 用例不受影响)。
// 有界拒绝(P1)用例按需把 externalEnabled 翻开。
const externalAuthMock = vi.hoisted(() => ({
  externalEnabled: false,
  matchToken: (_token: string): boolean => false,
}));
vi.mock('../local-proxy-external-auth', () => ({
  isCindyLocalToken: (token: unknown) =>
    typeof token === 'string' && token.startsWith('cindy-local-'),
  isExternalAccessEnabled: () => externalAuthMock.externalEnabled,
  matchesExternalToken: (token: string) => externalAuthMock.matchToken(token),
}));

import {
  createExternalRoutingTransform,
  createModelRoutingTransform,
  setClaudeProxyGatewayKeyReader,
  setClaudeProxySessionIdResolver,
} from '../anthropic-compat-proxy-host';
import { setSessionProvider, clearSessionProvider } from '../session-provider-store';
import {
  readClaudeSessionRoute,
  resetClaudeSessionRouteRegistryForTest,
} from '../claude-session-route-registry';
import { setProviderOAuthTokenReader } from '../provider-route';
import {
  registerPiProxySession,
  resetPiProxySessionsForTest,
} from '../pi-proxy-session-auth';

const SESSION_HEADER = { 'x-claude-code-session-id': 'sdk-grok' };

function ctxWith(headers: Record<string, string>) {
  return { reqId: 1, method: 'POST', url: '/v1/messages', headers } as never;
}

describe('cc routingTransform — xAI 会话的辅助请求回落默认路由 (issue #886)', () => {
  let gatewayKey: string | null;

  beforeEach(() => {
    resetClaudeSessionRouteRegistryForTest();
    gatewayKey = 'sk-gw';
    setClaudeProxyGatewayKeyReader(() => gatewayKey);
    setClaudeProxySessionIdResolver((sdkId) => (sdkId === 'sdk-grok' ? 'sess-grok' : null));
    setSessionProvider('sess-grok', 'xai');
  });

  afterEach(() => {
    clearSessionProvider('sess-grok');
  });

  it('claude-haiku 分类器请求(oauth-spawn)→ 换网关 key,不去 api.x.ai', () => {
    const transform = createModelRoutingTransform();
    const decision = transform(
      { model: 'claude-haiku-4-5-20251001' },
      ctxWith({ ...SESSION_HEADER, authorization: 'Bearer sk-ant-oat01' }),
    );
    // 落到 ② 段 gatewayDefaultRouteDecision:换网关 key(绝不是 upstreamOverride api.x.ai)。
    expect(decision).toEqual({
      headerOverride: { 'x-api-key': 'sk-gw', authorization: 'Bearer sk-gw' },
    });
  });

  it('claude-haiku 分类器请求(gateway-spawn 带 x-api-key)→ passthrough 走默认网关', () => {
    const transform = createModelRoutingTransform();
    const decision = transform(
      { model: 'claude-haiku-4-5-20251001' },
      ctxWith({ ...SESSION_HEADER, 'x-api-key': 'sk-frozen' }),
    );
    expect(decision).toBeNull();
  });

  it('claude-haiku 分类器请求(provider-oauth spawn 带占位 x-api-key)→ 换网关 key,不 passthrough (#831)', () => {
    // codex→cc 切换后的 openai/xai 来源会话:cc 子进程 env 里是占位 key,分类器请求带着它
    // 落到 ② 段。占位 key 不是可用凭证,按「无凭证」处理换网关 key;此前被误判成
    // gateway-spawn passthrough → 网关确定性 401 → 首次权限请求即 auto→ask 降级。
    const transform = createModelRoutingTransform();
    const decision = transform(
      { model: 'claude-haiku-4-5-20251001' },
      ctxWith({ ...SESSION_HEADER, 'x-api-key': 'xdt-provider-auth-placeholder-key' }),
    );
    expect(decision).toEqual({
      headerOverride: { 'x-api-key': 'sk-gw', authorization: 'Bearer sk-gw' },
    });
  });

  it('占位 x-api-key 且无网关 key → 维持 passthrough(与改动前行为一致,上游 401)', () => {
    gatewayKey = null;
    const transform = createModelRoutingTransform();
    const decision = transform(
      { model: 'claude-haiku-4-5-20251001' },
      ctxWith({ ...SESSION_HEADER, 'x-api-key': 'xdt-provider-auth-placeholder-key' }),
    );
    expect(decision).toBeNull();
  });

  it('claude-haiku 分类器请求(无网关 key 的 oauth-spawn)→ 直连 Anthropic 订阅', () => {
    gatewayKey = null;
    const transform = createModelRoutingTransform();
    const decision = transform(
      { model: 'claude-haiku-4-5-20251001' },
      ctxWith({ ...SESSION_HEADER, authorization: 'Bearer sk-ant-oat01' }),
    );
    expect(decision).toEqual({ upstreamOverride: 'https://api.anthropic.com' });
  });

  it('显式选了供应商的会话,② 段回落不写入计费路由观察表(registry 只记默认路由会话)', () => {
    const transform = createModelRoutingTransform();
    transform(
      { model: 'claude-haiku-4-5-20251001' },
      ctxWith({ ...SESSION_HEADER, authorization: 'Bearer sk-ant-oat01' }),
    );
    expect(readClaudeSessionRoute('sess-grok')).toBeNull();
  });

  it('未选供应商的会话行为不变:② 段照常记录默认路由(no-break)', () => {
    clearSessionProvider('sess-grok');
    const transform = createModelRoutingTransform();
    transform(
      { model: 'claude-opus-4-8[1m]' },
      ctxWith({ ...SESSION_HEADER, authorization: 'Bearer sk-ant-oat01' }),
    );
    expect(readClaudeSessionRoute('sess-grok')).toBe('gateway');
  });
});

describe('pi routingTransform — xdt session header selects the Pi provider route', () => {
  afterEach(() => {
    clearSessionProvider('sess-pi');
    setProviderOAuthTokenReader(() => null);
    resetPiProxySessionsForTest();
  });

  it('routes an Anthropic Pi request with host-managed OAuth and strips Pi placeholder auth', async () => {
    setClaudeProxyGatewayKeyReader(() => 'sk-gw');
    setSessionProvider('sess-pi', 'anthropic');
    setProviderOAuthTokenReader((providerId, agent) =>
      providerId === 'anthropic' && agent === 'pi' ? Promise.resolve('pi-claude-token') : null,
    );
    registerPiProxySession('sess-pi', 'session-secret');
    const decision = createModelRoutingTransform()(
      { model: 'claude-opus-5' },
      ctxWith({
        'x-cindy-pi-session-id': 'sess-pi',
        'x-cindy-pi-session-token': 'session-secret',
        'x-api-key': 'cindy-pi-provider-auth-placeholder',
      }),
    );
    await expect(Promise.resolve(decision)).resolves.toEqual({
      upstreamOverride: 'https://api.anthropic.com',
      headerOverride: {
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20',
        authorization: 'Bearer pi-claude-token',
      },
      headerDelete: [
        'x-api-key',
        'x-cindy-pi-session-id',
        'x-cindy-pi-session-token',
      ],
    });
  });

  it('rejects a forged session id before provider credentials can be selected', async () => {
    setSessionProvider('sess-pi', 'anthropic');
    registerPiProxySession('sess-pi', 'real-secret');
    const decision = await createModelRoutingTransform()(
      { model: 'claude-opus-5' },
      ctxWith({
        'x-cindy-pi-session-id': 'sess-pi',
        'x-cindy-pi-session-token': 'wrong-secret',
      }),
    );
    expect(decision).toEqual({ localHandler: expect.any(Function) });

    const response = {
      status: 0,
      body: '',
      writeHead(status: number) { this.status = status; },
      end(body: string) { this.body = body; },
    };
    await decision?.localHandler?.({ res: response } as never);
    expect(response.status).toBe(401);
    expect(response.body).toContain('invalid_pi_session_token');
  });

  it('never forwards an orphaned internal Pi token header', async () => {
    const decision = await Promise.resolve(createModelRoutingTransform()(
      { model: 'claude-opus-5' },
      ctxWith({ 'x-cindy-pi-session-token': 'orphaned-secret' }),
    ));
    expect(decision).toMatchObject({
      headerDelete: ['x-cindy-pi-session-id', 'x-cindy-pi-session-token'],
    });
    expect(decision?.headerOverride).not.toHaveProperty('x-cindy-pi-session-token');
  });
});

describe('cc 对外端口有界拒绝 (P1: 匿名/伪造客户端不得白嫖网关 key,#1666 端口拆分)', () => {
  // 端口拆分后,对外判定全部落在**独立对外端口**的 createExternalRoutingTransform 上:放行的
  // 唯一条件是命中不可伪造的对外 token;伪造 session-header / authorization 在此端口上毫无作用。
  async function drainLocalHandler(
    decision: unknown,
  ): Promise<{ status: number; body: { error?: { code?: string } } | null }> {
    const res = {
      status: 0,
      raw: '',
      writeHead(status: number) { this.status = status; },
      end(chunk: string) { this.raw = chunk; },
    };
    await (decision as { localHandler?: (arg: { res: unknown }) => Promise<void> })
      .localHandler?.({ res } as never);
    return { status: res.status, body: res.raw ? JSON.parse(res.raw) : null };
  }

  beforeEach(() => {
    // 即使网关 key 就绪,匿名请求也必须被拒 —— 证明它不会借道 gatewayDefaultRouteDecision。
    setClaudeProxyGatewayKeyReader(() => 'sk-gw');
    setClaudeProxySessionIdResolver(() => null);
  });

  afterEach(() => {
    externalAuthMock.externalEnabled = false;
  });

  it('对外端口:无 x-api-key + 无 authorization + 无会话头 → 401 external_token_required', async () => {
    externalAuthMock.externalEnabled = true;
    const decision = await Promise.resolve(createExternalRoutingTransform()(
      { model: 'claude-opus-4-8' },
      ctxWith({}),
    ));
    const { status, body } = await drainLocalHandler(decision);
    expect(status).toBe(401);
    expect(body?.error?.code).toBe('external_token_required');
  });

  it('对外端口:伪造 authorization bearer + 无 x-api-key + 无会话头 → 仍 401(假 bearer 不得绕过 #1666)', async () => {
    externalAuthMock.externalEnabled = true;
    // 本机进程随手编一个 Bearer:既没有可用 x-api-key,也没有命中的对外 token。对外端口无 session
    // 启发式,放行只认对外 token,故仍按匿名客户端拒绝 —— 假 bearer / 伪造会话头都绕不过去。
    const decision = await Promise.resolve(createExternalRoutingTransform()(
      { model: 'claude-opus-4-8' },
      ctxWith({ authorization: 'Bearer anything', 'x-claude-code-session-id': 'forged' }),
    ));
    const { status, body } = await drainLocalHandler(decision);
    expect(status).toBe(401);
    expect(body?.error?.code).toBe('external_token_required');
  });
});

describe('cc 内部端口 (端口拆分后内部路由不再承担对外判定,字节级不变)', () => {
  beforeEach(() => {
    setClaudeProxyGatewayKeyReader(() => 'sk-gw');
    setClaudeProxySessionIdResolver(() => null);
  });

  afterEach(() => {
    externalAuthMock.externalEnabled = false;
  });

  it('内部 oauth-spawn 子进程(带 authorization bearer + 会话头)→ ② 段默认路由换网关 key', async () => {
    // 对外访问开启也不影响内部端口:内部 transform 不再有对外闸,走 ② 段默认路由。
    externalAuthMock.externalEnabled = true;
    const decision = await Promise.resolve(createModelRoutingTransform()(
      { model: 'claude-opus-4-8' },
      ctxWith({ 'x-claude-code-session-id': 'sdk-unresolved', authorization: 'Bearer sk-ant-oat01' }),
    ));
    expect(decision).toEqual({
      headerOverride: { 'x-api-key': 'sk-gw', authorization: 'Bearer sk-gw' },
    });
  });

  it('内部匿名请求(oauth-spawn 无 key)→ 直连订阅,字节级不变', async () => {
    externalAuthMock.externalEnabled = false;
    setClaudeProxyGatewayKeyReader(() => null);
    const decision = await Promise.resolve(createModelRoutingTransform()(
      { model: 'claude-opus-4-8' },
      ctxWith({ authorization: 'Bearer sk-ant-oat01' }),
    ));
    expect(decision).toEqual({ upstreamOverride: 'https://api.anthropic.com' });
  });
});

describe('cc routingTransform 外部路径白名单 (P2: 对外只服务 /v1/messages + GET /v1/models, #1666)', () => {
  const GOOD_TOKEN = 'cindy-local-good-external-token';

  async function drainLocalHandler(
    decision: unknown,
  ): Promise<{ status: number; body: { error?: { code?: string } } | null }> {
    const res = {
      status: 0,
      raw: '',
      writeHead(status: number) { this.status = status; },
      end(chunk: string) { this.raw = chunk; },
    };
    await (decision as { localHandler?: (arg: { res: unknown }) => Promise<void> })
      .localHandler?.({ res } as never);
    return { status: res.status, body: res.raw ? JSON.parse(res.raw) : null };
  }

  function ctx(method: string, url: string, headers: Record<string, string>) {
    return { reqId: 1, method, url, headers } as never;
  }

  beforeEach(() => {
    // 命中对外 token → 判定外部客户端;开启对外访问,让请求进入 routeExternalClient。
    externalAuthMock.externalEnabled = true;
    externalAuthMock.matchToken = (token: string) => token === GOOD_TOKEN;
    setClaudeProxyGatewayKeyReader(() => 'sk-gw');
    setClaudeProxySessionIdResolver(() => null);
  });

  afterEach(() => {
    externalAuthMock.externalEnabled = false;
    externalAuthMock.matchToken = () => false;
  });

  it('外部客户端 POST /v1/files → 404 unsupported_path(绝不带 Cindy 凭证转发到任意路径)', async () => {
    const decision = await Promise.resolve(createExternalRoutingTransform()(
      { model: 'claude-opus-4-8' },
      ctx('POST', '/v1/files', { 'x-api-key': GOOD_TOKEN }),
    ));
    const { status, body } = await drainLocalHandler(decision);
    expect(status).toBe(404);
    expect(body?.error?.code).toBe('unsupported_path');
  });

  it('外部客户端 POST /v1/complete(不带 model 的控制面调用)→ 404 unsupported_path', async () => {
    const decision = await Promise.resolve(createExternalRoutingTransform()(
      {},
      ctx('POST', '/v1/complete', { 'x-api-key': GOOD_TOKEN }),
    ));
    const { status, body } = await drainLocalHandler(decision);
    expect(status).toBe(404);
    expect(body?.error?.code).toBe('unsupported_path');
  });

  it('外部客户端 POST /v1/messages → 通过白名单(不是 unsupported_path)', async () => {
    const decision = await Promise.resolve(createExternalRoutingTransform()(
      { model: 'claude-opus-4-8' },
      ctx('POST', '/v1/messages', { 'x-api-key': GOOD_TOKEN }),
    ));
    // 可能路由成功(headerOverride/upstreamOverride)或 400 no_provider_for_model,
    // 但绝不是路径白名单的 404 —— 证明 /v1/messages 过闸。
    const asErr = decision as { localHandler?: unknown };
    if (asErr.localHandler) {
      const { body } = await drainLocalHandler(decision);
      expect(body?.error?.code).not.toBe('unsupported_path');
    } else {
      // 直接返回转发决策(headerOverride 等),显然不是 404。
      expect(decision).not.toBeNull();
    }
  });

  it('外部客户端 POST /v1/messages/count_tokens(子路径)→ 通过白名单', async () => {
    const decision = await Promise.resolve(createExternalRoutingTransform()(
      { model: 'claude-opus-4-8' },
      ctx('POST', '/v1/messages/count_tokens', { 'x-api-key': GOOD_TOKEN }),
    ));
    const asErr = decision as { localHandler?: unknown };
    if (asErr.localHandler) {
      const { body } = await drainLocalHandler(decision);
      expect(body?.error?.code).not.toBe('unsupported_path');
    } else {
      expect(decision).not.toBeNull();
    }
  });

  it('外部客户端 GET /v1/models → 本地吐清单(200,不受路径白名单影响)', async () => {
    const decision = await Promise.resolve(createExternalRoutingTransform()(
      {},
      ctx('GET', '/v1/models', { 'x-api-key': GOOD_TOKEN }),
    ));
    const { status } = await drainLocalHandler(decision);
    expect(status).toBe(200);
  });

  // 路径穿越(#1666 二轮 P1):前缀白名单会放行含 /v1/messages/ 的路径,若原样转发,规范化上游会把
  // dot-segment 解析成越权路径并带上 Cindy 注入的凭证。必须在过闸前按段拒绝 `.` / `..`。
  it('外部客户端 POST /v1/messages/../../v1/files → 404 unsupported_path(挡路径穿越)', async () => {
    const decision = await Promise.resolve(createExternalRoutingTransform()(
      { model: 'claude-opus-4-8' },
      ctx('POST', '/v1/messages/../../v1/files', { 'x-api-key': GOOD_TOKEN }),
    ));
    const { status, body } = await drainLocalHandler(decision);
    expect(status).toBe(404);
    expect(body?.error?.code).toBe('unsupported_path');
  });

  it('外部客户端 POST /v1/messages/%2e%2e/v1/files(百分号编码 ..)→ 404 unsupported_path', async () => {
    const decision = await Promise.resolve(createExternalRoutingTransform()(
      { model: 'claude-opus-4-8' },
      ctx('POST', '/v1/messages/%2e%2e/v1/files', { 'x-api-key': GOOD_TOKEN }),
    ));
    const { status, body } = await drainLocalHandler(decision);
    expect(status).toBe(404);
    expect(body?.error?.code).toBe('unsupported_path');
  });

  it('外部客户端 GET /v1/models/../messages(向 models 端点做穿越)→ 404 unsupported_path', async () => {
    const decision = await Promise.resolve(createExternalRoutingTransform()(
      {},
      ctx('GET', '/v1/models/../messages', { 'x-api-key': GOOD_TOKEN }),
    ));
    const { status, body } = await drainLocalHandler(decision);
    expect(status).toBe(404);
    expect(body?.error?.code).toBe('unsupported_path');
  });

  // 开头锚定(#1666 三轮 P2):白名单不锚开头时是「包含」判定,带任意前缀的路径同样命中,而无
  // pathOverride 时转发的是原样 ctx.url → 供应商侧收到未支持路径却带着 Cindy 注入的真实凭证。
  // 这些路径都不含 dot-segment,所以只有开头锚定能挡住(与上面的穿越用例是两条独立防线)。
  it.each([
    ['POST', '/anything/v1/messages'],
    ['POST', '/v2/v1/messages'],
    ['POST', '/proxy/deep/v1/messages/count_tokens'],
  ])('外部客户端 %s %s(带前缀绕过白名单)→ 404 unsupported_path', async (method, url) => {
    const decision = await Promise.resolve(createExternalRoutingTransform()(
      { model: 'claude-opus-4-8' },
      ctx(method, url, { 'x-api-key': GOOD_TOKEN }),
    ));
    const { status, body } = await drainLocalHandler(decision);
    expect(status).toBe(404);
    expect(body?.error?.code).toBe('unsupported_path');
  });

  it('外部客户端 GET /anything/v1/models(带前缀)→ 不走本地清单,落 404 unsupported_path', async () => {
    const decision = await Promise.resolve(createExternalRoutingTransform()(
      {},
      ctx('GET', '/anything/v1/models', { 'x-api-key': GOOD_TOKEN }),
    ));
    const { status, body } = await drainLocalHandler(decision);
    expect(status).toBe(404);
    expect(body?.error?.code).toBe('unsupported_path');
  });

  // absolute-form 请求(HTTP/1.1 允许对代理发 `POST http://host/path`):此时 req.url 不以 `/` 开头,
  // 开头锚定顺带把它挡在外面,不会因为「含 /v1/messages」而带凭证转发到别的 origin。
  it('外部客户端 POST http://evil.example/v1/messages(absolute-form)→ 404 unsupported_path', async () => {
    const decision = await Promise.resolve(createExternalRoutingTransform()(
      { model: 'claude-opus-4-8' },
      ctx('POST', 'http://evil.example/v1/messages', { 'x-api-key': GOOD_TOKEN }),
    ));
    const { status, body } = await drainLocalHandler(decision);
    expect(status).toBe(404);
    expect(body?.error?.code).toBe('unsupported_path');
  });
});
