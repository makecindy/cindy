/**
 * claudeProxyImplicitRoute.test.ts
 * ---------------------------------------------------------------------------
 * 回归:cc routingTransform ①.5 段 —— 未绑定/未反解出供应商的请求按模型隐式路由。
 *
 * 现场(智谱 GLM-5.3 事故):会话模型选了用户智谱来源的裸 catalog id(glm-5.3),
 * 会话启动/切模的首批请求抢在 session↔provider 绑定(session header 反解 / set-model
 * 落库)之前到达 proxy —— ① 段因 getSessionProvider 为 null 放空,② 段把请求透传给
 * 默认网关(LiteLLM)。网关只注册命名空间 id(z-ai/glm-5.3),裸 id 在模型校验层被拒:
 *   400 {'error': 'anthropic_messages: Invalid model name passed in model=glm-5.3. ...'}
 * Claude Code 把它 surface 成 API Error 400,靠重试恢复,用户侧表现为偶发报错。
 *
 * 本测试用真实 provider-route + active-catalog fixture,只 mock 触电模块,验证
 * 决策级行为(codex 侧同语义见 codexProxyHost ①.5;cc 侧为本次补齐):
 *   - 无会话 + 裸 glm-5.3 → ①.5 路由到用户智谱上游,鉴权头换成用户 key;
 *   - 会话已反解但未绑定供应商 + 裸 glm-5.3 → 同上(启动竞态的真实形态);
 *   - 网关命名空间 id(z-ai/glm-5.3)/ anthropic wire 模型(claude-*)/ 目录外模型
 *     → 不受 ①.5 影响,保持 ② 段默认路径(passthrough),#886 语义不回归。
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
  setClaudeProxyGatewayKeyReader,
  setClaudeProxySessionIdResolver,
} from '../anthropic-compat-proxy-host';
import {
  setCustomProviderKeyReader,
  setPendingCredentialSwitchReader,
  setProviderOAuthTokenReader,
  setProviderViewsReader,
} from '../provider-route';
import { getActiveCatalog, setCustomProviders } from '../active-catalog';
import * as providerRoute from '../provider-route';
import { buildRegistry, buildUserProvider } from '@cindy/model-providers';
import { clearSessionProvider, setSessionProvider } from '../session-provider-store';
import {
  readClaudeSessionRoute,
  resetClaudeSessionRouteRegistryForTest,
} from '../claude-session-route-registry';

const ZHIPU_UPSTREAM = 'https://open.bigmodel.example/api/anthropic';

function ctxWith(headers: Record<string, string>) {
  return { reqId: 1, method: 'POST', url: '/v1/messages', headers } as never;
}

function installZhipuProvider(): void {
  setCustomProviders([
    buildUserProvider({
      id: 'zhipu-plan',
      name: 'Zhipu Plan',
      runtimes: {
        'claude-code': {
          baseUrl: ZHIPU_UPSTREAM,
          wireProtocol: 'anthropic-messages',
          models: [{ id: 'glm-5.3', name: 'GLM-5.3' }],
        },
      },
    }),
  ]);
  setCustomProviderKeyReader(() => 'glm-user-key');
  setProviderViewsReader(async () => buildRegistry(getActiveCatalog(), { 'zhipu-plan': true }));
}

describe('cc routingTransform — ①.5 隐式来源路由 (智谱 glm-5.3 裸 id 事故回归)', () => {
  let transform: ReturnType<typeof createModelRoutingTransform>;

  beforeEach(() => {
    resetClaudeSessionRouteRegistryForTest();
    setClaudeProxyGatewayKeyReader(() => 'sk-gw');
    setClaudeProxySessionIdResolver(() => null);
    setPendingCredentialSwitchReader(() => undefined);
    setProviderOAuthTokenReader(() => null);
    clearSessionProvider('sess-race');
    installZhipuProvider();
    transform = createModelRoutingTransform();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setCustomProviders([]);
    setCustomProviderKeyReader(() => null);
    setProviderViewsReader(async () => []);
    clearSessionProvider('sess-race');
    resetClaudeSessionRouteRegistryForTest();
  });

  it('无会话头的裸 glm-5.3 → 路由到用户智谱上游并换用户 key,不再透传默认网关', async () => {
    const decision = await Promise.resolve(
      transform({ model: 'glm-5.3' }, ctxWith({ 'x-api-key': 'sk-gw' })),
    );
    // 修复前:① 段放空 → ② 段 passthrough → LiteLLM 对裸 id 400。
    expect(decision).toMatchObject({
      upstreamOverride: ZHIPU_UPSTREAM,
      headerOverride: {
        'x-api-key': 'glm-user-key',
        authorization: 'Bearer glm-user-key',
      },
    });
  });

  it('会话已反解但 provider 绑定未落(启动竞态)→ 同样走 ①.5 用户上游', async () => {
    setClaudeProxySessionIdResolver((sdkId) => (sdkId === 'sdk-race' ? 'sess-race' : null));
    const decision = await Promise.resolve(
      transform(
        { model: 'glm-5.3' },
        ctxWith({ 'x-claude-code-session-id': 'sdk-race', 'x-api-key': 'sk-gw' }),
      ),
    );
    expect(decision).toMatchObject({
      upstreamOverride: ZHIPU_UPSTREAM,
      headerOverride: { 'x-api-key': 'glm-user-key' },
    });
  });

  it('同一裸 model 有多个已连接来源时拒绝请求,不外发默认网关或写计费路由', async () => {
    const provider = (id: string, baseUrl: string) => buildUserProvider({
      id,
      name: id,
      runtimes: {
        'claude-code': {
          baseUrl,
          wireProtocol: 'anthropic-messages',
          models: [{ id: 'shared-model', name: 'Shared Model' }],
        },
      },
    });
    setCustomProviders([
      provider('provider-a', 'https://a.example/v1'),
      provider('provider-b', 'https://b.example/v1'),
    ]);
    setCustomProviderKeyReader((id) => `${id}-key`);
    setProviderViewsReader(async () => buildRegistry(getActiveCatalog(), {
      'provider-a': true,
      'provider-b': true,
    }));
    setClaudeProxySessionIdResolver((sdkId) => (sdkId === 'sdk-race' ? 'sess-race' : null));

    const decision = await Promise.resolve(
      transform(
        { model: 'shared-model' },
        ctxWith({ 'x-claude-code-session-id': 'sdk-race', 'x-api-key': 'sk-gw' }),
      ),
    );

    const writeHead = vi.fn();
    const end = vi.fn();
    await decision?.localHandler?.({ res: { writeHead, end } } as never);
    expect(writeHead).toHaveBeenCalledWith(503, expect.objectContaining({
      'retry-after': '1',
    }));
    expect(JSON.parse(end.mock.calls[0][0])).toMatchObject({
      error: { code: 'provider_route_ambiguous' },
    });
    expect(readClaudeSessionRoute('sess-race')).toBeNull();
  });

  it('网关命名空间 id(z-ai/glm-5.3)不受 ①.5 影响,保持默认 passthrough', async () => {
    const decision = await Promise.resolve(
      transform({ model: 'z-ai/glm-5.3' }, ctxWith({ 'x-api-key': 'sk-gw' })),
    );
    expect(decision).toBeNull();
  });

  it('anthropic wire 模型(claude-*)保持 ② 段默认路径 (#886 语义)', async () => {
    const decision = await Promise.resolve(
      transform({ model: 'claude-haiku-4-5' }, ctxWith({ 'x-api-key': 'sk-gw' })),
    );
    expect(decision).toBeNull();
  });

  it.each(['missing-provider', 'missing-runtime'] as const)(
    'bound custom provider fails closed while %s, then recovers on the next request (#3631)',
    async (missing) => {
      setClaudeProxySessionIdResolver(() => 'sess-race');
      setSessionProvider('sess-race', 'zhipu-plan');
      const headers = { 'x-claude-code-session-id': 'sdk-race', 'x-api-key': 'sk-gw' };
      // The real catalog refresh API can remove a provider or its Claude runtime
      // while the persisted session still points at that provider.
      setCustomProviders(missing === 'missing-provider' ? [] : [buildUserProvider({
        id: 'zhipu-plan', name: 'Zhipu Plan', runtimes: {},
      })]);
      const decision = await transform({ model: 'claude-opus-5' }, ctxWith(headers));
      const writeHead = vi.fn();
      const end = vi.fn();
      await decision?.localHandler?.({ res: { writeHead, end } } as never);
      expect(writeHead).toHaveBeenCalledWith(503, expect.objectContaining({ 'retry-after': '1' }));
      expect(JSON.parse(end.mock.calls[0][0])).toMatchObject({
        error: { code: 'provider_route_unavailable' },
      });
      expect(readClaudeSessionRoute('sess-race')).toBeNull();

      installZhipuProvider();
      const retry = await transform({ model: 'claude-opus-5' }, ctxWith(headers));
      expect(retry).toMatchObject({ upstreamOverride: ZHIPU_UPSTREAM });
    },
  );

  it('session resolver failure is not an unbound request and cannot borrow gateway credentials (#3631)', async () => {
    setClaudeProxySessionIdResolver(() => { throw new Error('session lookup unavailable'); });
    const decision = await transform({ model: 'claude-opus-5' }, ctxWith({
      'x-claude-code-session-id': 'sdk-race', 'x-api-key': 'sk-gw',
    }));
    const writeHead = vi.fn();
    const end = vi.fn();
    await decision?.localHandler?.({ res: { writeHead, end } } as never);
    expect(writeHead).toHaveBeenCalledWith(503, expect.any(Object));
    expect(JSON.parse(end.mock.calls[0][0])).toMatchObject({
      error: { code: 'routing_temporarily_unavailable' },
    });
  });

  it.each(['async-null', 'sync-throw', 'async-reject'] as const)(
    'an explicit custom route cannot fall through on %s (#3631)',
    async (failure) => {
      setClaudeProxySessionIdResolver(() => 'sess-race');
      setSessionProvider('sess-race', 'zhipu-plan');
      vi.spyOn(providerRoute, 'resolveSessionRouteDecision').mockImplementation(() => {
        if (failure === 'async-null') return Promise.resolve(null);
        if (failure === 'async-reject') return Promise.reject(new Error('route unavailable'));
        throw new Error('route unavailable');
      });
      const decision = await transform({ model: 'claude-opus-5' }, ctxWith({
        'x-claude-code-session-id': 'sdk-race', 'x-api-key': 'sk-gw',
      }));
      const writeHead = vi.fn();
      const end = vi.fn();
      await decision?.localHandler?.({ res: { writeHead, end } } as never);
      expect(writeHead).toHaveBeenCalledWith(503, expect.any(Object));
      expect(JSON.parse(end.mock.calls[0][0])).toMatchObject({
        error: { code: failure === 'async-null' ? 'provider_route_unavailable' : 'routing_temporarily_unavailable' },
      });
      expect(decision?.upstreamOverride).toBeUndefined();
      expect(decision?.headerOverride).toBeUndefined();
    },
  );

  it('目录外未知模型 → ①.5 解析落空,回落 ② 段默认(与修复前一致)', async () => {
    const decision = await Promise.resolve(
      transform({ model: 'who-knows-9' }, ctxWith({ 'x-api-key': 'sk-gw' })),
    );
    expect(decision).toBeNull();
  });

  it('未绑定会话的默认 passthrough 仍记 gateway 计费路由(② 段行为保留)', async () => {
    setClaudeProxySessionIdResolver((sdkId) => (sdkId === 'sdk-race' ? 'sess-race' : null));
    await Promise.resolve(
      transform(
        { model: 'z-ai/glm-5.3' },
        ctxWith({ 'x-claude-code-session-id': 'sdk-race', 'x-api-key': 'sk-gw' }),
      ),
    );
    expect(readClaudeSessionRoute('sess-race')).toBe('gateway');
  });
});
