import { afterEach, describe, it, expect, vi } from 'vitest';

const { mockGetAppCapabilities } = vi.hoisted(() => ({
  mockGetAppCapabilities: vi.fn(() => ({ canUseCindyGateway: true })),
}));

vi.mock('../../appCapabilities.js', () => ({
  getAppCapabilities: mockGetAppCapabilities,
}));

import {
  BUNDLED_CATALOG,
  buildRegistry,
  buildUserProvider,
  type AgentKind,
  type RoutingDescriptor,
} from '@cindy/model-providers';

import {
  beginProviderRouteMutation,
  buildLocalHandlerHeaders,
  buildRouteDecision,
  getSessionRoutingDescriptor,
  resolveSessionRoute,
  resolveSessionRouteDecision,
  resolveImplicitLocalBridgeRoute,
  inferProviderIdForModel,
  isUserProviderSession,
  setCustomProviderKeyReader,
  setProviderOAuthTokenReader,
  setProviderViewsReader,
  resolveImplicitProviderOAuthRouteDecision,
  rewriteImplicitModelIdForRoute,
  rewriteSessionModelIdForRoute,
} from '../provider-route.js';
import {
  getActiveCatalog,
  setAnthropicDiscoveredModels,
  setCustomProviders,
  setDiscoveredCodexModels,
  setXdGatewayModels,
} from '../active-catalog.js';
import { setSessionProvider, clearSessionProvider } from '../session-provider-store.js';
import { ANTHROPIC_DIRECT_UPSTREAM } from '../claude-gateway-config.js';

// CODEX_OAUTH_UPSTREAM 不直接 import —— codex-proxy-host.ts 在 import 期触电(app.getPath),
// 会让本测试在 vitest 无 electron 环境炸。其值稳定(codex-gateway-config.ts),这里以字面量锁定。
const CODEX_OAUTH_UPSTREAM = 'https://chatgpt.com/backend-api/codex';

/**
 * no-break 锁定:catalog 描述符经 buildRouteDecision 出来的路由,必须与退役前 decideXxxRoute
 * 在等价场景下逐字段一致。下面每个 toEqual 的**字面量**就是那条 no-break 基线 —— 任一字段漂移
 * 都会让现有用户路由被悄悄改掉,这个测试就是那道防线(规则 9/10/11)。
 */
function descriptor(providerId: string, agent: AgentKind) {
  const p = BUNDLED_CATALOG.providers.find((x) => x.id === providerId);
  if (!p) throw new Error(`missing provider ${providerId}`);
  const routing = p.routing[agent];
  if (!routing) throw new Error(`provider ${providerId} has no ${agent} routing`);
  return routing;
}

const KEY = 'sk-test-gateway-key';
const CODEX_ACCOUNT_HEADER_DELETE = [
  'chatgpt-account-id',
  'openai-beta',
  'originator',
  'session_id',
];

afterEach(() => {
  mockGetAppCapabilities.mockReturnValue({ canUseCindyGateway: true });
  setProviderOAuthTokenReader(() => null);
  clearSessionProvider('s-xai');
  clearSessionProvider('s-xai-rewrite');
  clearSessionProvider('s-anthropic-codex');
  clearSessionProvider('s-xd-model-wire');
  setXdGatewayModels([]);
  setAnthropicDiscoveredModels([]);
  setProviderViewsReader(async () => []);
});

describe('implicit local bridge resume routing', () => {
  it('keeps the connected source when a running session model becomes retired', async () => {
    setAnthropicDiscoveredModels([
      {
        id: 'claude-retired-live',
        name: 'Claude Retired Live',
        contextWindow: 200_000,
        efforts: [],
        defaultEffort: null,
        status: 'retired',
      },
    ]);
    setProviderViewsReader(async () =>
      buildRegistry(getActiveCatalog(), { anthropic: true }, {}),
    );

    await expect(resolveImplicitLocalBridgeRoute('claude-retired-live', 'codex')).resolves
      .toMatchObject({
        providerId: 'anthropic',
        routing: { wireProtocol: 'anthropic-messages' },
      });
  });
});

describe('local mode Cindy gateway gate', () => {
  it('does not route explicit or implicit XD traffic when the capability is disabled', () => {
    mockGetAppCapabilities.mockReturnValue({ canUseCindyGateway: false });
    setSessionProvider('s-local-xd', 'xd');
    setXdGatewayModels([{ id: 'gpt-local-gate', agents: ['codex'] }]);

    expect(resolveSessionRouteDecision('s-local-xd', 'codex', KEY)).toBeNull();
    expect(inferProviderIdForModel('gpt-local-gate', 'codex')).toBeNull();

    clearSessionProvider('s-local-xd');
  });
});

describe('claude-code: buildRouteDecision no-break 基线', () => {
  it('Anthropic(oauth-passthrough) == 直连 api.anthropic.com 分支', () => {
    const fromCatalog = buildRouteDecision(descriptor('anthropic', 'claude-code'), KEY, 'claude-code');
    expect(fromCatalog).toEqual({ upstreamOverride: ANTHROPIC_DIRECT_UPSTREAM });
  });

  it('XD(gateway-key) == 换网关 key(x-api-key+authorization),不删 anthropic-beta(fast 经网关透传)', () => {
    // commit 6024f25cb 起:XD cc 网关路由去掉 headerDelete:['anthropic-beta'] —— anthropic-beta 里
    // 携带的 fast-mode beta 不再被剥,Claude Code Fast 可经网关透传到上游。故决策里**无 headerDelete**。
    const fromCatalog = buildRouteDecision(descriptor('xd', 'claude-code'), KEY, 'claude-code');
    expect(fromCatalog).toEqual({
      headerOverride: { 'x-api-key': KEY, authorization: `Bearer ${KEY}` },
    });
  });

  it('XD 无网关 key → null(passthrough)', () => {
    expect(buildRouteDecision(descriptor('xd', 'claude-code'), null, 'claude-code')).toBeNull();
  });
});

describe('codex: buildRouteDecision no-break 基线', () => {
  it('OpenAI(oauth-passthrough) == 直连 ChatGPT 后端分支', () => {
    const fromCatalog = buildRouteDecision(descriptor('openai', 'codex'), KEY, 'codex');
    expect(fromCatalog).toEqual({ upstreamOverride: CODEX_OAUTH_UPSTREAM });
  });

  it('XD(gateway-key) == 仅换 authorization Bearer 网关 key 分支(无 x-api-key/无 headerDelete)', () => {
    const fromCatalog = buildRouteDecision(descriptor('xd', 'codex'), KEY, 'codex');
    expect(fromCatalog).toEqual({ headerOverride: { authorization: `Bearer ${KEY}` } });
  });

  it('XD 无网关 key → null(passthrough)', () => {
    expect(buildRouteDecision(descriptor('xd', 'codex'), null, 'codex')).toBeNull();
  });

  it('xAI(provider-oauth-header) → 直连 api.x.ai + 覆盖 authorization + 删除 ChatGPT 专属头', () => {
    const fromCatalog = buildRouteDecision(descriptor('xai', 'codex'), KEY, 'codex', null, 'xai-token');
    expect(fromCatalog).toEqual({
      upstreamOverride: 'https://api.x.ai/v1',
      headerOverride: { authorization: 'Bearer xai-token' },
      headerDelete: ['chatgpt-account-id', 'openai-beta', 'originator', 'session_id'],
    });
  });

  it('xAI 无 token → 哑 token 覆盖 authorization,不透传 OpenAI bearer', () => {
    const fromCatalog = buildRouteDecision(descriptor('xai', 'codex'), KEY, 'codex');
    expect(fromCatalog).toEqual(expect.objectContaining({
      upstreamOverride: 'https://api.x.ai/v1',
      headerOverride: { authorization: 'Bearer xdt-missing-provider-oauth-token' },
    }));
  });

  it('Anthropic subscription → Claude.ai bearer + OAuth beta,不透传 Codex 账号头', () => {
    const fromCatalog = buildRouteDecision(
      descriptor('anthropic', 'codex'),
      KEY,
      'codex',
      null,
      'claude-subscription-token',
    );
    expect(fromCatalog).toEqual({
      upstreamOverride: 'https://api.anthropic.com',
      headerOverride: {
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
        authorization: 'Bearer claude-subscription-token',
      },
      headerDelete: CODEX_ACCOUNT_HEADER_DELETE,
    });
  });
});

describe('pi: provider-aware Anthropic wire routing', () => {
  afterEach(() => {
    clearSessionProvider('s-pi');
    setProviderOAuthTokenReader(() => null);
  });

  it('XD uses both Anthropic auth headers so the Pi client never leaks its placeholder', () => {
    expect(buildRouteDecision(descriptor('xd', 'pi'), KEY, 'pi')).toEqual({
      headerOverride: { 'x-api-key': KEY, authorization: `Bearer ${KEY}` },
    });
  });

  it('Anthropic injects the host OAuth token and required OAuth beta headers', async () => {
    setSessionProvider('s-pi', 'anthropic');
    setProviderOAuthTokenReader((providerId, agent) =>
      providerId === 'anthropic' && agent === 'pi' ? Promise.resolve('claude-live-token') : null,
    );
    await expect(
      Promise.resolve(resolveSessionRouteDecision('s-pi', 'pi', KEY, 'claude-opus-5')),
    ).resolves.toEqual({
      upstreamOverride: ANTHROPIC_DIRECT_UPSTREAM,
      headerOverride: {
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20',
        authorization: 'Bearer claude-live-token',
      },
      headerDelete: ['x-api-key'],
    });
  });
});

describe('resolveSessionRouteDecision (per-session 选择 → 路由;no-break fallback)', () => {
  it('未显式选供应商 → null(调用方回落 spawn-aware 默认路由,行为不变)', () => {
    clearSessionProvider('s-none');
    expect(resolveSessionRouteDecision('s-none', 'claude-code', KEY)).toBeNull();
  });

  it('cc 会话选 Anthropic → 直连 api.anthropic.com', () => {
    setSessionProvider('s-a', 'anthropic');
    expect(resolveSessionRouteDecision('s-a', 'claude-code', KEY)).toEqual({
      upstreamOverride: ANTHROPIC_DIRECT_UPSTREAM,
    });
  });

  it('cc 会话选 XD → 网关换 key(x-api-key+authorization),不删 anthropic-beta(fast 经网关透传)', () => {
    setSessionProvider('s-x', 'xd');
    expect(resolveSessionRouteDecision('s-x', 'claude-code', KEY)).toEqual({
      headerOverride: { 'x-api-key': KEY, authorization: `Bearer ${KEY}` },
    });
  });

  it('codex 会话选 XD → 仅换 authorization Bearer', () => {
    setSessionProvider('s-xc', 'xd');
    expect(resolveSessionRouteDecision('s-xc', 'codex', KEY)).toEqual({
      headerOverride: { authorization: `Bearer ${KEY}` },
    });
  });

  it('codex 会话选 XD:原生模型保持 Responses,Claude-only 投影模型派生 Anthropic bridge wire', async () => {
    setXdGatewayModels([
      { id: 'gpt-native', agents: ['claude-code', 'codex'] },
      { id: 'claude-bridge', agents: ['claude-code'] },
    ]);
    setSessionProvider('s-xd-model-wire', 'xd');

    expect(getSessionRoutingDescriptor('s-xd-model-wire', 'codex', 'gpt-native'))
      .toMatchObject({
        authStrategy: 'gateway-key',
      });
    expect(getSessionRoutingDescriptor('s-xd-model-wire', 'codex', 'gpt-native')?.wireProtocol)
      .toBeUndefined();

    expect(getSessionRoutingDescriptor('s-xd-model-wire', 'codex', 'claude-bridge[1m]'))
      .toMatchObject({
        authStrategy: 'gateway-key',
        wireProtocol: 'anthropic-messages',
      });
    await expect(resolveSessionRoute('s-xd-model-wire', 'codex', 'claude-bridge[1m]'))
      .resolves.toMatchObject({
        providerId: 'xd',
        providerSource: 'builtin',
        routing: {
          authStrategy: 'gateway-key',
          wireProtocol: 'anthropic-messages',
        },
      });
  });

  it('codex 会话选 xAI → 异步读取 xAI OAuth token 并路由到 api.x.ai', async () => {
    setSessionProvider('s-xai', 'xai');
    setProviderOAuthTokenReader((providerId, agent) =>
      providerId === 'xai' && agent === 'codex' ? Promise.resolve('xai-live-token') : null,
    );
    await expect(Promise.resolve(resolveSessionRouteDecision('s-xai', 'codex', KEY))).resolves.toEqual({
      upstreamOverride: 'https://api.x.ai/v1',
      headerOverride: { authorization: 'Bearer xai-live-token' },
      headerDelete: ['chatgpt-account-id', 'openai-beta', 'originator', 'session_id'],
    });
    clearSessionProvider('s-xai');
    setProviderOAuthTokenReader(() => null);
  });

  it('codex 隐式来源 + xAI model → 按唯一来源推断 provider OAuth 路由', async () => {
    setProviderOAuthTokenReader((providerId, agent) =>
      providerId === 'xai' && agent === 'codex' ? Promise.resolve('xai-live-token') : null,
    );
    // openai / xd 都是动态清单供应商(2026-07-19 统一重构,bundled 零静态):
    // 两边各注入 gpt-5.4 恢复被测前提——gpt-5.4 双来源 → 非唯一 → 不做隐式推断。
    setXdGatewayModels([{ id: 'gpt-5.4', agents: ['codex'] }]);
    setDiscoveredCodexModels([
      { id: 'gpt-5.4', name: 'GPT-5.4', contextWindow: 272_000, efforts: [], defaultEffort: null },
    ]);
    expect(inferProviderIdForModel('xai/grok-4.3', 'codex')).toBe('xai');
    expect(inferProviderIdForModel('gpt-5.4', 'codex')).toBeNull();
    setDiscoveredCodexModels([]);
    await expect(Promise.resolve(
      resolveImplicitProviderOAuthRouteDecision('xai/grok-4.3', 'codex', KEY),
    )).resolves.toEqual({
      upstreamOverride: 'https://api.x.ai/v1',
      headerOverride: { authorization: 'Bearer xai-live-token' },
      headerDelete: ['chatgpt-account-id', 'openai-beta', 'originator', 'session_id'],
    });
    setProviderOAuthTokenReader(() => null);
  });

  it('codex 会话选 Anthropic → 本地桥读取 Claude.ai OAuth，缺失时也 fail closed', async () => {
    setSessionProvider('s-anthropic-codex', 'anthropic');
    setProviderOAuthTokenReader((providerId, agent) =>
      providerId === 'anthropic' && agent === 'codex'
        ? Promise.resolve('claude-subscription-token')
        : null,
    );
    const route = await resolveSessionRoute(
      's-anthropic-codex',
      'codex',
      'claude-opus-5',
    );
    expect(route).toMatchObject({
      providerId: 'anthropic',
      providerSource: 'builtin',
      oauthToken: 'claude-subscription-token',
      routing: {
        wireProtocol: 'anthropic-messages',
        authStrategy: 'provider-oauth-header',
      },
    });
    expect(buildLocalHandlerHeaders(route!, 'codex')).toEqual({
      headers: {
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
        authorization: 'Bearer claude-subscription-token',
      },
      headerDelete: CODEX_ACCOUNT_HEADER_DELETE,
    });

    setProviderOAuthTokenReader(() => null);
    const missing = await resolveSessionRoute(
      's-anthropic-codex',
      'codex',
      'claude-opus-5',
    );
    expect(buildLocalHandlerHeaders(missing!, 'codex').headers.authorization)
      .toBe('Bearer xdt-missing-provider-oauth-token');
  });

  it('按 catalog modelIdRewrite 剥 xAI 内部前缀', () => {
    setSessionProvider('s-xai-rewrite', 'xai');
    expect(rewriteSessionModelIdForRoute('s-xai-rewrite', 'codex', {
      model: 'xai/grok-4.3',
      input: [],
    })).toEqual({
      model: 'grok-4.3',
      input: [],
    });
    clearSessionProvider('s-xai-rewrite');
  });

  it('隐式 xAI model 也按 catalog modelIdRewrite 剥内部前缀', () => {
    expect(rewriteImplicitModelIdForRoute('codex', {
      model: 'xai/grok-4.3',
      input: [],
    })).toEqual({
      model: 'grok-4.3',
      input: [],
    });
  });
});

describe('resolveSessionRouteDecision — modelPrefixes 服务范围门(issue #886)', () => {
  afterEach(() => {
    clearSessionProvider('s-scope');
    setProviderOAuthTokenReader(() => null);
  });

  it('cc 会话选 xAI + claude-* 辅助请求(权限 auto 分类器等)→ null,回落默认路由', () => {
    setSessionProvider('s-scope', 'xai');
    // #886 现场:分类器的 haiku 调用被会话路由拽到 api.x.ai → 必挂 → Bash 全被拦。
    // scope 门后返回 null,调用方回落 spawn 默认(网关/直连),分类器照常工作。
    expect(resolveSessionRouteDecision('s-scope', 'claude-code', KEY, 'claude-haiku-4-5-20251001')).toBeNull();
  });

  it('cc 会话选 xAI + 自家前缀模型 → 正常路由到 api.x.ai', () => {
    setSessionProvider('s-scope', 'xai');
    expect(resolveSessionRouteDecision('s-scope', 'claude-code', KEY, 'xai/grok-4.3')).toEqual({
      upstreamOverride: 'https://api.x.ai/v1',
    });
  });

  it('cc 会话选 xAI + 无 wireModel(控制面请求)→ 不受范围限制,正常路由', () => {
    setSessionProvider('s-scope', 'xai');
    expect(resolveSessionRouteDecision('s-scope', 'claude-code', KEY)).toEqual({
      upstreamOverride: 'https://api.x.ai/v1',
    });
  });

  it('cc 会话选 OpenAI(ChatGPT 订阅直连)同样只捕获 chatgpt/ 前缀', () => {
    setSessionProvider('s-scope', 'openai');
    expect(resolveSessionRouteDecision('s-scope', 'claude-code', KEY, 'claude-haiku-4-5-20251001')).toBeNull();
    expect(resolveSessionRouteDecision('s-scope', 'claude-code', KEY, 'chatgpt/gpt-5.5')).toEqual({
      upstreamOverride: CODEX_OAUTH_UPSTREAM,
    });
  });

  it('codex 会话选 xAI + 非 xai/ 模型 → null(不把别家模型送到 api.x.ai)', async () => {
    setSessionProvider('s-scope', 'xai');
    setProviderOAuthTokenReader(() => Promise.resolve('xai-live-token'));
    expect(resolveSessionRouteDecision('s-scope', 'codex', KEY, 'gpt-5.5')).toBeNull();
    // 自家模型不受影响。
    await expect(Promise.resolve(
      resolveSessionRouteDecision('s-scope', 'codex', KEY, 'xai/grok-4.3'),
    )).resolves.toEqual(expect.objectContaining({ upstreamOverride: 'https://api.x.ai/v1' }));
  });

  it('未声明 modelPrefixes 的供应商(XD/Anthropic/自定义)不受门限制 —— no-break', () => {
    setSessionProvider('s-scope', 'xd');
    expect(resolveSessionRouteDecision('s-scope', 'claude-code', KEY, 'claude-haiku-4-5-20251001')).toEqual({
      headerOverride: { 'x-api-key': KEY, authorization: `Bearer ${KEY}` },
    });
    setSessionProvider('s-scope', 'anthropic');
    expect(resolveSessionRouteDecision('s-scope', 'claude-code', KEY, 'claude-haiku-4-5-20251001')).toEqual({
      upstreamOverride: ANTHROPIC_DIRECT_UPSTREAM,
    });
  });
});

describe('api-key-header (自定义供应商 buildRouteDecision)', () => {
  const routing = (headers?: Record<string, string>): RoutingDescriptor => ({
    upstream: 'https://api.myprovider.com/v1',
    authStrategy: 'api-key-header',
    ...(headers ? { headerOverride: headers } : {}),
  });

  it('cc: 注入 x-api-key + authorization(覆盖 oauth-spawn 泄漏的订阅 Bearer) + upstreamOverride', () => {
    expect(buildRouteDecision(routing(), KEY, 'claude-code', 'sk-custom')).toEqual({
      headerOverride: { 'x-api-key': 'sk-custom', authorization: 'Bearer sk-custom' },
      upstreamOverride: 'https://api.myprovider.com/v1',
    });
  });

  it('codex: 注入 authorization Bearer + upstreamOverride', () => {
    expect(buildRouteDecision(routing(), KEY, 'codex', 'sk-custom')).toEqual({
      headerOverride: { authorization: 'Bearer sk-custom' },
      upstreamOverride: 'https://api.myprovider.com/v1',
      headerDelete: CODEX_ACCOUNT_HEADER_DELETE,
    });
  });

  it('叠加用户自定义 headers；无 key 时用哑值覆盖 CLI 凭证', () => {
    expect(buildRouteDecision(routing({ 'X-Org': 'acme' }), KEY, 'codex', null)).toEqual({
      headerOverride: {
        'X-Org': 'acme',
        authorization: 'Bearer cindy-missing-custom-provider-api-key',
      },
      upstreamOverride: 'https://api.myprovider.com/v1',
      headerDelete: CODEX_ACCOUNT_HEADER_DELETE,
    });
  });

  it('无 safeStorage key 时保留旧版 header-only 凭证', () => {
    expect(
      buildRouteDecision(
        routing({ Authorization: 'Bearer legacy', 'X-Tenant': 'tenant-a' }),
        KEY,
        'codex',
        null,
      ),
    ).toEqual({
      headerOverride: { authorization: 'Bearer legacy', 'X-Tenant': 'tenant-a' },
      upstreamOverride: 'https://api.myprovider.com/v1',
      headerDelete: CODEX_ACCOUNT_HEADER_DELETE,
    });
  });

  it('legacy 只含 x-api-key 时仍覆盖 Codex Authorization', () => {
    expect(
      buildRouteDecision(
        routing({ 'X-API-Key': 'legacy-key' }),
        KEY,
        'codex',
        null,
      ),
    ).toEqual({
      headerOverride: {
        'x-api-key': 'legacy-key',
        authorization: 'Bearer cindy-missing-custom-provider-api-key',
      },
      upstreamOverride: 'https://api.myprovider.com/v1',
      headerDelete: CODEX_ACCOUNT_HEADER_DELETE,
    });
  });

  it('legacy 只含 Authorization 时仍覆盖 Claude x-api-key', () => {
    expect(
      buildRouteDecision(
        routing({ Authorization: 'Bearer legacy' }),
        KEY,
        'claude-code',
        null,
      ),
    ).toEqual({
      headerOverride: {
        authorization: 'Bearer legacy',
        'x-api-key': 'cindy-missing-custom-provider-api-key',
      },
      upstreamOverride: 'https://api.myprovider.com/v1',
    });
  });

  it('safeStorage key 始终覆盖复制配置里残留的鉴权头', () => {
    expect(
      buildRouteDecision(
        routing({
          Authorization: 'Bearer stale',
          'X-API-Key': 'stale',
          'X-Tenant': 'tenant-a',
        }),
        KEY,
        'codex',
        'sk-current',
      ),
    ).toEqual({
      headerOverride: {
        'X-Tenant': 'tenant-a',
        authorization: 'Bearer sk-current',
      },
      upstreamOverride: 'https://api.myprovider.com/v1',
      headerDelete: CODEX_ACCOUNT_HEADER_DELETE,
    });
  });

  it('缺少 safeStorage 与 legacy key 时用哑值覆盖 CLI 凭证并删除 Codex 账号头', () => {
    expect(
      buildRouteDecision(
        routing({ 'X-Tenant': 'tenant-a' }),
        KEY,
        'codex',
        null,
      ),
    ).toEqual({
      headerOverride: {
        'X-Tenant': 'tenant-a',
        authorization: 'Bearer cindy-missing-custom-provider-api-key',
      },
      upstreamOverride: 'https://api.myprovider.com/v1',
      headerDelete: CODEX_ACCOUNT_HEADER_DELETE,
    });
  });

  it('本地 Chat bridge 在缺 key 时保留 legacy 凭证，否则注入哑值', () => {
    const baseRoute = {
      providerId: 'legacy',
      providerSource: 'user' as const,
      routing: routing({ 'X-Tenant': 'tenant-a' }),
      apiKey: null,
      oauthToken: null,
    };
    expect(buildLocalHandlerHeaders(baseRoute, 'codex')).toMatchObject({
      headers: {
        'X-Tenant': 'tenant-a',
        authorization: 'Bearer cindy-missing-custom-provider-api-key',
      },
    });
    expect(
      buildLocalHandlerHeaders({
        ...baseRoute,
        routing: routing({
          Authorization: 'Bearer legacy',
          'X-Tenant': 'tenant-a',
        }),
      }, 'codex'),
    ).toMatchObject({
      headers: {
        authorization: 'Bearer legacy',
        'X-Tenant': 'tenant-a',
      },
    });
  });
});

describe('none (无鉴权自定义代理 buildRouteDecision)', () => {
  const routing: RoutingDescriptor = {
    upstream: 'http://127.0.0.1:4000/v1',
    authStrategy: 'none',
    headerOverride: { 'X-Proxy-Tenant': 'local' },
  };

  it('cc 固定路由本机代理并删除 Claude CLI 自带的认证头', () => {
    expect(buildRouteDecision(routing, KEY, 'claude-code', null)).toEqual({
      upstreamOverride: 'http://127.0.0.1:4000/v1',
      headerOverride: { 'X-Proxy-Tenant': 'local' },
      headerDelete: ['authorization', 'x-api-key'],
    });
  });

  it('codex 额外删除 ChatGPT 账号元数据，避免订阅身份泄漏', () => {
    expect(buildRouteDecision(routing, KEY, 'codex', null)).toEqual({
      upstreamOverride: 'http://127.0.0.1:4000/v1',
      headerOverride: { 'X-Proxy-Tenant': 'local' },
      headerDelete: [
        'authorization',
        'x-api-key',
        'chatgpt-account-id',
        'openai-beta',
        'originator',
        'session_id',
      ],
    });
  });

  it('无鉴权透明路由不保留自定义 headers 里的凭证', () => {
    expect(
      buildRouteDecision({
        ...routing,
        headerOverride: {
          Authorization: 'Bearer must-not-leak',
          'X-API-Key': 'must-not-leak',
          'X-Proxy-Tenant': 'local',
        },
      }, KEY, 'codex', null),
    ).toMatchObject({
      headerOverride: { 'X-Proxy-Tenant': 'local' },
    });
  });

  it('disabled 的历史远程无鉴权路由直接 fail closed', async () => {
    const decision = buildRouteDecision(
      {
        upstream: 'https://remote.example/v1',
        authStrategy: 'none',
        disabled: true,
      },
      KEY,
      'codex',
      null,
    );
    expect(decision).toEqual({ localHandler: expect.any(Function) });

    const end = vi.fn();
    await decision!.localHandler!({
      rawBody: Buffer.from('{}'),
      parsedBody: { model: 'legacy-model' },
      ctx: {
        reqId: 1,
        method: 'POST',
        url: '/responses',
        headers: {},
      },
      res: { writeHead: vi.fn(), end } as never,
    });
    expect(JSON.parse(end.mock.calls[0][0])).toMatchObject({
      error: {
        message: 'The selected provider is disabled; update its endpoint or authentication settings before retrying.',
      },
    });
  });

  it('本地 Chat 桥也剥掉复制配置里残留的鉴权与账号头', () => {
    expect(
      buildLocalHandlerHeaders({
        providerId: 'local',
        providerSource: 'user',
        routing: {
          ...routing,
          headerOverride: {
            Authorization: 'Bearer must-not-leak',
            'X-API-Key': 'must-not-leak',
            'ChatGPT-Account-ID': 'acct',
            'X-Proxy-Tenant': 'local',
          },
        },
        apiKey: null,
        oauthToken: null,
      }, 'codex'),
    ).toMatchObject({
      headers: { 'X-Proxy-Tenant': 'local' },
    });
  });
});

describe('resolveSessionRouteDecision — 自定义供应商(resolve 时注入 key)', () => {
  afterEach(() => {
    setCustomProviders([]);
    setCustomProviderKeyReader(() => null);
    setProviderOAuthTokenReader(() => null);
    clearSessionProvider('s-user');
  });

  it('user provider: 读注入 key + 路由到 baseUrl；isUserProviderSession=true', () => {
    setCustomProviders([
      buildUserProvider({
        id: 'openrouter',
        name: 'OpenRouter',
        runtimes: {
          codex: {
            baseUrl: 'https://openrouter.ai/api/v1',
            models: [{ id: 'meta/llama-4', name: 'Llama 4' }],
          },
        },
      }),
    ]);
    setCustomProviderKeyReader((id, agent) => (id === 'openrouter' && agent === 'codex' ? 'sk-or-123' : null));
    setSessionProvider('s-user', 'openrouter');

    expect(isUserProviderSession('s-user')).toBe(true);
    expect(resolveSessionRouteDecision('s-user', 'codex', KEY)).toEqual({
      headerOverride: { authorization: 'Bearer sk-or-123' },
      upstreamOverride: 'https://openrouter.ai/api/v1',
      headerDelete: CODEX_ACCOUNT_HEADER_DELETE,
    });
  });

  it('blocks new routes while endpoint and key switch as one logical mutation', async () => {
    setCustomProviders([
      buildUserProvider({
        id: 'openrouter',
        name: 'OpenRouter',
        runtimes: {
          codex: {
            baseUrl: 'https://old.example/v1',
            models: [{ id: 'custom-model', name: 'Custom Model' }],
          },
        },
      }),
    ]);
    setCustomProviderKeyReader(() => 'old-key');
    setSessionProvider('s-user', 'openrouter');
    expect(resolveSessionRouteDecision('s-user', 'codex', KEY)).toMatchObject({
      upstreamOverride: 'https://old.example/v1',
      headerOverride: { authorization: 'Bearer old-key' },
    });

    const finishMutation = beginProviderRouteMutation('openrouter');
    try {
      // Secret writes are synchronous and may become visible before the catalog refresh awaits.
      setCustomProviderKeyReader(() => 'new-key');
      const decision = await Promise.resolve(
        resolveSessionRouteDecision('s-user', 'codex', KEY),
      );
      expect(decision).toEqual({ localHandler: expect.any(Function) });
      const writeHead = vi.fn();
      const end = vi.fn();
      await decision!.localHandler!({
        rawBody: Buffer.from('{}'),
        parsedBody: { model: 'custom-model' },
        ctx: { reqId: 1, method: 'POST', url: '/responses', headers: {} },
        res: { writeHead, end } as never,
      });
      expect(writeHead).toHaveBeenCalledWith(503, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'retry-after': '1',
      });
      expect(JSON.parse(end.mock.calls[0][0])).toMatchObject({
        error: {
          type: 'provider_route_updating',
          code: 'provider_route_updating',
        },
      });
    } finally {
      finishMutation();
    }

    setCustomProviders([
      buildUserProvider({
        id: 'openrouter',
        name: 'OpenRouter',
        runtimes: {
          codex: {
            baseUrl: 'https://new.example/v1',
            models: [{ id: 'custom-model', name: 'Custom Model' }],
          },
        },
      }),
    ]);
    expect(resolveSessionRouteDecision('s-user', 'codex', KEY)).toMatchObject({
      upstreamOverride: 'https://new.example/v1',
      headerOverride: { authorization: 'Bearer new-key' },
    });
  });

  it('精确请求路径只覆盖带 model 的推理请求，不改写无 body 的控制面请求', () => {
    setCustomProviders([
      buildUserProvider({
        id: 'exact-path',
        name: 'Exact Path',
        runtimes: {
          codex: {
            baseUrl: 'https://gateway.example/api',
            requestPath: '/tenant/acme/infer?stream=1',
            models: [{ id: 'custom-model', name: 'Custom Model' }],
          },
        },
      }),
    ]);
    setCustomProviderKeyReader(() => 'sk-exact');
    setSessionProvider('s-user', 'exact-path');

    expect(resolveSessionRouteDecision('s-user', 'codex', KEY, 'custom-model')).toEqual({
      headerOverride: { authorization: 'Bearer sk-exact' },
      upstreamOverride: 'https://gateway.example/api',
      pathOverride: '/tenant/acme/infer?stream=1',
      headerDelete: CODEX_ACCOUNT_HEADER_DELETE,
    });
    expect(resolveSessionRouteDecision('s-user', 'codex', KEY)).toEqual({
      headerOverride: { authorization: 'Bearer sk-exact' },
      upstreamOverride: 'https://gateway.example/api',
      headerDelete: CODEX_ACCOUNT_HEADER_DELETE,
    });
  });

  it('disabled runtime 返回本地错误，不允许 proxy 回落到默认供应商', async () => {
    const disabled = buildUserProvider({
      id: 'legacy-remote',
      name: 'Legacy Remote',
      runtimes: {
        codex: {
          baseUrl: 'https://remote.example/v1',
          models: [{ id: 'legacy-model', name: 'Legacy Model' }],
        },
      },
      auth: { method: 'none' },
    });
    expect(disabled.routing.codex?.disabled).toBe(true);
    setCustomProviders([disabled]);
    setSessionProvider('s-user', 'legacy-remote');

    const decision = await Promise.resolve(
      resolveSessionRouteDecision('s-user', 'codex', KEY, 'legacy-model'),
    );
    expect(decision).toEqual({ localHandler: expect.any(Function) });

    const writeHead = vi.fn();
    const end = vi.fn();
    await decision!.localHandler!({
      rawBody: Buffer.from('{}'),
      parsedBody: { model: 'legacy-model' },
      ctx: {
        reqId: 1,
        method: 'POST',
        url: '/responses',
        headers: {},
      },
      res: { writeHead, end } as never,
    });
    expect(writeHead).toHaveBeenCalledWith(503, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    expect(JSON.parse(end.mock.calls[0][0])).toMatchObject({
      error: {
        type: 'provider_route_disabled',
        code: 'provider_route_disabled',
      },
    });
  });

  it('内置供应商 isUserProviderSession=false', () => {
    setSessionProvider('s-user', 'xd');
    expect(isUserProviderSession('s-user')).toBe(false);
  });
});
