/**
 * source（目录加载/兜底/合并）与 registry（可见性/来源/路由解析）的纯逻辑测试。
 *
 * 2026-07-19 统一重构后:bundled 的 anthropic/openai/xd 是动态清单供应商(零静态模型),
 * registry / resolveRoute 的行为测试统一在「运行时注入后的目录」fixture 上进行
 * (与生产一致:active-catalog 把 SDK 发现 / codex 注册表 / 网关下发注入后再 buildRegistry)。
 */

import { describe, it, expect, vi } from 'vitest';

import { BUNDLED_CATALOG } from '../catalog.js';
import {
  loadCatalog,
  loadCatalogWithSource,
  resolveCatalogUrl,
  resolveFallbackCatalogUrl,
  mergeWithBundled,
  CATALOG_CFG_PATH,
  type CatalogIO,
} from '../source.js';
import {
  buildRegistry,
  providersForAgent,
  connectedProvidersForAgent,
  providerOffersModel,
  getModel,
  sourcesForModel,
  chatEligibleSourcesForModel,
  effectiveSourceIdForModel,
  resolveRoute,
} from '../registry.js';
import type { Catalog, CatalogModel } from '../types.js';

const MINIMAL: Catalog = {
  version: 'test',
  providers: [
    {
      id: 'anthropic',
      name: 'Anthropic',
      source: 'builtin',
      agents: ['claude-code'],
      auth: { method: 'oauth' },
      routing: { 'claude-code': { upstream: 'https://api.anthropic.com', authStrategy: 'oauth-passthrough' } },
      models: {
        'claude-code': [
          { id: 'claude-opus-4-8', name: 'Opus 4.8', contextWindow: 1_000_000, efforts: ['high'], defaultEffort: 'high' },
        ],
      },
    },
  ],
};

function model(id: string, extra: Partial<CatalogModel> = {}): CatalogModel {
  return { id, name: id, contextWindow: 200_000, efforts: [], defaultEffort: null, ...extra };
}

/** 模拟生产形态:动态清单注入后的目录(active-catalog 合并结果的等价物)。 */
function runtimeCatalog(): Catalog {
  const clone = JSON.parse(JSON.stringify(BUNDLED_CATALOG)) as Catalog;
  for (const p of clone.providers) {
    if (p.id === 'anthropic') {
      const models = [model('claude-opus-4-8', { name: 'Opus 4.8', contextWindow: 1_000_000 })];
      p.models['claude-code'] = models;
      p.models.codex = models;
    }
    if (p.id === 'openai') {
      p.models.codex = [model('gpt-5.5', { name: 'GPT-5.5' })];
      p.models['claude-code'] = [model('chatgpt/gpt-5.5', { name: 'GPT-5.5' })];
    }
    if (p.id === 'xd') {
      p.models['claude-code'] = [
        model('claude-opus-4-8', { name: 'Opus 4.8', contextWindow: 1_000_000 }),
        model('gpt-5.5', { name: 'GPT-5.5' }),
      ];
      p.models.codex = [model('gpt-5.5', { name: 'GPT-5.5' })];
    }
  }
  return clone;
}

describe('resolveCatalogUrl', () => {
  it('prefers explicit url', () => {
    expect(resolveCatalogUrl({ url: 'https://x/y.json', baseUrl: 'https://b' })).toBe('https://x/y.json');
  });
  it('builds from baseUrl + public catalog API path', () => {
    expect(resolveCatalogUrl({ baseUrl: 'https://model-access.example.com/' })).toBe(
      'https://model-access.example.com/api/model-catalog/catalog',
    );
  });
  it('builds the migration OSS fallback URL', () => {
    expect(resolveFallbackCatalogUrl({ fallbackBaseUrl: 'https://cdn.example.com/base/' })).toBe(
      `https://cdn.example.com/base${CATALOG_CFG_PATH}`,
    );
  });
  it('returns null when neither given', () => {
    expect(resolveCatalogUrl({})).toBeNull();
  });
});

describe('mergeWithBundled', () => {
  it('keeps primary providers and fills missing bundled ones by id', () => {
    const merged = mergeWithBundled(MINIMAL);
    const ids = merged.providers.map((p) => p.id);
    expect(ids).toContain('anthropic');
    expect(ids).toContain('openai');
    expect(ids).toContain('xd');
    // primary's anthropic wins (only 1 cc model in MINIMAL)
    expect(merged.providers.find((p) => p.id === 'anthropic')!.models['claude-code']!.length).toBe(1);
  });

  it('orders result by bundled provider order (v2 远端只带 xai 时不得窜位)', () => {
    const v2Remote: Catalog = {
      version: '2',
      providers: [JSON.parse(JSON.stringify(BUNDLED_CATALOG.providers.find((p) => p.id === 'xai')))],
    };
    const merged = mergeWithBundled(v2Remote);
    expect(merged.providers.map((p) => p.id)).toEqual(['anthropic', 'openai', 'xai', 'xd', 'gemini']);
    // 远端独有的新供应商追加在 bundled 之后。
    const withExtra: Catalog = {
      version: '2',
      providers: [
        ...v2Remote.providers,
        { ...MINIMAL.providers[0], id: 'newvendor', name: 'NewVendor' },
      ],
    };
    expect(mergeWithBundled(withExtra).providers.map((p) => p.id)).toEqual([
      'anthropic', 'openai', 'xai', 'xd', 'gemini', 'newvendor',
    ]);
  });

  it('backfills access for an old primary catalog without mutating it', () => {
    const merged = mergeWithBundled(MINIMAL);
    expect(MINIMAL.providers[0].access).toBeUndefined();
    expect(merged.providers.find((p) => p.id === 'anthropic')?.access).toEqual({
      kind: 'subscription',
      product: 'Claude.ai',
    });
  });

  it('preserves access explicitly supplied by the primary catalog', () => {
    const primary: Catalog = {
      ...MINIMAL,
      providers: MINIMAL.providers.map((p) => ({ ...p, access: { kind: 'api' } })),
    };
    expect(mergeWithBundled(primary).providers.find((p) => p.id === 'anthropic')?.access).toEqual({ kind: 'api' });
  });

  it('does not infer bundled billing when a same-id primary changes auth or upstream', () => {
    const apiKeyPrimary: Catalog = {
      ...MINIMAL,
      providers: MINIMAL.providers.map((p) => ({
        ...p,
        auth: { method: 'apiKey' as const },
        routing: {
          'claude-code': {
            ...p.routing['claude-code']!,
            authStrategy: 'api-key-header' as const,
          },
        },
      })),
    };
    const alternateOAuthPrimary: Catalog = {
      ...MINIMAL,
      providers: MINIMAL.providers.map((p) => ({
        ...p,
        routing: {
          'claude-code': {
            ...p.routing['claude-code']!,
            upstream: 'https://oauth-proxy.example.test',
          },
        },
      })),
    };

    const apiKeyMerged = mergeWithBundled(apiKeyPrimary).providers.find((p) => p.id === 'anthropic');
    const altMerged = mergeWithBundled(alternateOAuthPrimary).providers.find((p) => p.id === 'anthropic');
    expect(apiKeyMerged?.access).toBeUndefined();
    expect(altMerged?.access).toBeUndefined();
  });
});

describe('loadCatalog', () => {
  it('reports whether local, remote, or bundled supplied the snapshot', async () => {
    const local = await loadCatalogWithSource(
      { localPath: '/repo/providers.json' },
      { readFile: vi.fn(async () => JSON.stringify(MINIMAL)) },
    );
    const remote = await loadCatalogWithSource(
      { url: 'https://catalog.example.test/providers.json' },
      { fetchText: vi.fn(async () => JSON.stringify(MINIMAL)) },
    );
    const bundled = await loadCatalogWithSource(
      { url: 'https://catalog.example.test/providers.json' },
      { fetchText: vi.fn(async () => { throw new Error('network down'); }) },
    );

    expect(local).toMatchObject({ source: 'local', catalog: { version: 'test' } });
    expect(remote).toMatchObject({ source: 'remote', catalog: { version: 'test' } });
    expect(bundled).toEqual({ source: 'bundled', catalog: BUNDLED_CATALOG });
  });

  it('dev: reads local path, skips network', async () => {
    const fetchText = vi.fn();
    const io: CatalogIO = { readFile: vi.fn(async () => JSON.stringify(MINIMAL)), fetchText };
    const cat = await loadCatalog({ localPath: '/repo/providers.json' }, io);
    expect(io.readFile).toHaveBeenCalledWith('/repo/providers.json');
    expect(fetchText).not.toHaveBeenCalled();
    expect(cat.providers.find((p) => p.id === 'anthropic')).toBeTruthy();
  });

  it('falls back from public API to legacy OSS before bundled', async () => {
    const fetchText = vi.fn()
      .mockRejectedValueOnce(new Error('api unavailable'))
      .mockResolvedValueOnce(JSON.stringify(MINIMAL));
    const cat = await loadCatalog(
      {
        baseUrl: 'https://model-access.example.com',
        fallbackBaseUrl: 'https://cdn.example.com/cindy',
        now: () => 0,
      },
      { fetchText },
    );
    expect(fetchText).toHaveBeenNthCalledWith(
      1,
      'https://model-access.example.com/api/model-catalog/catalog',
      15_000,
    );
    expect(fetchText).toHaveBeenNthCalledWith(
      2,
      'https://cdn.example.com/cindy/cfg/providers.json',
      expect.any(Number),
    );
    expect(cat.version).toBe('test');
  });
  it('falls back from invalid public API payload to legacy OSS before bundled', async () => {
    const fetchText = vi.fn()
      .mockResolvedValueOnce('{"version":"broken","providers":[]}')
      .mockResolvedValueOnce(JSON.stringify(MINIMAL));
    const cat = await loadCatalog(
      {
        baseUrl: 'https://model-access.example.com',
        fallbackBaseUrl: 'https://cdn.example.com/cindy',
        now: () => 0,
      },
      { fetchText },
    );
    expect(fetchText).toHaveBeenNthCalledWith(
      1,
      'https://model-access.example.com/api/model-catalog/catalog',
      15_000,
    );
    expect(fetchText).toHaveBeenNthCalledWith(
      2,
      'https://cdn.example.com/cindy/cfg/providers.json',
      expect.any(Number),
    );
    expect(cat.version).toBe('test');
  });

  it('shares one remote budget across the public API and legacy OSS fallback', async () => {
    const now = vi.fn()
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(11_000);
    const fetchText = vi.fn()
      .mockRejectedValueOnce(new Error('api timeout'))
      .mockResolvedValueOnce(JSON.stringify(MINIMAL));
    const cat = await loadCatalog(
      {
        baseUrl: 'https://model-access.example.com',
        fallbackBaseUrl: 'https://cdn.example.com/cindy',
        remoteBudgetMs: 15_000,
        now,
      },
      { fetchText },
    );
    expect(fetchText).toHaveBeenNthCalledWith(
      1,
      'https://model-access.example.com/api/model-catalog/catalog',
      15_000,
    );
    expect(fetchText).toHaveBeenNthCalledWith(
      2,
      'https://cdn.example.com/cindy/cfg/providers.json',
      5_000,
    );
    expect(cat.version).toBe('test');
  });

  it('does not start legacy OSS after the shared remote budget is exhausted', async () => {
    const now = vi.fn()
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(16_000);
    const fetchText = vi.fn().mockRejectedValueOnce(new Error('api timeout'));
    const cat = await loadCatalog(
      {
        baseUrl: 'https://model-access.example.com',
        fallbackBaseUrl: 'https://cdn.example.com/cindy',
        remoteBudgetMs: 15_000,
        now,
      },
      { fetchText },
    );
    expect(fetchText).toHaveBeenCalledTimes(1);
    expect(fetchText).toHaveBeenCalledWith(
      'https://model-access.example.com/api/model-catalog/catalog',
      15_000,
    );
    expect(cat.version).toBe(BUNDLED_CATALOG.version);
  });

  it('uses explicit URL without also retrying the legacy OSS fallback', async () => {
    const fetchText = vi.fn().mockRejectedValue(new Error('override unavailable'));
    const cat = await loadCatalog(
      {
        url: 'https://override.example.com/providers.json',
        baseUrl: 'https://model-access.example.com',
        fallbackBaseUrl: 'https://cdn.example.com/cindy',
        now: () => 0,
      },
      { fetchText },
    );
    expect(fetchText).toHaveBeenCalledTimes(1);
    expect(fetchText).toHaveBeenCalledWith('https://override.example.com/providers.json', 15_000);
    expect(cat.version).toBe(BUNDLED_CATALOG.version);
  });

  it('falls back to bundled when fetch fails', async () => {
    const io: CatalogIO = {
      fetchText: vi.fn(async () => {
        throw new Error('network down');
      }),
    };
    const cat = await loadCatalog({ url: 'https://x/y.json' }, io);
    expect(cat.version).toBe(BUNDLED_CATALOG.version);
    expect(cat.providers.map((p) => p.id).sort()).toEqual(['anthropic', 'gemini', 'openai', 'xai', 'xd']);
  });

  it('disableFetch → bundled (no network)', async () => {
    const fetchText = vi.fn();
    const cat = await loadCatalog({ url: 'https://x/y.json', disableFetch: true }, { fetchText });
    expect(fetchText).not.toHaveBeenCalled();
    expect(cat.providers.length).toBe(BUNDLED_CATALOG.providers.length);
  });
});

describe('registry visibility & sources(运行时注入 fixture)', () => {
  const views = buildRegistry(runtimeCatalog(), { xd: true, anthropic: false, openai: false });

  it('providersForAgent ignores connection', () => {
    expect(providersForAgent(views, 'claude-code').map((p) => p.id).sort()).toEqual(['anthropic', 'openai', 'xai', 'xd']);
    expect(providersForAgent(views, 'codex').map((p) => p.id).sort()).toEqual(['anthropic', 'openai', 'xai', 'xd']);
  });

  it('connectedProvidersForAgent honors connection', () => {
    expect(connectedProvidersForAgent(views, 'claude-code').map((p) => p.id)).toEqual(['xd']);
    expect(connectedProvidersForAgent(views, 'codex').map((p) => p.id)).toEqual(['xd']);
  });

  it('agent selectors and model sources exclude disabled runtimes', () => {
    const catalog = runtimeCatalog();
    const xd = catalog.providers.find((provider) => provider.id === 'xd')!;
    xd.routing.codex = { ...xd.routing.codex!, disabled: true };
    const disabledViews = buildRegistry(catalog, { xd: true });

    expect(providersForAgent(disabledViews, 'codex').map((provider) => provider.id))
      .not.toContain('xd');
    expect(connectedProvidersForAgent(disabledViews, 'codex')).toEqual([]);
    expect(sourcesForModel(disabledViews, 'gpt-5.5', 'codex')).toEqual([]);
    expect(connectedProvidersForAgent(disabledViews, 'claude-code').map((provider) => provider.id))
      .toEqual(['xd']);
  });

  it('agent selectors and model sources exclude a declared agent with no routing descriptor', () => {
    const catalog = runtimeCatalog();
    const xd = catalog.providers.find((provider) => provider.id === 'xd')!;
    delete xd.routing.codex;
    const missingRouteViews = buildRegistry(catalog, { xd: true });

    expect(providersForAgent(missingRouteViews, 'codex').map((provider) => provider.id))
      .not.toContain('xd');
    expect(connectedProvidersForAgent(missingRouteViews, 'codex')).toEqual([]);
    expect(sourcesForModel(missingRouteViews, 'gpt-5.5', 'codex')).toEqual([]);
  });

  it('providerOffersModel / getModel (agent-scoped)', () => {
    const xd = views.find((p) => p.id === 'xd')!;
    expect(providerOffersModel(xd, 'gpt-5.5', 'codex')).toBe(true);
    expect(providerOffersModel(xd, 'no-such', 'codex')).toBe(false);
    expect(providerOffersModel(xd, 'claude-opus-4-8', 'codex')).toBe(false);
    expect(getModel(xd, 'claude-opus-4-8', 'claude-code')?.name).toBe('Opus 4.8');
  });

  it('sourcesForModel: only connected providers by default', () => {
    expect(sourcesForModel(views, 'claude-opus-4-8', 'claude-code').map((p) => p.id)).toEqual(['xd']);
    expect(sourcesForModel(views, 'claude-opus-4-8', 'claude-code', { onlyConnected: false }).map((p) => p.id).sort())
      .toEqual(['anthropic', 'xd']);
  });

  it('sourcesForModel: same model two sources when both connected', () => {
    const all = buildRegistry(runtimeCatalog(), { xd: true, anthropic: true, openai: true, xai: true });
    expect(sourcesForModel(all, 'gpt-5.5', 'codex').map((p) => p.id).sort()).toEqual(['openai', 'xd']);
    expect(sourcesForModel(all, 'gpt-5.5', 'claude-code').map((p) => p.id)).toEqual(['xd']);
    expect(sourcesForModel(all, 'xai/grok-4.3', 'codex').map((p) => p.id)).toEqual(['xai']);
  });

  it('effectiveSourceIdForModel 只在真正提供当前模型的已连接来源里选默认', () => {
    const openaiOnly = buildRegistry(runtimeCatalog(), {
      xd: false,
      anthropic: false,
      openai: true,
      xai: false,
    });
    expect(
      effectiveSourceIdForModel(openaiOnly, null, 'claude-opus-4-8', 'claude-code'),
    ).toBeNull();
    expect(
      effectiveSourceIdForModel(openaiOnly, null, 'chatgpt/gpt-5.5', 'claude-code'),
    ).toBe('openai');
  });

  it('effectiveSourceIdForModel 保留有效显式来源，失效时回落到同模型默认来源', () => {
    const all = buildRegistry(runtimeCatalog(), {
      xd: true,
      anthropic: true,
      openai: true,
      xai: true,
    });
    expect(
      effectiveSourceIdForModel(all, 'anthropic', 'claude-opus-4-8', 'claude-code'),
    ).toBe('anthropic');
    expect(
      effectiveSourceIdForModel(all, 'openai', 'claude-opus-4-8', 'claude-code'),
    ).toBe('xd');
  });

  it('effectiveSourceIdForModel 不把请求路由到非聊天来源(issue #882 第 3 点,2026-07 review):同一 id 在不同来源上 mode 不一致时,只信聊天来源', () => {
    const mixedModeCatalog: Catalog = {
      version: 'test',
      providers: [
        {
          id: 'xd',
          name: 'XD',
          source: 'builtin',
          agents: ['claude-code'],
          auth: { method: 'managed' },
          routing: { 'claude-code': { upstream: 'https://xd.test', authStrategy: 'gateway-key' } },
          models: {
            'claude-code': [model('shared-id', { mode: 'image_generation' })],
          },
        },
        {
          id: 'openai',
          name: 'OpenAI',
          source: 'builtin',
          agents: ['claude-code'],
          auth: { method: 'oauth' },
          routing: { 'claude-code': { upstream: 'https://api.openai.com', authStrategy: 'oauth-passthrough' } },
          models: {
            'claude-code': [model('shared-id', { mode: 'chat' })],
          },
        },
      ],
    };
    const views = buildRegistry(mixedModeCatalog, { xd: true, openai: true });
    // 显式指定的 providerId 恰好是非聊天来源(xd)时,不接受它——落到真正聊天的来源(openai)。
    expect(effectiveSourceIdForModel(views, 'xd', 'shared-id', 'claude-code')).toBe('openai');
    // 未显式指定 providerId 时,默认来源同样只能是聊天来源。
    expect(effectiveSourceIdForModel(views, null, 'shared-id', 'claude-code')).toBe('openai');

    // chatEligibleSourcesForModel 是这份过滤的共享底层——直接断言它自己的输出,
    // 保证 UI 侧的"有没有可发送来源"判断(ChatInput/useConnectedSource/
    // isSelectedSourceDisconnected)与路由解析用的是同一份口径,不会互相打架。
    expect(chatEligibleSourcesForModel(views, 'shared-id', 'claude-code').map((p) => p.id)).toEqual([
      'openai',
    ]);
  });

  it('chatEligibleSourcesForModel 不误杀用户自定义供应商显式配置的模型(2026-07 review 第 25 轮)', () => {
    // flux-image-x 的 id 撞上 /image/ 启发式,但它来自 source:'user' 的自定义供应商且
    // group 是未知的 custom:*——isAgentSelectableModel 的 userProvider 例外有意放行
    // (用户显式配置的就是聊天模型)。裸 isChatEligible 会把它从路由/发送门禁里删掉,
    // 用户配好的模型 UI 显示"没有已连接的来源"、请求发不出去。
    const userProviderCatalog: Catalog = {
      version: 'test',
      providers: [
        {
          id: 'custom-p',
          name: 'Custom',
          source: 'user',
          agents: ['claude-code'],
          auth: { method: 'api-key' },
          routing: { 'claude-code': { upstream: 'https://custom.test', authStrategy: 'api-key' } },
          models: {
            'claude-code': [model('flux-image-x', { group: 'custom:custom-p' })],
          },
        },
      ],
    };
    const views = buildRegistry(userProviderCatalog, { 'custom-p': true });
    expect(
      chatEligibleSourcesForModel(views, 'flux-image-x', 'claude-code').map((p) => p.id),
    ).toEqual(['custom-p']);
    expect(effectiveSourceIdForModel(views, 'custom-p', 'flux-image-x', 'claude-code')).toBe(
      'custom-p',
    );
  });
});

describe('resolveRoute(运行时注入 fixture)', () => {
  const views = buildRegistry(runtimeCatalog(), { xd: true, anthropic: true, openai: true, xai: true });
  // xd 网关地址以内置身份卡(builtin.ts,端点单点)为准;门禁校验其与权威源一致
  const xdRouting = BUNDLED_CATALOG.providers.find((prov) => prov.id === 'xd')?.routing;

  it('anthropic claude (claude-code) → direct upstream, oauth-passthrough', () => {
    const r = resolveRoute(views, 'anthropic', 'claude-opus-4-8', 'claude-code');
    expect(r?.routing.upstream).toBe('https://api.anthropic.com');
    expect(r?.routing.authStrategy).toBe('oauth-passthrough');
  });

  it('anthropic claude (codex) → Anthropic Messages bridge + host-owned OAuth', () => {
    const r = resolveRoute(views, 'anthropic', 'claude-opus-4-8', 'codex');
    expect(r?.routing).toMatchObject({
      upstream: 'https://api.anthropic.com',
      wireProtocol: 'anthropic-messages',
      authStrategy: 'provider-oauth-header',
      headerOverride: {
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
      },
    });
  });

  it('xd claude (claude-code) → gateway, gateway-key, 不删 anthropic-beta(fast 经网关透传)', () => {
    const r = resolveRoute(views, 'xd', 'claude-opus-4-8', 'claude-code');
    expect(r?.routing.upstream).toBe(xdRouting?.['claude-code']?.upstream);
    expect(r?.routing.authStrategy).toBe('gateway-key');
    expect(r?.routing.headerDelete).toBeUndefined();
  });

  it('xd gpt (codex) → gateway/v1; openai gpt (codex) → chatgpt direct', () => {
    expect(resolveRoute(views, 'xd', 'gpt-5.5', 'codex')?.routing.upstream).toBe(xdRouting?.codex?.upstream);
    const oa = resolveRoute(views, 'openai', 'gpt-5.5', 'codex');
    expect(oa?.routing.upstream).toBe('https://chatgpt.com/backend-api/codex');
    expect(oa?.routing.authStrategy).toBe('oauth-passthrough');
  });

  it('xai grok (codex) → api.x.ai/v1 with provider OAuth token and xai/ model rewrite', () => {
    const r = resolveRoute(views, 'xai', 'xai/grok-4.3', 'codex');
    expect(r?.routing.upstream).toBe('https://api.x.ai/v1');
    expect(r?.routing.authStrategy).toBe('provider-oauth-header');
    expect(r?.routing.modelIdRewrite).toEqual({ stripPrefix: 'xai/' });
  });

  it('rejects unsupported (provider, model, agent) combos', () => {
    expect(resolveRoute(views, 'anthropic', 'gpt-5.5', 'claude-code')).toBeNull();
    expect(resolveRoute(views, 'openai', 'claude-opus-4-8', 'codex')).toBeNull();
    expect(resolveRoute(views, 'nope', 'claude-opus-4-8', 'claude-code')).toBeNull();
  });

  it('rejects a disabled route even when provider, model, and agent match', () => {
    const disabledViews = views.map((provider) =>
      provider.id === 'xai'
        ? {
            ...provider,
            routing: {
              ...provider.routing,
              codex: { ...provider.routing.codex!, disabled: true },
            },
          }
        : provider,
    );
    expect(resolveRoute(disabledViews, 'xai', 'xai/grok-4.3', 'codex')).toBeNull();
  });

  it('动态供应商未注入清单时不解析路由(无可用性证明不路由)', () => {
    const bare = buildRegistry(BUNDLED_CATALOG, { xd: true, anthropic: true, openai: true, xai: true });
    expect(resolveRoute(bare, 'anthropic', 'claude-opus-4-8', 'claude-code')).toBeNull();
    expect(resolveRoute(bare, 'xd', 'gpt-5.5', 'codex')).toBeNull();
    expect(resolveRoute(bare, 'xai', 'xai/grok-4.3', 'codex')?.routing.upstream).toBe('https://api.x.ai/v1');
  });
});
