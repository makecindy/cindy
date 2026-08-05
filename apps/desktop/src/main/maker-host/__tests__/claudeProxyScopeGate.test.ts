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
  matchToken: (_token: string) => false,
}));
vi.mock('../local-proxy-external-auth', () => ({
  isCindyLocalToken: (token: unknown) =>
    typeof token === 'string' && token.startsWith('cindy-local-'),
  isExternalAccessEnabled: () => externalAuthMock.externalEnabled,
  matchesExternalToken: (token: string) => externalAuthMock.matchToken(token),
}));

import {
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

describe('cc routingTransform 有界拒绝 (P1: 匿名客户端不得白嫖网关 key)', () => {
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

  it('对外开启 + 无会话 + 无 x-api-key + 无 authorization + 无会话头 → 401 external_token_required', async () => {
    externalAuthMock.externalEnabled = true;
    const decision = await Promise.resolve(createModelRoutingTransform()(
      { model: 'claude-opus-4-8' },
      ctxWith({}),
    ));
    const { status, body } = await drainLocalHandler(decision);
    expect(status).toBe(401);
    expect(body?.error?.code).toBe('external_token_required');
  });

  it('伪造 authorization bearer + 无 x-api-key + 无会话头 → 仍 401(假 bearer 不得绕过 #1666)', async () => {
    externalAuthMock.externalEnabled = true;
    // 本机进程随手编一个 Bearer:既没有可用 x-api-key,也没有 x-claude-code-session-id 会话头。
    // 修复前「带 authorization 即豁免」会放它落到 gatewayDefaultRouteDecision 白嫖网关 key;
    // 修复后 authorization 不再作豁免,仍按匿名客户端拒绝。
    const decision = await Promise.resolve(createModelRoutingTransform()(
      { model: 'claude-opus-4-8' },
      ctxWith({ authorization: 'Bearer anything' }),
    ));
    const { status, body } = await drainLocalHandler(decision);
    expect(status).toBe(401);
    expect(body?.error?.code).toBe('external_token_required');
  });

  it('内部 oauth-spawn 子进程(带 authorization bearer + 会话头)不被有界拒绝命中', async () => {
    externalAuthMock.externalEnabled = true;
    // 带 x-claude-code-session-id(任何 cc 子进程都带)+ OAuth bearer,但会话解析不出(注册时序窗口)。
    const decision = await Promise.resolve(createModelRoutingTransform()(
      { model: 'claude-opus-4-8' },
      ctxWith({ 'x-claude-code-session-id': 'sdk-unresolved', authorization: 'Bearer sk-ant-oat01' }),
    ));
    // 不是 401 有界拒绝:落到 ② 段默认路由,oauth-spawn 换网关 key。
    expect(decision).toEqual({
      headerOverride: { 'x-api-key': 'sk-gw', authorization: 'Bearer sk-gw' },
    });
  });

  it('对外关闭时不启用闸:匿名请求按内部默认路由(oauth-spawn 无 key)→ 直连订阅,字节级不变', async () => {
    externalAuthMock.externalEnabled = false;
    setClaudeProxyGatewayKeyReader(() => null);
    const decision = await Promise.resolve(createModelRoutingTransform()(
      { model: 'claude-opus-4-8' },
      ctxWith({ authorization: 'Bearer sk-ant-oat01' }),
    ));
    expect(decision).toEqual({ upstreamOverride: 'https://api.anthropic.com' });
  });
});
