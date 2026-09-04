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

import {
  createModelRoutingTransform,
  piGatewayRequestAgent,
  setClaudeProxyGatewayKeyReader,
  setClaudeProxyOwnerBoundaryPendingChecker,
  setClaudeProxyOwnerScopeKeyReader,
  setClaudeProxySessionIdResolver,
} from '../anthropic-compat-proxy-host';
import { setSessionProvider, clearSessionProvider } from '../session-provider-store';
import {
  readClaudeSessionRoute,
  resetClaudeSessionRouteRegistryForTest,
} from '../claude-session-route-registry';
import { setPendingCredentialSwitchReader, setProviderOAuthTokenReader } from '../provider-route';
import {
  authenticatePiProxySession,
  registerPiProxySession,
  resetPiProxySessionsForTest,
} from '../pi-proxy-session-auth';

describe('Pi Gateway request front door', () => {
  it.each([
    ['/v1/messages', 'claude-code'],
    ['/v1/responses', 'codex'],
    ['/v1/chat/completions', 'codex'],
    ['/v1beta/models/gemini-3.6-flash:streamGenerateContent', 'codex'],
  ] as const)('routes %s through the Gateway %s credential surface', (url, agent) => {
    expect(piGatewayRequestAgent(url)).toBe(agent);
  });
});

const SESSION_HEADER = { 'x-claude-code-session-id': 'sdk-grok' };

function ctxWith(headers: Record<string, string>, url = '/v1/messages') {
  return { reqId: 1, method: 'POST', url, headers } as never;
}

describe('cc routingTransform — xAI 会话的辅助请求回落默认路由 (issue #886)', () => {
  let gatewayKey: string | null;

  beforeEach(() => {
    resetClaudeSessionRouteRegistryForTest();
    gatewayKey = 'sk-gw';
    setClaudeProxyGatewayKeyReader(() => gatewayKey);
    setClaudeProxySessionIdResolver((sdkId) => (sdkId === 'sdk-grok' ? 'sess-grok' : null));
    setSessionProvider('sess-grok', 'xai');
    setPendingCredentialSwitchReader(() => undefined);
  });

  afterEach(() => {
    clearSessionProvider('sess-grok');
    setPendingCredentialSwitchReader(() => undefined);
    setClaudeProxyOwnerBoundaryPendingChecker(() => false);
    setClaudeProxyOwnerScopeKeyReader(() => '');
  });

  it('订阅直连目标也在进入 bridge 前拦截 pending switch', async () => {
    setPendingCredentialSwitchReader(() => ({
      model: 'chatgpt/gpt-5.5',
      providerId: 'openai',
      previousModel: 'claude-opus-4-8',
    }));
    const decision = await Promise.resolve(
      createModelRoutingTransform()(
        { model: 'chatgpt/gpt-5.5' },
        ctxWith({ ...SESSION_HEADER, authorization: 'Bearer sk-ant-oat01' }),
      ),
    );
    const writeHead = vi.fn();
    const end = vi.fn();
    await decision?.localHandler?.({ res: { writeHead, end } } as never);
    expect(writeHead).toHaveBeenCalledWith(503, expect.any(Object));
    expect(JSON.parse(end.mock.calls[0][0])).toMatchObject({
      error: { code: 'provider_switch_pending' },
    });
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

  it('裸 grok-4.6 不 fail-open 进默认网关,改走订阅桥或拒绝', async () => {
    clearSessionProvider('sess-grok');
    const transform = createModelRoutingTransform();
    const decision = await Promise.resolve(
      transform(
        { model: 'grok-4.6' },
        ctxWith({ ...SESSION_HEADER, authorization: 'Bearer sk-ant-oat01' }),
      ),
    );
    expect(decision?.localHandler).toEqual(expect.any(Function));
    expect(decision).not.toEqual(expect.objectContaining({
      headerOverride: expect.anything(),
    }));
  });

  it('内置 gemini 会话上的裸 grok-4.6 也拒绝进 SuperGrok,不靠 ID 白名单', async () => {
    setSessionProvider('sess-grok', 'gemini');
    const transform = createModelRoutingTransform();
    const decision = await Promise.resolve(
      transform(
        { model: 'grok-4.6' },
        ctxWith({ ...SESSION_HEADER, authorization: 'Bearer sk-ant-oat01' }),
      ),
    );
    const writeHead = vi.fn();
    const end = vi.fn();
    await decision?.localHandler?.({ res: { writeHead, end } } as never);
    expect(writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    expect(JSON.parse(end.mock.calls[0][0])).toMatchObject({
      error: { code: 'exclusive_xai_route_required' },
    });
  });

  it('内置 anthropic 会话上的裸 grok-4.6 拒绝进 SuperGrok,避免来源与记账分叉', async () => {
    setSessionProvider('sess-grok', 'anthropic');
    const transform = createModelRoutingTransform();
    const decision = await Promise.resolve(
      transform(
        { model: 'grok-4.6' },
        ctxWith({ ...SESSION_HEADER, authorization: 'Bearer sk-ant-oat01' }),
      ),
    );
    const writeHead = vi.fn();
    const end = vi.fn();
    await decision?.localHandler?.({ res: { writeHead, end } } as never);
    expect(writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    expect(JSON.parse(end.mock.calls[0][0])).toMatchObject({
      error: { code: 'exclusive_xai_route_required' },
    });
  });

  it('显式自定义供应商的裸 grok-4.6 不被 SuperGrok bridge 改写成 xai/', async () => {
    setSessionProvider('sess-grok', 'my-litellm');
    const transform = createModelRoutingTransform();
    const parsedBody = { model: 'grok-4.6' };
    const decision = await Promise.resolve(
      transform(
        parsedBody,
        ctxWith({ ...SESSION_HEADER, authorization: 'Bearer sk-ant-oat01' }),
      ),
    );
    const writeHead = vi.fn();
    const end = vi.fn();
    await decision?.localHandler?.({
      parsedBody,
      res: { writeHead, end },
    } as never);
    expect(parsedBody.model).toBe('grok-4.6');
    expect(parsedBody.model.startsWith('xai/')).toBe(false);
  });

  it('网关风格 x-ai/grok-4.6 仍走默认路由(不是 SuperGrok 独占户口)', async () => {
    clearSessionProvider('sess-grok');
    const transform = createModelRoutingTransform();
    // ①.5 隐式来源解析经 providerViewsReader 为异步;决策内容与同步时代逐字段一致,
    // 这里 await 后锁定的仍是「默认路由 + 网关换 key」这层语义。
    const decision = await Promise.resolve(
      transform(
        { model: 'x-ai/grok-4.6' },
        ctxWith({ ...SESSION_HEADER, authorization: 'Bearer sk-ant-oat01' }),
      ),
    );
    expect(decision).toEqual({
      headerOverride: { 'x-api-key': 'sk-gw', authorization: 'Bearer sk-gw' },
    });
  });
});

describe('cc routingTransform — owner boundary 不得把占位 key fail-open 到 LiteLLM', () => {
  const PLACEHOLDER = 'xdt-provider-auth-placeholder-key';
  const throwingResolver = () => {
    throw new Error('[PRECONDITION_FAILED] App session is switching; retry after the owner boundary settles.');
  };

  let gatewayKey: string | null;

  beforeEach(() => {
    resetClaudeSessionRouteRegistryForTest();
    gatewayKey = 'sk-gw';
    setClaudeProxyGatewayKeyReader(() => gatewayKey);
    setClaudeProxySessionIdResolver(throwingResolver);
    setClaudeProxyOwnerBoundaryPendingChecker(() => false);
    setClaudeProxyOwnerScopeKeyReader(() => '');
    setPendingCredentialSwitchReader(() => undefined);
  });

  afterEach(() => {
    setClaudeProxyOwnerBoundaryPendingChecker(() => false);
    setClaudeProxyOwnerScopeKeyReader(() => '');
    setPendingCredentialSwitchReader(() => undefined);
    resetPiProxySessionsForTest();
  });

  async function invokeLocalHandler(decision: Awaited<ReturnType<ReturnType<typeof createModelRoutingTransform>>>) {
    const writeHead = vi.fn();
    const end = vi.fn();
    await decision?.localHandler?.({ res: { writeHead, end, headersSent: false } } as never);
    return { writeHead, end };
  }

  it('resolver 抛 PRECONDITION_FAILED 时 xai/grok-4.6 仍走订阅桥/拒绝,不 passthrough', async () => {
    const decision = await Promise.resolve(
      createModelRoutingTransform()(
        { model: 'xai/grok-4.6' },
        ctxWith({ ...SESSION_HEADER, 'x-api-key': PLACEHOLDER }),
      ),
    );
    expect(decision?.localHandler).toEqual(expect.any(Function));
    expect(decision).not.toEqual(expect.objectContaining({
      headerOverride: expect.anything(),
    }));
  });

  it('boundary pending + 占位 key + 非订阅模型 → 503 Retry-After,不是 null', async () => {
    gatewayKey = null;
    setClaudeProxyOwnerBoundaryPendingChecker(() => true);
    const decision = await Promise.resolve(
      createModelRoutingTransform()(
        { model: 'claude-haiku-4-5-20251001' },
        ctxWith({ ...SESSION_HEADER, 'x-api-key': PLACEHOLDER }),
      ),
    );
    expect(decision).not.toBeNull();
    const { writeHead, end } = await invokeLocalHandler(decision);
    expect(writeHead).toHaveBeenCalledWith(503, expect.objectContaining({
      'retry-after': '1',
    }));
    expect(JSON.parse(end.mock.calls[0][0])).toMatchObject({
      error: { code: 'owner_boundary_pending' },
    });
  });

  it('boundary pending + 占位 key + 无 body(GET) → 503,不打默认上游', async () => {
    gatewayKey = null;
    setClaudeProxyOwnerBoundaryPendingChecker(() => true);
    const decision = await Promise.resolve(
      createModelRoutingTransform()(
        undefined,
        ctxWith({ ...SESSION_HEADER, 'x-api-key': PLACEHOLDER }, '/v1/models'),
      ),
    );
    const { writeHead, end } = await invokeLocalHandler(decision);
    expect(writeHead).toHaveBeenCalledWith(503, expect.objectContaining({
      'retry-after': '1',
    }));
    expect(JSON.parse(end.mock.calls[0][0])).toMatchObject({
      error: { code: 'owner_boundary_pending' },
    });
  });

  it('boundary pending 时订阅前缀模型也 503,不把旧 owner 的 OAuth 打到 SuperGrok', async () => {
    gatewayKey = null;
    setClaudeProxyOwnerBoundaryPendingChecker(() => true);
    const decision = await Promise.resolve(
      createModelRoutingTransform()(
        { model: 'xai/grok-4.6' },
        ctxWith({ ...SESSION_HEADER, 'x-api-key': PLACEHOLDER }),
      ),
    );
    const { writeHead, end } = await invokeLocalHandler(decision);
    expect(writeHead).toHaveBeenCalledWith(503, expect.objectContaining({
      'retry-after': '1',
    }));
    expect(JSON.parse(end.mock.calls[0][0])).toMatchObject({
      error: { code: 'owner_boundary_pending' },
    });
  });

  it('boundary pending 时 chatgpt/ 前缀同样 503,不读旧 owner 的 Codex OAuth', async () => {
    gatewayKey = null;
    setClaudeProxyOwnerBoundaryPendingChecker(() => true);
    const decision = await Promise.resolve(
      createModelRoutingTransform()(
        { model: 'chatgpt/gpt-5.5' },
        ctxWith({ ...SESSION_HEADER, 'x-api-key': PLACEHOLDER }),
      ),
    );
    const { writeHead, end } = await invokeLocalHandler(decision);
    expect(writeHead).toHaveBeenCalledWith(503, expect.objectContaining({
      'retry-after': '1',
    }));
    expect(JSON.parse(end.mock.calls[0][0])).toMatchObject({
      error: { code: 'owner_boundary_pending' },
    });
  });

  it('boundary pending 时 PI 原生 xai 转发也 503,不读旧 owner 的 Grok OAuth', async () => {
    gatewayKey = null;
    setClaudeProxyOwnerBoundaryPendingChecker(() => true);
    registerPiProxySession('sess-pi', 'session-secret', () => 'xai');
    const decision = await Promise.resolve(
      createModelRoutingTransform()(
        { model: 'grok-4.6' },
        ctxWith({
          'x-cindy-pi-session-id': 'sess-pi',
          'x-cindy-pi-session-token': 'session-secret',
          'x-cindy-pi-provider-id': 'xai',
          'x-api-key': PLACEHOLDER,
        }),
      ),
    );
    const { writeHead, end } = await invokeLocalHandler(decision);
    expect(writeHead).toHaveBeenCalledWith(503, expect.objectContaining({
      'retry-after': '1',
    }));
    expect(JSON.parse(end.mock.calls[0][0])).toMatchObject({
      error: { code: 'owner_boundary_pending' },
    });
  });

  it('finalize 之后、localHandler 调用前才 pending → 503,不读旧 owner OAuth', async () => {
    // Resolve normally so this exercises dispatch revalidation, not lookup failure.
    setClaudeProxySessionIdResolver(() => null);
    gatewayKey = null;
    let pending = false;
    setClaudeProxyOwnerBoundaryPendingChecker(() => pending);
    const decision = await Promise.resolve(
      createModelRoutingTransform()(
        { model: 'xai/grok-4.6' },
        ctxWith({ ...SESSION_HEADER, 'x-api-key': PLACEHOLDER }),
      ),
    );
    expect(decision?.localHandler).toEqual(expect.any(Function));
    pending = true;
    const { writeHead, end } = await invokeLocalHandler(decision);
    expect(writeHead).toHaveBeenCalledWith(503, expect.objectContaining({
      'retry-after': '1',
    }));
    expect(JSON.parse(end.mock.calls[0][0])).toMatchObject({
      error: { code: 'owner_boundary_pending' },
    });
  });

  it('finalize 之后 owner scope 变了但 pending 仍 false → 503,不读旧 owner OAuth', async () => {
    setClaudeProxySessionIdResolver(() => null);
    gatewayKey = null;
    let scopeKey = 'cloud:owner-a:1';
    setClaudeProxyOwnerBoundaryPendingChecker(() => false);
    setClaudeProxyOwnerScopeKeyReader(() => scopeKey);
    const decision = await Promise.resolve(
      createModelRoutingTransform()(
        { model: 'xai/grok-4.6' },
        ctxWith({ ...SESSION_HEADER, 'x-api-key': PLACEHOLDER }),
      ),
    );
    expect(decision?.localHandler).toEqual(expect.any(Function));
    scopeKey = 'cloud:owner-b:2';
    const { writeHead, end } = await invokeLocalHandler(decision);
    expect(writeHead).toHaveBeenCalledWith(503, expect.objectContaining({
      'retry-after': '1',
    }));
    expect(JSON.parse(end.mock.calls[0][0])).toMatchObject({
      error: { code: 'owner_boundary_pending' },
    });
  });

  it('resolver 抛错时即使有网关 key 也本地拒绝,不猜测请求归属 (#3631)', async () => {
    const decision = createModelRoutingTransform()(
      { model: 'claude-haiku-4-5-20251001' },
      ctxWith({ ...SESSION_HEADER, 'x-api-key': PLACEHOLDER }),
    );
    const { writeHead, end } = await invokeLocalHandler(await decision);
    expect(writeHead).toHaveBeenCalledWith(503, expect.any(Object));
    expect(JSON.parse(end.mock.calls[0][0])).toMatchObject({
      error: { code: 'routing_temporarily_unavailable' },
    });
  });
});

describe('pi routingTransform — xdt session header selects the Pi provider route', () => {
  afterEach(() => {
    clearSessionProvider('sess-pi');
    setProviderOAuthTokenReader(() => null);
    resetPiProxySessionsForTest();
  });

  it('an old disposer cannot remove a replacement registration with the same stable token', () => {
    const disposeOld = registerPiProxySession('sess-pi', 'stable-secret');
    const disposeReplacement = registerPiProxySession('sess-pi', 'stable-secret');

    disposeOld();
    expect(authenticatePiProxySession('sess-pi', 'stable-secret')).toBe(true);

    disposeReplacement();
    expect(authenticatePiProxySession('sess-pi', 'stable-secret')).toBe(false);
  });

  it('routes an Anthropic Pi request with host-managed OAuth and strips Pi placeholder auth', async () => {
    setClaudeProxyGatewayKeyReader(() => 'sk-gw');
    setSessionProvider('sess-pi', 'anthropic');
    setProviderOAuthTokenReader((providerId, agent) =>
      providerId === 'anthropic' && agent === 'pi' ? Promise.resolve('pi-claude-token') : null,
    );
    registerPiProxySession('sess-pi', 'session-secret', () => 'anthropic');
    const decision = createModelRoutingTransform()(
      { model: 'claude-opus-5' },
      ctxWith({
        'x-cindy-pi-session-id': 'sess-pi',
        'x-cindy-pi-session-token': 'session-secret',
        'x-cindy-pi-provider-id': 'anthropic',
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
        'x-cindy-pi-provider-id',
      ],
    });
  });

  it.each([
    ['/v1/messages', { 'x-api-key': 'sk-gw', authorization: 'Bearer sk-gw' }],
    ['/v1/responses', { authorization: 'Bearer sk-gw' }],
    ['/v1/chat/completions', { authorization: 'Bearer sk-gw' }],
    ['/v1beta/models/google/gemini-3.6-flash:streamGenerateContent', { authorization: 'Bearer sk-gw' }],
  ] as const)(
    'routes a cindy Gateway Pi request on %s through the matching Claude/Codex surface',
    async (url, headerOverride) => {
      setClaudeProxyGatewayKeyReader(() => 'sk-gw');
      setSessionProvider('sess-pi', 'xd');
      registerPiProxySession('sess-pi', 'gateway-session-secret', () => null);
      const decision = createModelRoutingTransform()(
        { model: 'gateway-model' },
        ctxWith({
          'x-cindy-pi-session-id': 'sess-pi',
          'x-cindy-pi-session-token': 'gateway-session-secret',
          ...(url.includes('/v1beta/')
            ? { 'x-goog-api-key': 'cindy-pi-provider-auth-placeholder' }
            : {}),
        }, url),
      );

      await expect(Promise.resolve(decision)).resolves.toEqual({
        headerOverride,
        headerDelete: [
          ...(url.includes('/v1beta/') ? ['x-goog-api-key'] : []),
          'x-cindy-pi-session-id',
          'x-cindy-pi-session-token',
          'x-cindy-pi-provider-id',
        ],
      });
    },
  );

  it('strips Google placeholder auth even when the live Gateway key is temporarily unavailable', async () => {
    setClaudeProxyGatewayKeyReader(() => null);
    setSessionProvider('sess-pi', 'xd');
    registerPiProxySession('sess-pi', 'gateway-session-secret', () => null);
    const decision = createModelRoutingTransform()(
      { model: 'google/gemini-3.6-flash' },
      ctxWith({
        'x-cindy-pi-session-id': 'sess-pi',
        'x-cindy-pi-session-token': 'gateway-session-secret',
        'x-goog-api-key': 'stale-gateway-key',
      }, '/v1beta/models/google/gemini-3.6-flash:streamGenerateContent'),
    );

    await expect(Promise.resolve(decision)).resolves.toEqual({
      headerDelete: [
        'x-goog-api-key',
        'x-cindy-pi-session-id',
        'x-cindy-pi-session-token',
        'x-cindy-pi-provider-id',
      ],
    });
  });

  it('routes a provider-null cindy Subagent by its API instead of inheriting the Anthropic parent', async () => {
    setClaudeProxyGatewayKeyReader(() => 'sk-gw');
    setSessionProvider('sess-pi', 'anthropic');
    registerPiProxySession(
      'sess-pi',
      'gateway-subagent-secret',
      () => null,
      { scope: 'subagent-route' },
    );
    const decision = createModelRoutingTransform()(
      { model: 'moonshotai/kimi-k3' },
      ctxWith({
        'x-cindy-pi-session-id': 'sess-pi',
        'x-cindy-pi-session-token': 'gateway-subagent-secret',
      }, '/v1/chat/completions'),
    );

    await expect(Promise.resolve(decision)).resolves.toEqual({
      headerOverride: { authorization: 'Bearer sk-gw' },
      headerDelete: [
        'x-cindy-pi-session-id',
        'x-cindy-pi-session-token',
        'x-cindy-pi-provider-id',
      ],
    });
  });

  it('routes an Anthropic Subagent by its pinned provider instead of the OpenAI parent route', async () => {
    setClaudeProxyGatewayKeyReader(() => 'sk-gw');
    setSessionProvider('sess-pi', 'openai');
    setProviderOAuthTokenReader((providerId, agent) =>
      providerId === 'anthropic' && agent === 'pi' ? Promise.resolve('pi-claude-token') : null,
    );
    registerPiProxySession(
      'sess-pi',
      'anthropic-subagent-secret',
      () => 'anthropic',
      { scope: 'subagent-route' },
    );
    const decision = createModelRoutingTransform()(
      { model: 'claude-fable-5' },
      ctxWith({
        'x-cindy-pi-session-id': 'sess-pi',
        'x-cindy-pi-session-token': 'anthropic-subagent-secret',
        'x-cindy-pi-provider-id': 'anthropic',
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
        'x-cindy-pi-provider-id',
      ],
    });
  });

  it.each([
    ['openai', '/codex/responses'],
    ['xai', '/v1/responses'],
    ['xai', '/v1/chat/completions'],
  ] as const)('routes native %s PI requests to a local raw forwarder at %s', (providerId, url) => {
    setSessionProvider('sess-pi', providerId);
    registerPiProxySession('sess-pi', 'session-secret', () => providerId);
    const decision = createModelRoutingTransform()(
      undefined,
      ctxWith({
          'x-cindy-pi-session-id': 'sess-pi',
          'x-cindy-pi-session-token': 'session-secret',
          'x-cindy-pi-provider-id': providerId,
      }, url),
    );

    expect(decision).toEqual({ localHandler: expect.any(Function) });
  });

  it('allows a provider-pinned Subagent token to cross the parent session route only for its provider', async () => {
    setSessionProvider('sess-pi', 'openai');
    registerPiProxySession('sess-pi', 'root-session-secret', () => 'openai');
    registerPiProxySession(
      'sess-pi',
      'xai-subagent-secret',
      () => 'xai',
      { scope: 'subagent-route' },
    );

    const allowed = createModelRoutingTransform()(
      undefined,
      ctxWith({
        'x-cindy-pi-session-id': 'sess-pi',
        'x-cindy-pi-session-token': 'xai-subagent-secret',
        'x-cindy-pi-provider-id': 'xai',
      }, '/v1/responses'),
    );
    expect(allowed).toEqual({ localHandler: expect.any(Function) });

    const rejected = await createModelRoutingTransform()(
      undefined,
      ctxWith({
        'x-cindy-pi-session-id': 'sess-pi',
        'x-cindy-pi-session-token': 'xai-subagent-secret',
        'x-cindy-pi-provider-id': 'openai',
      }, '/codex/responses'),
    );
    const response = {
      status: 0,
      body: '',
      writeHead(status: number) { this.status = status; },
      end(body: string) { this.body = body; },
    };
    await rejected?.localHandler?.({ res: response } as never);
    expect(response.status).toBe(403);
    expect(response.body).toContain('pi_provider_mismatch');
  });

  it.each([
    ['openai', '/codex/responses'],
    ['xai', '/v1/responses'],
  ] as const)('trusts the host-resolved implicit %s PI source when persistence is empty', (providerId, url) => {
    clearSessionProvider('sess-pi');
    registerPiProxySession('sess-pi', 'session-secret', () => providerId);
    const decision = createModelRoutingTransform()(
      undefined,
      ctxWith({
        'x-cindy-pi-session-id': 'sess-pi',
        'x-cindy-pi-session-token': 'session-secret',
        'x-cindy-pi-provider-id': providerId,
      }, url),
    );

    expect(decision).toEqual({ localHandler: expect.any(Function) });
  });

  it.each([
    ['openai', 'xai', '/v1/responses'],
    ['xai', 'openai', '/codex/responses'],
  ] as const)(
    'rejects a stale %s header after the host re-pins the PI session to %s',
    async (staleHeader, pinnedProvider, url) => {
      setSessionProvider('sess-pi', pinnedProvider);
      registerPiProxySession('sess-pi', 'session-secret', () => pinnedProvider);
      const decision = await createModelRoutingTransform()(
        undefined,
        ctxWith({
          'x-cindy-pi-session-id': 'sess-pi',
          'x-cindy-pi-session-token': 'session-secret',
          'x-cindy-pi-provider-id': staleHeader,
        }, url),
      );
      const response = {
        status: 0,
        body: '',
        writeHead(status: number) { this.status = status; },
        end(body: string) { this.body = body; },
      };

      await decision?.localHandler?.({ res: response } as never);

      expect(response.status).toBe(403);
      expect(response.body).toContain('pi_provider_mismatch');
    },
  );

  it('rejects an implicit native header that differs from the host-resolved PI source', async () => {
    clearSessionProvider('sess-pi');
    registerPiProxySession('sess-pi', 'session-secret', () => 'xai');
    const decision = await createModelRoutingTransform()(
      undefined,
      ctxWith({
        'x-cindy-pi-session-id': 'sess-pi',
        'x-cindy-pi-session-token': 'session-secret',
        'x-cindy-pi-provider-id': 'openai',
      }, '/codex/responses'),
    );
    const response = {
      status: 0,
      body: '',
      writeHead(status: number) { this.status = status; },
      end(body: string) { this.body = body; },
    };

    await decision?.localHandler?.({ res: response } as never);

    expect(response.status).toBe(403);
    expect(response.body).toContain('pi_provider_mismatch');
  });

  it('rejects a native provider header that does not match the Cindy session provider', async () => {
    setSessionProvider('sess-pi', 'anthropic');
    registerPiProxySession('sess-pi', 'session-secret', () => 'anthropic');
    const decision = await createModelRoutingTransform()(
      undefined,
      ctxWith({
          'x-cindy-pi-session-id': 'sess-pi',
          'x-cindy-pi-session-token': 'session-secret',
          'x-cindy-pi-provider-id': 'openai',
      }, '/codex/responses'),
    );
    const response = {
      status: 0,
      body: '',
      writeHead(status: number) { this.status = status; },
      end(body: string) { this.body = body; },
    };

    await decision?.localHandler?.({ res: response } as never);

    expect(response.status).toBe(403);
    expect(response.body).toContain('pi_provider_mismatch');
  });

  it('rejects a missing native provider header for an OpenAI PI session', async () => {
    setSessionProvider('sess-pi', 'openai');
    registerPiProxySession('sess-pi', 'session-secret', () => 'openai');
    const decision = await createModelRoutingTransform()(
      undefined,
      ctxWith({
        'x-cindy-pi-session-id': 'sess-pi',
        'x-cindy-pi-session-token': 'session-secret',
      }, '/codex/responses'),
    );
    const response = {
      status: 0,
      body: '',
      writeHead(status: number) { this.status = status; },
      end(body: string) { this.body = body; },
    };

    await decision?.localHandler?.({ res: response } as never);

    expect(response.status).toBe(403);
    expect(response.body).toContain('pi_provider_mismatch');
  });

  it('does not send an authenticated Anthropic PI request through the legacy prefix bridge', async () => {
    setClaudeProxyGatewayKeyReader(() => 'sk-gw');
    setSessionProvider('sess-pi', 'anthropic');
    registerPiProxySession('sess-pi', 'session-secret', () => 'anthropic');
    setProviderOAuthTokenReader((providerId, agent) =>
      providerId === 'anthropic' && agent === 'pi' ? Promise.resolve('pi-claude-token') : null,
    );
    const decision = createModelRoutingTransform()(
      { model: 'chatgpt/gpt-5.6-sol' },
      ctxWith({
        'x-cindy-pi-session-id': 'sess-pi',
        'x-cindy-pi-session-token': 'session-secret',
        'x-cindy-pi-provider-id': 'anthropic',
        'x-api-key': 'cindy-pi-provider-auth-placeholder',
      }),
    );

    await expect(Promise.resolve(decision)).resolves.toMatchObject({
      upstreamOverride: 'https://api.anthropic.com',
    });
  });

  it('rejects a forged session id before provider credentials can be selected', async () => {
    setSessionProvider('sess-pi', 'anthropic');
    registerPiProxySession('sess-pi', 'real-secret', () => 'anthropic');
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

  it('Pi 裸 grok-4.6 且未绑 xAI 时拒绝默认网关,不让 LiteLLM 报 Invalid model name', async () => {
    setClaudeProxyGatewayKeyReader(() => 'sk-gw');
    registerPiProxySession('sess-pi', 'session-secret');
    const decision = await Promise.resolve(createModelRoutingTransform()(
      { model: 'grok-4.6' },
      ctxWith({
        'x-cindy-pi-session-id': 'sess-pi',
        'x-cindy-pi-session-token': 'session-secret',
        'x-api-key': 'cindy-pi-provider-auth-placeholder',
      }),
    ));
    const writeHead = vi.fn();
    const end = vi.fn();
    await decision?.localHandler?.({ res: { writeHead, end } } as never);
    expect(writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    expect(JSON.parse(end.mock.calls[0][0])).toMatchObject({
      error: { code: 'exclusive_xai_route_required' },
    });
  });

  it('never forwards an orphaned internal Pi token header', async () => {
    const decision = await Promise.resolve(createModelRoutingTransform()(
      { model: 'claude-opus-5' },
      ctxWith({ 'x-cindy-pi-session-token': 'orphaned-secret' }),
    ));
    expect(decision).toMatchObject({
      headerDelete: [
        'x-cindy-pi-session-id',
        'x-cindy-pi-session-token',
        'x-cindy-pi-provider-id',
      ],
    });
    expect(decision?.headerOverride).not.toHaveProperty('x-cindy-pi-session-token');
  });
});
