import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  BUNDLED_CATALOG,
  bindProviderPresetRuntime,
  buildUserProvider,
  type CustomProviderConfig,
} from '@cindy/model-providers';

import {
  buildCodexCustomProviderArgs,
  codexCustomProviderConfigSignature,
  codexCustomProviderRouteSignature,
  crossesCodexAppliedCustomProviderIdentity,
  deriveCodexCustomProviderRoutes,
  hasAppliedCodexCustomProviderRoute,
  hasCodexAppliedCustomProviderCapability,
  isCodexCustomProviderNamespacePath,
  parseCodexCustomProviderPath,
  relativeProviderRequestPath,
  registerCodexScopedCustomProviderRoutes,
  resolveCodexCustomProviderModelProviderId,
  setCodexAppliedCustomProviderRoutes,
  toCodexCustomProviderHostRoutes,
} from '../codex-custom-provider-route.js';
import { setActiveCatalog } from '../active-catalog.js';
import { beginProviderRouteMutation } from '../provider-route.js';
import { configureSessionModelInterfaceStorage, sessionModelInterface } from '../session-model-interface.js';

function customProvider(overrides: Partial<CustomProviderConfig> = {}) {
  return buildUserProvider({
    id: 'provider-alpha',
    name: 'Custom Provider Fixture',
    runtimes: {
      codex: {
        baseUrl: 'https://provider.example/v1',
        requestPath: '/v1/responses',
        wireProtocol: 'openai-responses',
        supportsImageGeneration: true,
        models: [
          { id: 'chat-image', name: 'Chat Image' },
          { id: 'chat-image-alt', name: 'Chat Image Alt' },
          {
            id: 'chat-text',
            name: 'Chat Text',
            supportsImageInput: true,
            route: {
              baseUrl: 'https://provider.example/v1',
              wireProtocol: 'openai-chat',
            },
          },
        ],
      },
    },
    ...overrides,
  });
}

function catalog(provider = customProvider()) {
  return { ...BUNDLED_CATALOG, providers: [...BUNDLED_CATALOG.providers, provider] };
}

afterEach(() => {
  setCodexAppliedCustomProviderRoutes([]);
  setActiveCatalog(BUNDLED_CATALOG);
  configureSessionModelInterfaceStorage(() => null);
});

describe('Codex custom Provider identity', () => {
  it('derives one stable identity per enabled Provider for every eligible Responses model', () => {
    const routes = deriveCodexCustomProviderRoutes(catalog());
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      providerId: 'provider-alpha',
      capabilities: { imageGeneration: true },
      responseModels: ['chat-image', 'chat-image-alt'],
    });
    expect(routes[0]?.routing.supportsImageGeneration).toBeUndefined();
    expect(toCodexCustomProviderHostRoutes(routes)).toEqual([
      expect.objectContaining({
        capabilities: { imageGeneration: true },
        responseModels: ['chat-image', 'chat-image-alt'],
      }),
    ]);
    expect(routes[0]?.modelProviderId).toMatch(/^cindy_custom_[a-f0-9]{20}$/);
    expect(resolveCodexCustomProviderModelProviderId(routes, 'provider-alpha', 'chat-image')).toBe(
      routes[0]?.modelProviderId,
    );
    expect(
      resolveCodexCustomProviderModelProviderId(routes, 'provider-alpha', 'chat-image-alt'),
    ).toBe(routes[0]?.modelProviderId);
    expect(
      resolveCodexCustomProviderModelProviderId(routes, 'provider-alpha', 'chat-text'),
    ).toBeNull();

    // Missing image generation is not a reason to drop the identity (#9611).
    // A Responses model still gets cindy_custom_<hash>; only the actor header stays off.
    const textOnly = customProvider({
      runtimes: {
        codex: {
          baseUrl: 'https://provider.example/v1',
          wireProtocol: 'openai-responses',
          models: [{ id: 'vision-input', name: 'Vision Input', supportsImageInput: true }],
        },
      },
    });
    const textRoutes = deriveCodexCustomProviderRoutes(catalog(textOnly));
    expect(textRoutes).toHaveLength(1);
    expect(textRoutes[0]).toMatchObject({
      capabilities: { imageGeneration: false },
      responseModels: ['vision-input'],
    });
    expect(
      buildCodexCustomProviderArgs('http://127.0.0.1:43210', 'env-key', textRoutes).extraArgs.join(' '),
    ).not.toContain('x-openai-actor-authorization');

    const chatOnly = customProvider({
      runtimes: {
        codex: {
          baseUrl: 'https://provider.example/v1',
          wireProtocol: 'openai-chat',
          models: [{ id: 'chat-only', name: 'Chat Only' }],
        },
      },
    });
    expect(deriveCodexCustomProviderRoutes(catalog(chatOnly))).toEqual([]);
  });

  // 测试价值
  // - 生产入口与可观察结果：deriveCodexCustomProviderRoutes / buildCodexCustomProviderArgs。
  //   没有图片生成能力的 Responses 自定义供应商也要拿到 cindy_custom_<hash>，
  //   并写进 Codex spawn 的 model_providers；否则 thread/resume 报 -32600（#9611）。
  // - Bug／规则依据：#9611。旧门槛要求 capabilities 里至少一项为 true，普通文本供应商被整条丢掉。
  // - 现有覆盖缺口：上面的用例把「没有 Responses 模型」和「没有图片能力」混在一起，
  //   期望空路由；本用例只去掉 supportsImageGeneration，保留 Responses 模型。
  // - 最小失败输入：openai-responses + 一个文本模型，不声明 supportsImageGeneration。
  // - tier：unit。调公开函数，不启 Electron、不访问网络。
  it('registers a Responses provider that has no image-generation capability', () => {
    const textOnly = customProvider({
      runtimes: {
        codex: {
          baseUrl: 'https://provider.example/v1',
          requestPath: '/v1/responses',
          wireProtocol: 'openai-responses',
          models: [{ id: 'chat-text-only', name: 'Chat Text Only' }],
        },
      },
    });
    const routes = deriveCodexCustomProviderRoutes(catalog(textOnly));
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      providerId: 'provider-alpha',
      capabilities: { imageGeneration: false },
      responseModels: ['chat-text-only'],
    });
    expect(routes[0]?.modelProviderId).toMatch(/^cindy_custom_[a-f0-9]{20}$/);
    expect(
      resolveCodexCustomProviderModelProviderId(routes, 'provider-alpha', 'chat-text-only'),
    ).toBe(routes[0]?.modelProviderId);

    const config = buildCodexCustomProviderArgs('http://127.0.0.1:43210', 'env-key', routes);
    const argv = config.extraArgs.join(' ');
    expect(argv).toContain(`model_providers.${routes[0]!.modelProviderId}.wire_api="responses"`);
    expect(argv).toContain(`/_cindy/custom-provider/${routes[0]!.routeId}`);
    expect(argv).not.toContain('x-openai-actor-authorization');
    expect(argv).not.toContain('provider.example');
  });

  // 测试价值
  // - 生产入口与可观察结果：hasAppliedCodexCustomProviderRoute。纯文本路由也要算已应用，
  //   OAuth 重新登录才会重建 Host；否则凭证代次推进后专用路由持续 503（#9759）。
  // - Bug／规则依据：#9759。旧判断只认 imageGeneration 已应用，纯文本路由被漏掉。
  // - 现有覆盖缺口：hasCodexAppliedCustomProviderCapability 要求能力为 true，
  //   覆盖不了「没有图片能力但路由已冻结」。
  // - 最小失败输入：imageGeneration: false 的已应用路由；另一个不匹配的 providerId。
  // - tier：unit。调公开函数，不启 Electron、不访问网络。
  it('treats an applied text-only route as present and ignores a different provider', () => {
    const textOnly = customProvider({
      runtimes: {
        codex: {
          baseUrl: 'https://provider.example/v1',
          requestPath: '/v1/responses',
          wireProtocol: 'openai-responses',
          models: [{ id: 'chat-text-only', name: 'Chat Text Only' }],
        },
      },
    });
    const [route] = deriveCodexCustomProviderRoutes(catalog(textOnly));
    expect(route?.capabilities.imageGeneration).toBe(false);
    setCodexAppliedCustomProviderRoutes(route ? [route] : []);

    expect(hasAppliedCodexCustomProviderRoute('provider-alpha')).toBe(true);
    expect(hasAppliedCodexCustomProviderRoute('custom:xai')).toBe(false);
    expect(hasAppliedCodexCustomProviderRoute('provider-other')).toBe(false);

    const release = registerCodexScopedCustomProviderRoutes('external:text', route ? [route] : []);
    try {
      setCodexAppliedCustomProviderRoutes([]);
      expect(hasAppliedCodexCustomProviderRoute('provider-alpha')).toBe(true);
    } finally {
      release();
    }
    expect(hasAppliedCodexCustomProviderRoute('provider-alpha')).toBe(false);
  });

  // 测试价值
  // - 生产入口与可观察结果：deriveCodexCustomProviderRoutes（内部 routeForProvider）。
  //   auth.native === 'codex' 的额外订阅账号不得拿到 cindy_custom_<hash>，否则占位 bearer
  //   会发给 chatgpt.com；不带 native 的纯文本供应商仍要有路由（#9759）。
  // - Bug／规则依据：#9759。去掉图片能力门槛后，source:'user' 的原生订阅账号被卷进来。
  // - 现有覆盖缺口：文本供应商用例没有 auth.native。
  // - 最小失败输入：oauth + native:'codex'，并带一个 openai-responses 模型。
  // - tier：unit。调公开函数，不启 Electron、不访问网络。
  it('does not register a native Codex subscription account on the custom route', () => {
    const nativeCodex = customProvider({
      id: 'extra-chatgpt',
      name: 'Extra ChatGPT',
      auth: { method: 'oauth', native: 'codex' },
      runtimes: {
        codex: {
          baseUrl: 'https://chatgpt.com/backend-api/codex',
          wireProtocol: 'openai-responses',
          models: [{ id: 'gpt-subscription', name: 'GPT Subscription' }],
        },
      },
    });
    expect(nativeCodex.auth.native).toBe('codex');
    expect(nativeCodex.models.codex?.map((model) => model.id)).toEqual(['gpt-subscription']);
    expect(deriveCodexCustomProviderRoutes(catalog(nativeCodex))).toEqual([]);

    const textOnly = customProvider({
      runtimes: {
        codex: {
          baseUrl: 'https://provider.example/v1',
          requestPath: '/v1/responses',
          wireProtocol: 'openai-responses',
          models: [{ id: 'chat-text-only', name: 'Chat Text Only' }],
        },
      },
    });
    expect(deriveCodexCustomProviderRoutes(catalog(textOnly))).toHaveLength(1);
  });

  // 测试价值
  // - 生产入口与可观察结果：deriveCodexCustomProviderRoutes。
  //   Cloudflare AI Gateway 预设的 Responses 模型不再登记成 cindy_custom 路由；
  //   同一目录里普通自定义供应商仍然登记。
  // - Bug／规则依据：#9759。命名空间路由只发普通 Bearer，
  //   而这类预设靠原生适配器把密钥写进 cf-aig-authorization 并删掉 Authorization。
  //   它们没有 auth.native，旧判断会把它们登记进去，连接认证直接失败。
  // - 现有覆盖缺口：上面只排除 auth.native 的订阅账号。
  // - 最小失败输入：绑定账号后的 cloudflare-ai-gateway 预设，加一条普通 Responses 供应商。
  // - tier：unit。调公开函数，不启 Electron、不访问网络。
  it('does not register Cloudflare AI Gateway Responses models on the custom route', () => {
    const preset = BUNDLED_CATALOG.presets!.find((item) => item.id === 'cloudflare-ai-gateway')!;
    const runtimes = Object.fromEntries(Object.entries(preset.runtimes).map(([agent, runtime]) => [agent, {
      ...bindProviderPresetRuntime(
        runtime!,
        runtime!.baseUrl
          .replace('{CLOUDFLARE_ACCOUNT_ID}', 'fixture-account')
          .replace('{CLOUDFLARE_GATEWAY_ID}', 'fixture-gateway'),
      ),
      catalogPresetId: preset.id,
    }]));
    const gateway = buildUserProvider(
      { id: 'my-cloudflare', name: 'My Cloudflare', runtimes },
      { presets: BUNDLED_CATALOG.presets },
    );
    expect(gateway.auth.native).toBeUndefined();
    expect(gateway.models.codex?.some((model) => model.id === 'gpt-4.1')).toBe(true);

    const routes = deriveCodexCustomProviderRoutes(catalog(gateway));
    expect(routes.find((route) => route.providerId === 'my-cloudflare')).toBeUndefined();
    expect(routes.flatMap((route) => route.responseModels)).not.toContain('gpt-4.1');

    const ordinary = customProvider({
      id: 'ordinary-responses',
      name: 'Ordinary Responses',
      runtimes: {
        codex: {
          baseUrl: 'https://provider.example/v1',
          requestPath: '/v1/responses',
          wireProtocol: 'openai-responses',
          models: [{ id: 'chat-text-only', name: 'Chat Text Only' }],
        },
      },
    });
    const ordinaryRoutes = deriveCodexCustomProviderRoutes(catalog(ordinary));
    expect(ordinaryRoutes).toHaveLength(1);
    expect(ordinaryRoutes[0]).toMatchObject({
      providerId: 'ordinary-responses',
      responseModels: ['chat-text-only'],
    });
  });

  // 测试价值
  // - 生产入口与可观察结果：resolveCodexCustomProviderModelProviderId。
  //   任务已把接口固定成 Chat 时返回 null；同一型号没有快照、或快照仍是 Responses 时仍返回 cindy_custom 身份。
  // - Bug／规则依据：#9759。当前目录默认改成 Responses 后，旧 Chat 任务也会被登记成动态身份，
  //   恢复时从 /chat/completions 静默切到 /responses。
  // - 现有覆盖缺口：身份解析不看 sessionModelInterface。
  // - 最小失败输入：Kimi Code 的 k3.1-pro，先用 openai-completions 固定任务，再把目录默认改回 Responses。
  // - tier：unit。调公开函数，不启 Electron、不访问网络。
  it('keeps a Chat-pinned task off the custom Responses identity', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'codex-custom-interface-'));
    const config = {
      id: 'provider-kimi',
      name: 'Kimi',
      runtimes: {
        codex: {
          catalogPresetId: 'moonshot-kimi-code',
          baseUrl: 'https://api.kimi.com/coding/v1',
          wireProtocol: 'openai-chat' as const,
          models: [{ id: 'k3.1-pro', name: 'Kimi' }],
        },
      },
    };
    try {
      configureSessionModelInterfaceStorage(() => directory);
      const chatRegistry = structuredClone(BUNDLED_CATALOG.modelRegistry!);
      const chatRoute = chatRegistry.models.flatMap(entry => entry.routes)
        .find(item => item.providerId === 'moonshot-kimi-code' && item.modelId === 'k3.1-pro')!;
      chatRoute.preferredInterfaces!.codex = ['moonshot-kimi-code-openai-completions'];
      const chatProvider = buildUserProvider(config, {
        modelRegistry: chatRegistry,
        presets: BUNDLED_CATALOG.presets,
      });
      const pinned = sessionModelInterface(
        'old-chat-task',
        config.id,
        'codex',
        chatProvider.models.codex![0]!,
        chatRegistry,
      );
      expect(pinned?.api).toBe('openai-completions');

      const responsesRegistry = structuredClone(BUNDLED_CATALOG.modelRegistry!);
      const responsesRoute = responsesRegistry.models.flatMap(entry => entry.routes)
        .find(item => item.providerId === 'moonshot-kimi-code' && item.modelId === 'k3.1-pro')!;
      responsesRoute.preferredInterfaces!.codex = ['moonshot-kimi-code-openai-responses'];
      const provider = buildUserProvider(config, {
        modelRegistry: responsesRegistry,
        presets: BUNDLED_CATALOG.presets,
      });
      expect(provider.models.codex![0]?.route?.wireProtocol).toBe('openai-responses');
      const routes = deriveCodexCustomProviderRoutes({
        ...BUNDLED_CATALOG,
        modelRegistry: responsesRegistry,
        providers: [...BUNDLED_CATALOG.providers, provider],
      });
      setActiveCatalog({
        ...BUNDLED_CATALOG,
        modelRegistry: responsesRegistry,
        providers: [...BUNDLED_CATALOG.providers, provider],
      });
      expect(routes[0]?.responseModels).toContain('k3.1-pro');

      expect(
        resolveCodexCustomProviderModelProviderId(routes, config.id, 'k3.1-pro', 'old-chat-task'),
      ).toBeNull();
      expect(
        resolveCodexCustomProviderModelProviderId(routes, config.id, 'k3.1-pro'),
      ).toBe(routes[0]?.modelProviderId);

      const responsesPinned = sessionModelInterface(
        'responses-task',
        config.id,
        'codex',
        provider.models.codex![0]!,
        responsesRegistry,
      );
      expect(responsesPinned?.api).toBe('openai-responses');
      expect(
        resolveCodexCustomProviderModelProviderId(routes, config.id, 'k3.1-pro', 'responses-task'),
      ).toBe(routes[0]?.modelProviderId);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('uses the applied Host snapshot to identify only real dynamic identity crossings', () => {
    const routeA = deriveCodexCustomProviderRoutes(catalog())[0]!;
    const routeB = deriveCodexCustomProviderRoutes(
      catalog(customProvider({ id: 'provider-b', name: 'Provider B' })),
    )[0]!;
    setCodexAppliedCustomProviderRoutes([routeA, routeB]);
    const base = {
      agentKind: 'codex',
      remoteHostId: null,
      currentCodexProxyActive: true,
      currentThreadModelProviderId: routeA.modelProviderId,
    };

    expect(
      crossesCodexAppliedCustomProviderIdentity({
        ...base,
        targetProviderId: routeA.providerId,
        targetModel: 'chat-image-alt',
      }),
    ).toBe(false);
    expect(
      crossesCodexAppliedCustomProviderIdentity({
        ...base,
        targetProviderId: routeA.providerId,
        targetModel: 'chat-text',
      }),
    ).toBe(true);
    expect(
      crossesCodexAppliedCustomProviderIdentity({
        ...base,
        currentThreadModelProviderId: 'cindy_gateway',
        targetProviderId: routeA.providerId,
        targetModel: 'chat-image',
      }),
    ).toBe(true);
    expect(
      crossesCodexAppliedCustomProviderIdentity({
        ...base,
        targetProviderId: routeB.providerId,
        targetModel: 'chat-image',
      }),
    ).toBe(true);
    expect(
      crossesCodexAppliedCustomProviderIdentity({
        ...base,
        currentThreadModelProviderId: 'cindy_gateway',
        targetProviderId: 'ordinary-provider',
        targetModel: 'ordinary-model',
      }),
    ).toBe(false);
    expect(
      crossesCodexAppliedCustomProviderIdentity({
        ...base,
        currentThreadModelProviderId: 'cindy_imagegen_0123456789abcdefabcd',
        targetProviderId: 'ordinary-provider',
        targetModel: 'ordinary-model',
      }),
    ).toBe(true);
  });

  it('keeps the identity stable while including capability changes in the host snapshot', () => {
    const before = deriveCodexCustomProviderRoutes(catalog())[0]!;
    const changed = customProvider({
      runtimes: {
        codex: {
          baseUrl: 'https://other.example/openai',
          wireProtocol: 'openai-responses',
          supportsImageGeneration: true,
          models: [{ id: 'new-image', name: 'New Image' }],
        },
      },
    });
    const afterCatalog = catalog(changed);
    const after = deriveCodexCustomProviderRoutes(afterCatalog)[0]!;
    expect(after.modelProviderId).toBe(before.modelProviderId);
    expect(codexCustomProviderRouteSignature(afterCatalog)).not.toBe(
      codexCustomProviderRouteSignature(catalog()),
    );
  });

  it('uses one generic provider config for multiple capability declarations', () => {
    const route = deriveCodexCustomProviderRoutes(catalog())[0]!;
    const multiCapabilityRoute = {
      ...route,
      capabilities: { ...route.capabilities, futureCapabilityFixture: true },
    };
    setCodexAppliedCustomProviderRoutes([multiCapabilityRoute]);

    expect(hasCodexAppliedCustomProviderCapability(route.providerId, 'imageGeneration')).toBe(true);
    expect(
      hasCodexAppliedCustomProviderCapability(route.providerId, 'futureCapabilityFixture'),
    ).toBe(true);
    const config = buildCodexCustomProviderArgs('http://127.0.0.1:43210', 'env-key', [
      multiCapabilityRoute,
    ]);
    expect(config.extraArgs.filter((arg) => arg.includes('.name='))).toHaveLength(1);
    expect(config.extraArgs.join(' ')).toContain(route.modelProviderId);

    const futureOnlyConfig = buildCodexCustomProviderArgs('http://127.0.0.1:43210', 'env-key', [
      { ...route, capabilities: { futureCapabilityFixture: true } },
    ]);
    expect(futureOnlyConfig.extraArgs.join(' ')).not.toContain('x-openai-actor-authorization');
  });

  it('builds actor-gated loopback config without upstream URLs or user credentials', () => {
    const route = deriveCodexCustomProviderRoutes(catalog())[0]!;
    const config = buildCodexCustomProviderArgs('http://127.0.0.1:43210', 'oauth-bearer', [route]);
    const argv = config.extraArgs.join(' ');
    expect(argv).toContain(`model_providers.${route.modelProviderId}.name="Cindy Custom Provider"`);
    expect(argv).toContain('x-openai-actor-authorization = "local-image-extension"');
    expect(argv).toContain('supports_websockets=false');
    expect(argv).toContain(`/_cindy/custom-provider/${route.routeId}`);
    expect(argv).not.toContain('provider.example');
    expect(argv).not.toContain('provider-alpha');
    expect(config.extraEnv.XDT_CODEX_API_KEY).toBeTruthy();
  });

  it('keeps custom header credentials out of the Host snapshot and signature input', () => {
    const secret = 'Bearer fake-vendor-secret';
    const storedConfig: CustomProviderConfig = {
      id: 'provider-alpha',
      name: 'Custom Provider Fixture',
      runtimes: {
        codex: {
          baseUrl: 'https://provider.example/v1',
          wireProtocol: 'openai-responses',
          supportsImageGeneration: true,
          headers: { Authorization: secret, 'x-vendor-token': 'fake-token' },
          models: [{ id: 'chat-image', name: 'Chat Image' }],
        },
      },
    };
    const provider = buildUserProvider(storedConfig);
    const route = deriveCodexCustomProviderRoutes(catalog(provider))[0]!;
    expect(JSON.stringify(route)).not.toContain(secret);
    expect(JSON.stringify(route)).not.toContain('fake-token');
    expect(route.routing.headerOverride).toBeUndefined();

    const before = codexCustomProviderRouteSignature(catalog(provider));
    const mutation = beginProviderRouteMutation(provider.id);
    mutation.commit();
    mutation();
    const after = codexCustomProviderRouteSignature(catalog(provider));
    expect(after).not.toBe(before);
    expect(after).not.toContain(secret);

    const perProviderSignature = codexCustomProviderConfigSignature(storedConfig);
    expect(perProviderSignature).not.toContain(secret);
    expect(perProviderSignature).not.toContain('fake-token');
  });

  it('signs only fields that affect the generic Codex route or capability', () => {
    const config: CustomProviderConfig = {
      id: 'provider-alpha',
      name: 'Display name A',
      runtimes: {
        codex: {
          baseUrl: 'https://provider.example/v1',
          modelsUrl: 'https://provider.example/v1/models-a',
          requestPath: '/responses-a',
          wireProtocol: 'openai-responses',
          supportsImageGeneration: true,
          models: [
            { id: 'model-a', name: 'Model A' },
            { id: 'model-b', name: 'Model B' },
          ],
        },
      },
    };
    const baseline = codexCustomProviderConfigSignature(config);
    const displayOnly: CustomProviderConfig = {
      ...config,
      name: 'Display name B',
      runtimes: {
        ...config.runtimes,
        codex: {
          ...config.runtimes.codex!,
          modelsUrl: 'https://provider.example/v1/models-b',
          models: [
            { id: 'model-b', name: 'Renamed B', defaultEnabled: false },
            { id: 'model-a', name: 'Renamed A', defaultEnabled: false },
          ],
        },
      },
    };
    expect(codexCustomProviderConfigSignature(displayOnly)).toBe(baseline);

    const routeChanged: CustomProviderConfig = {
      ...displayOnly,
      runtimes: {
        ...displayOnly.runtimes,
        codex: { ...displayOnly.runtimes.codex!, requestPath: '/responses-b' },
      },
    };
    expect(codexCustomProviderConfigSignature(routeChanged)).not.toBe(baseline);

    const effortChanged = structuredClone(config);
    effortChanged.runtimes.codex!.models![0]!.reasoning = true;
    effortChanged.runtimes.codex!.models![0]!.reasoningEfforts = ['high'];
    expect(codexCustomProviderConfigSignature(effortChanged)).not.toBe(baseline);
    expect(codexCustomProviderRouteSignature(catalog(buildUserProvider(effortChanged))))
      .not.toBe(codexCustomProviderRouteSignature(catalog(buildUserProvider(config))));

    // Turning image generation off changes the snapshot, but does not erase the identity (#9611).
    const textOnly = structuredClone(config);
    delete textOnly.runtimes.codex?.supportsImageGeneration;
    const textSignature = codexCustomProviderConfigSignature(textOnly);
    expect(textSignature).not.toBe('');
    expect(textSignature).not.toBe(baseline);
    expect(deriveCodexCustomProviderRoutes(catalog(buildUserProvider(textOnly)))).toMatchObject([
      { capabilities: { imageGeneration: false }, responseModels: ['model-a', 'model-b'] },
    ]);

    const chatOnly = structuredClone(config);
    chatOnly.runtimes.codex!.wireProtocol = 'openai-chat';
    expect(codexCustomProviderConfigSignature(chatOnly)).toBe('');
  });

  it('parses only the dedicated route and strips the prefix completely', () => {
    const routeId = 'a'.repeat(20);
    expect(
      parseCodexCustomProviderPath(`/_cindy/custom-provider/${routeId}/responses?x=1`),
    ).toEqual({
      kind: 'route',
      routeId,
      upstreamPath: '/responses?x=1',
      pathKind: 'responses',
    });
    expect(
      parseCodexCustomProviderPath(`/_cindy/custom-provider/${routeId}/images/generations`),
    ).toEqual({
      kind: 'route',
      routeId,
      upstreamPath: '/images/generations',
      pathKind: 'images',
    });
    expect(parseCodexCustomProviderPath(`/_cindy/custom-provider/${routeId}/images/edits`)).toEqual(
      {
        kind: 'route',
        routeId,
        upstreamPath: '/images/edits',
        pathKind: 'images',
      },
    );
    expect(parseCodexCustomProviderPath('/v1/images/generations')).toEqual({
      kind: 'not-custom-provider-route',
    });
  });

  it('claims raw private namespace variants before normalization and rejects non-canonical paths', () => {
    const routeId = 'a'.repeat(20);
    const invalid = [
      '/_cindy/custom-provider',
      '/_cindy/custom-provider/',
      '/_cindy/custom-provider//',
      '/_cindy/custom-provider/../responses',
      '/_cindy/custom-provider/%2e%2e/responses',
      '/_CINDY/CUSTOM-PROVIDER/' + routeId + '/responses',
      '/_%63indy/custom-provid%65r/' + routeId + '/responses',
      '/_cindy/custom-provider%2f' + routeId + '/responses',
      '/_cindy/custom-provider%5c' + routeId + '/responses',
      '/_cindy/custom-provider/' + routeId + '/images/edits/extra',
      '/_cindy/custom-provider/' + routeId + '/images/edits#fragment',
      'https://localhost/_cindy/custom-provider/../responses',
      '/_cindy/imagegen/' + routeId + '/images/edits',
    ];
    for (const path of invalid) {
      expect(isCodexCustomProviderNamespacePath(path), path).toBe(true);
      expect(parseCodexCustomProviderPath(path), path).toEqual({ kind: 'invalid' });
    }
    expect(isCodexCustomProviderNamespacePath('/v1/not-imagegen/responses')).toBe(false);
  });

  it('uses chat requestPath without duplicating an upstream /v1 base path', () => {
    expect(relativeProviderRequestPath('https://provider.example/v1', '/v1/responses')).toBe(
      '/responses',
    );
    expect(relativeProviderRequestPath('https://provider.example/v1/', '/responses')).toBe(
      '/responses',
    );
    expect(relativeProviderRequestPath('https://provider.example/v1', '//evil')).toBeNull();
  });
});


describe('scoped Host capabilities', () => {
  it('keeps capability snapshots until their own Host retires', () => {
    const routes = deriveCodexCustomProviderRoutes(catalog());
    const releaseOld = registerCodexScopedCustomProviderRoutes('external:1', routes);
    const releaseNew = registerCodexScopedCustomProviderRoutes('external:2', routes);
    try {
      setCodexAppliedCustomProviderRoutes([]);
      expect(hasCodexAppliedCustomProviderCapability('provider-alpha', 'imageGeneration')).toBe(true);
      releaseOld();
      expect(hasCodexAppliedCustomProviderCapability('provider-alpha', 'imageGeneration')).toBe(true);
      releaseNew();
      expect(hasCodexAppliedCustomProviderCapability('provider-alpha', 'imageGeneration')).toBe(false);
    } finally {
      releaseOld();
      releaseNew();
    }
  });
});
