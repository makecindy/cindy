import { afterEach, describe, expect, it } from 'vitest';

import {
  BUNDLED_CATALOG,
  buildUserProvider,
  type CustomProviderConfig,
} from '@cindy/model-providers';

import {
  buildCodexCustomProviderArgs,
  codexCustomProviderConfigSignature,
  codexCustomProviderRouteSignature,
  crossesCodexAppliedCustomProviderIdentity,
  deriveCodexCustomProviderRoutes,
  hasCodexAppliedCustomProviderCapability,
  isCodexCustomProviderNamespacePath,
  parseCodexCustomProviderPath,
  relativeProviderRequestPath,
  resolveCodexCustomProviderModelProviderId,
  setCodexAppliedCustomProviderRoutes,
  toCodexCustomProviderHostRoutes,
} from '../codex-custom-provider-route.js';
import { beginProviderRouteMutation } from '../provider-route.js';

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

    const disabled = customProvider({
      runtimes: {
        codex: {
          baseUrl: 'https://provider.example/v1',
          wireProtocol: 'openai-responses',
          models: [{ id: 'vision-input', name: 'Vision Input', supportsImageInput: true }],
        },
      },
    });
    expect(deriveCodexCustomProviderRoutes(catalog(disabled))).toEqual([]);
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

    const disabled = structuredClone(config);
    delete disabled.runtimes.codex?.supportsImageGeneration;
    expect(codexCustomProviderConfigSignature(disabled)).toBe('');
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
