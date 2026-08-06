import { afterEach, describe, expect, it, vi } from 'vitest';

import { BUNDLED_CATALOG, buildUserProvider } from '@cindy/model-providers';

import {
  clearAccountDerivedProviderModels,
  clearResolvedProviderModels,
  commitModelPlaneFromCatalog,
  getActiveCatalog,
  getActiveCatalogRevision,
  setActiveCatalog,
  setActiveCatalogChangedListener,
  setAnthropicDiscoveredModels,
  setCustomProviders,
  setDiscoveredCodexModels,
  setDiscoveredProviderModels,
  setModelResolveApplySlotsInvalidator,
  setResolvedProviderModels,
} from '../active-catalog.js';

describe('active catalog revision', () => {
  afterEach(() => {
    setModelResolveApplySlotsInvalidator(null);
    setActiveCatalogChangedListener(null);
    setActiveCatalog(BUNDLED_CATALOG);
    setAnthropicDiscoveredModels([]);
    setCustomProviders([]);
    setDiscoveredCodexModels([]);
    setDiscoveredProviderModels('xai', 'codex', []);
    clearResolvedProviderModels();
  });

  it('invalidates the merged catalog before notifying one monotonic revision', () => {
    const start = getActiveCatalogRevision();
    const listener = vi.fn((revision: number) => ({
      revision,
      ids: getActiveCatalog()
        .providers.find((provider) => provider.id === 'openai')
        ?.models.codex?.map((model) => model.id),
    }));
    setActiveCatalogChangedListener(listener);

    setDiscoveredCodexModels([
      {
        id: 'gpt-next-live',
        name: 'GPT Next Live',
        contextWindow: 300_000,
        efforts: ['high'],
        defaultEffort: 'high',
      },
    ]);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.results[0]?.value).toMatchObject({ revision: start + 1 });
    expect(listener.mock.results[0]?.value.ids).toContain('gpt-next-live');
  });

  it('routes Anthropic discovery through the same revision listener', () => {
    const start = getActiveCatalogRevision();
    const listener = vi.fn((revision: number) => ({
      revision,
      ids: getActiveCatalog()
        .providers.find((provider) => provider.id === 'anthropic')
        ?.models['claude-code']?.map((model) => model.id),
    }));
    setActiveCatalogChangedListener(listener);

    setAnthropicDiscoveredModels([
      {
        id: 'claude-opus-next',
        name: 'Claude Opus Next',
        contextWindow: 1_000_000,
        efforts: ['high'],
        defaultEffort: 'high',
      },
    ]);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.results[0]?.value).toMatchObject({ revision: start + 1 });
    expect(listener.mock.results[0]?.value.ids).toContain('claude-opus-next');
  });

  it('keeps one local identity when a remote-added provider later collides with its id', () => {
    setActiveCatalog({
      version: '3',
      providers: [
        {
          id: 'custom-collision',
          name: 'Remote Catalog Provider',
          source: 'builtin',
          agents: ['codex'],
          auth: { method: 'apiKey' },
          routing: {
            codex: {
              upstream: 'https://attacker.example/v1',
              authStrategy: 'api-key-header',
            },
          },
          models: {
            codex: [
              {
                id: 'collision-model',
                name: 'Remote Model',
                contextWindow: 100_000,
                efforts: [],
                defaultEffort: null,
              },
            ],
          },
        },
      ],
    });
    setCustomProviders([
      buildUserProvider({
        id: 'custom-collision',
        name: 'Local Custom Provider',
        runtimes: {
          codex: {
            baseUrl: 'https://local.example/v1',
            models: [{ id: 'collision-model', name: 'Local Model' }],
          },
        },
      }),
    ]);

    const matches = getActiveCatalog().providers.filter(
      (provider) => provider.id === 'custom-collision',
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      name: 'Local Custom Provider',
      source: 'user',
      routing: { codex: { upstream: 'https://local.example/v1' } },
    });
  });

  it('resolved overlay changes fields without adding, deleting, or reordering discovery membership', () => {
    const discovery = [
      {
        id: 'xai/resolved-a',
        name: 'Fallback A',
        contextWindow: 200_000,
        efforts: [],
        defaultEffort: null,
      },
      {
        id: 'xai/plain-b',
        name: 'Plain B',
        contextWindow: 200_000,
        efforts: [],
        defaultEffort: null,
      },
    ];
    setDiscoveredProviderModels('xai', 'codex', discovery);
    setResolvedProviderModels(
      'xai',
      'codex',
      ['xai/resolved-a'],
      [
        {
          ...discovery[0],
          name: 'Resolved A',
          contextWindow: 1_000_000,
          efforts: ['high'],
          defaultEffort: 'high',
          group: 'grok',
        },
        {
          id: 'xai/must-not-be-added',
          name: 'Must Not Be Added',
          contextWindow: 1,
          efforts: [],
          defaultEffort: null,
        },
      ],
      'knowledge-r1',
      getActiveCatalog().providers.find((provider) => provider.id === 'xai')!.models.codex!
        .map((model) => model.id),
    );

    const models = getActiveCatalog().providers.find((provider) => provider.id === 'xai')!
      .models.codex!;
    expect(models.filter((model) => discovery.some((item) => item.id === model.id)).map((m) => m.id))
      .toEqual(['xai/resolved-a', 'xai/plain-b']);
    expect(models.some((model) => model.id === 'xai/must-not-be-added')).toBe(false);
    expect(models.find((model) => model.id === 'xai/resolved-a')).toMatchObject({
      name: 'Resolved A',
      contextWindow: 1_000_000,
      source: 'resolved',
      knowledgeRevision: 'knowledge-r1',
    });
    expect(models.find((model) => model.id === 'xai/plain-b')).not.toHaveProperty('source');

    setDiscoveredProviderModels('xai', 'codex', [...discovery, {
      id: 'xai/newer-c',
      name: 'Newer C',
      contextWindow: 200_000,
      efforts: [],
      defaultEffort: null,
    }]);
    const refreshed = getActiveCatalog().providers.find((provider) => provider.id === 'xai')!
      .models.codex!;
    expect(refreshed.find((model) => model.id === 'xai/resolved-a')).not.toHaveProperty('source');
  });

  it('treats undefined resolved fields as absent instead of clearing catalog metadata', () => {
    const discovered = {
      id: 'xai/hidden-model',
      name: 'Hidden Model',
      description: 'Keep this description',
      category: 'grok',
      contextWindow: 200_000,
      efforts: [],
      defaultEffort: null,
      defaultEnabled: false,
    };
    setDiscoveredProviderModels('xai', 'codex', [discovered]);
    const liveModelIds = getActiveCatalog().providers
      .find((provider) => provider.id === 'xai')!
      .models.codex!.map((model) => model.id);
    setResolvedProviderModels(
      'xai',
      'codex',
      [discovered.id],
      [{
        ...discovered,
        name: 'Resolved Name',
        description: undefined,
        category: undefined,
        defaultEnabled: undefined,
      }],
      'knowledge-metadata-only',
      liveModelIds,
    );

    expect(
      getActiveCatalog().providers.find((provider) => provider.id === 'xai')!
        .models.codex?.find((model) => model.id === discovered.id),
    ).toMatchObject({
      name: 'Resolved Name',
      description: 'Keep this description',
      category: 'grok',
      defaultEnabled: false,
      source: 'resolved',
    });
  });

  it('applies resolved metadata when additions-only discovery preserves a different live order', () => {
    const providerId = 'reordered-user';
    const configured = [
      {
        id: 'vendor/pinned-first',
        name: 'Pinned First',
      },
      {
        id: 'vendor/upstream-first',
        name: 'Upstream First',
      },
    ];
    setCustomProviders([buildUserProvider({
      id: providerId,
      name: 'Reordered User Provider',
      runtimes: {
        codex: {
          baseUrl: 'https://models.example/v1',
          models: configured,
        },
      },
    })]);
    const liveModels = getActiveCatalog().providers.find((provider) => provider.id === providerId)!
      .models.codex!;

    setResolvedProviderModels(
      providerId,
      'codex',
      ['vendor/upstream-first', 'vendor/pinned-first'],
      [
        { ...liveModels[1], category: 'gpt' },
        { ...liveModels[0], category: 'anthropic' },
      ],
      'knowledge-reordered',
      ['vendor/upstream-first', 'vendor/pinned-first'],
    );

    const models = getActiveCatalog().providers.find((provider) => provider.id === providerId)!
      .models.codex!;
    expect(models.map((model) => model.id)).toEqual([
      'vendor/pinned-first',
      'vendor/upstream-first',
    ]);
    expect(models.map((model) => model.category)).toEqual(['anthropic', 'gpt']);
    expect(models.every((model) => model.source === 'resolved')).toBe(true);
  });

  it.each([
    ['baseUrl', { baseUrl: 'https://new-runtime.example/v1' }],
    ['modelsUrl', { modelsUrl: 'https://new-runtime.example/v1/models' }],
    ['requestPath', { requestPath: '/v2/responses' }],
  ] as const)(
    'invalidates a custom provider resolve overlay when its %s changes',
    (_field, runtimeChange) => {
      const providerId = 'runtime-change-user';
      const invalidateApplySlots = vi.fn();
      setModelResolveApplySlotsInvalidator(invalidateApplySlots);
      const runtime = {
        baseUrl: 'https://old-runtime.example/v1',
        models: [{ id: 'vendor/model', name: 'Provider Model' }],
      };
      setCustomProviders([buildUserProvider({
        id: providerId,
        name: 'Runtime Change User',
        runtimes: { codex: runtime },
      })]);
      const liveModel = getActiveCatalog().providers.find((provider) => provider.id === providerId)!
        .models.codex![0]!;
      setResolvedProviderModels(
        providerId,
        'codex',
        [liveModel.id],
        [{ ...liveModel, contextWindow: 1_000_000, source: 'resolved' }],
        'runtime-change-r1',
        [liveModel.id],
      );
      expect(
        getActiveCatalog().providers.find((provider) => provider.id === providerId)!
          .models.codex![0],
      ).toMatchObject({ contextWindow: 1_000_000, source: 'resolved' });
      invalidateApplySlots.mockClear();

      setCustomProviders([buildUserProvider({
        id: providerId,
        name: 'Runtime Change User',
        runtimes: { codex: { ...runtime, ...runtimeChange } },
      })]);

      expect(
        getActiveCatalog().providers.find((provider) => provider.id === providerId)!
          .models.codex![0],
      ).toMatchObject({ contextWindow: 200_000 });
      expect(
        getActiveCatalog().providers.find((provider) => provider.id === providerId)!
          .models.codex![0],
      ).not.toHaveProperty('source');
      expect(invalidateApplySlots).toHaveBeenCalledOnce();
      expect(invalidateApplySlots).toHaveBeenCalledWith([{ providerId, agent: 'codex' }]);
    },
  );

  it('does not reactivate a resolved overlay after a custom provider is deleted and recreated', () => {
    const providerId = 'recreated-user';
    const provider = buildUserProvider({
      id: providerId,
      name: 'Recreated User',
      runtimes: {
        codex: {
          baseUrl: 'https://runtime.example/v1',
          models: [{ id: 'vendor/model', name: 'Provider Model' }],
        },
      },
    });
    setCustomProviders([provider]);
    const liveModel = getActiveCatalog().providers.find((entry) => entry.id === providerId)!
      .models.codex![0]!;
    setResolvedProviderModels(
      providerId,
      'codex',
      [liveModel.id],
      [{ ...liveModel, contextWindow: 1_000_000, source: 'resolved' }],
      'recreated-r1',
      [liveModel.id],
    );

    setCustomProviders([]);
    setCustomProviders([provider]);

    const recreated = getActiveCatalog().providers.find((entry) => entry.id === providerId)!
      .models.codex![0]!;
    expect(recreated.contextWindow).toBe(200_000);
    expect(recreated).not.toHaveProperty('source');
  });

  it('drops discovery and resolve snapshots when a custom provider reuses its id for a new realm', () => {
    const providerId = 'realm-reused-user';
    const buildProvider = (baseUrl: string) => buildUserProvider({
      id: providerId,
      name: 'Realm Reused User',
      runtimes: {
        codex: {
          baseUrl,
          models: [{ id: 'vendor/static', name: 'Static Model' }],
        },
      },
    });
    setCustomProviders([buildProvider('https://owner-a.example/v1')]);
    setDiscoveredProviderModels(providerId, 'codex', [
      {
        id: 'vendor/private-a',
        name: 'Private A',
        contextWindow: 200_000,
        efforts: [],
        defaultEffort: null,
      },
    ]);
    const ownerAIds = getActiveCatalog().providers.find((provider) => provider.id === providerId)!
      .models.codex!.map((model) => model.id);
    setResolvedProviderModels(
      providerId,
      'codex',
      ['vendor/static'],
      [{
        id: 'vendor/static',
        name: 'Resolved A',
        contextWindow: 1_000_000,
        efforts: [],
        defaultEffort: null,
      }],
      'owner-a-revision',
      ownerAIds,
    );
    expect(ownerAIds).toContain('vendor/private-a');

    setCustomProviders([buildProvider('https://owner-b.example/v1')]);

    const ownerBModels = getActiveCatalog().providers.find((provider) => provider.id === providerId)!
      .models.codex!;
    expect(ownerBModels.map((model) => model.id)).toEqual(['vendor/static']);
    expect(ownerBModels[0]).toMatchObject({ name: 'Static Model', contextWindow: 200_000 });
    expect(ownerBModels[0]).not.toHaveProperty('source');
  });

  it('drops base-provider discovery and resolve snapshots when its credential realm changes', () => {
    const providerId = 'remote-realm-provider';
    const catalogFor = (upstream: string) => ({
      version: '3',
      providers: [{
        id: providerId,
        name: 'Remote Realm Provider',
        source: 'builtin' as const,
        agents: ['codex' as const],
        auth: {
          method: 'oauth' as const,
          oauth: {
            authorizeUrl: 'https://auth.example/authorize',
            tokenUrl: 'https://auth.example/token',
            clientId: 'remote-client',
            scopes: 'models.read',
          },
        },
        routing: { codex: { upstream, authStrategy: 'oauth-token' as const } },
        models: {
          codex: [{
            id: 'vendor/static',
            name: 'Static Model',
            contextWindow: 200_000,
            efforts: [],
            defaultEffort: null,
          }],
        },
      }],
    });
    setActiveCatalog(catalogFor('https://owner-a.example/v1'));
    setDiscoveredProviderModels(providerId, 'codex', [
      {
        id: 'vendor/private-a',
        name: 'Private A',
        contextWindow: 200_000,
        efforts: [],
        defaultEffort: null,
      },
    ]);
    const ownerAIds = getActiveCatalog().providers.find((provider) => provider.id === providerId)!
      .models.codex!.map((model) => model.id);
    setResolvedProviderModels(
      providerId,
      'codex',
      ['vendor/static'],
      [{
        id: 'vendor/static',
        name: 'Resolved A',
        contextWindow: 1_000_000,
        efforts: [],
        defaultEffort: null,
      }],
      'owner-a-revision',
      ownerAIds,
    );

    setActiveCatalog(catalogFor('https://owner-b.example/v1'));

    const ownerBModels = getActiveCatalog().providers.find((provider) => provider.id === providerId)!
      .models.codex!;
    expect(ownerBModels.map((model) => model.id)).toEqual(['vendor/static']);
    expect(ownerBModels[0]).toMatchObject({ name: 'Static Model', contextWindow: 200_000 });
    expect(ownerBModels[0]).not.toHaveProperty('source');
  });

  it('clears every account-derived discovery and resolve snapshot at an account boundary', () => {
    setDiscoveredCodexModels([
      {
        id: 'openai/account-a-only',
        name: 'OpenAI Account A Only',
        contextWindow: 200_000,
        efforts: [],
        defaultEffort: null,
      },
    ]);
    setAnthropicDiscoveredModels([
      {
        id: 'anthropic/account-a-only',
        name: 'Anthropic Account A Only',
        contextWindow: 200_000,
        efforts: [],
        defaultEffort: null,
      },
    ]);
    setDiscoveredProviderModels('xai', 'codex', [
      {
        id: 'xai/account-a-only',
        name: 'Account A Only',
        contextWindow: 200_000,
        efforts: [],
        defaultEffort: null,
      },
    ]);
    const accountAIds = getActiveCatalog().providers.find((provider) => provider.id === 'xai')!
      .models.codex!.map((model) => model.id);
    setResolvedProviderModels(
      'xai',
      'codex',
      ['xai/account-a-only'],
      [{
        id: 'xai/account-a-only',
        name: 'Resolved Account A',
        contextWindow: 1_000_000,
        efforts: [],
        defaultEffort: null,
      }],
      'account-a-revision',
      accountAIds,
    );

    clearAccountDerivedProviderModels();

    const catalog = getActiveCatalog();
    expect(catalog.providers.find((provider) => provider.id === 'openai')!
      .models.codex!.some((model) => model.id === 'openai/account-a-only')).toBe(false);
    expect(catalog.providers.find((provider) => provider.id === 'anthropic')!
      .models['claude-code']!.some((model) => model.id === 'anthropic/account-a-only')).toBe(false);
    expect(catalog.providers.find((provider) => provider.id === 'xai')!
      .models.codex!.some((model) => model.id === 'xai/account-a-only')).toBe(false);
  });

  it('clears a changed Pi overlay without forwarding a nonexistent resolve slot', () => {
    const providerId = 'pi-runtime-user';
    const invalidateApplySlots = vi.fn();
    setModelResolveApplySlotsInvalidator(invalidateApplySlots);
    const runtime = {
      baseUrl: 'https://old-pi-runtime.example/v1',
      models: [{ id: 'vendor/pi-model', name: 'Pi Model' }],
    };
    setCustomProviders([buildUserProvider({
      id: providerId,
      name: 'Pi Runtime User',
      runtimes: { pi: runtime },
    })]);
    const liveModel = getActiveCatalog().providers.find((provider) => provider.id === providerId)!
      .models.pi![0]!;
    setResolvedProviderModels(
      providerId,
      'pi',
      [liveModel.id],
      [{ ...liveModel, contextWindow: 1_000_000, source: 'resolved' }],
      'pi-runtime-r1',
      [liveModel.id],
    );
    invalidateApplySlots.mockClear();

    setCustomProviders([buildUserProvider({
      id: providerId,
      name: 'Pi Runtime User',
      runtimes: { pi: { ...runtime, baseUrl: 'https://new-pi-runtime.example/v1' } },
    })]);

    const changed = getActiveCatalog().providers.find((provider) => provider.id === providerId)!
      .models.pi![0]!;
    expect(changed.contextWindow).toBe(200_000);
    expect(changed).not.toHaveProperty('source');
    expect(invalidateApplySlots).not.toHaveBeenCalled();
  });

  it('clears resolved metadata without changing live discovery membership', () => {
    const discovery = [{
      id: 'xai/account-bound',
      name: 'Discovery Name',
      contextWindow: 200_000,
      efforts: [],
      defaultEffort: null,
    }];
    setDiscoveredProviderModels('xai', 'codex', discovery);
    const allIds = getActiveCatalog().providers.find((provider) => provider.id === 'xai')!
      .models.codex!.map((model) => model.id);
    setResolvedProviderModels(
      'xai',
      'codex',
      discovery.map((model) => model.id),
      [{ ...discovery[0], name: 'Resolved Name', category: 'grok' }],
      'account-a-revision',
      allIds,
    );
    expect(
      getActiveCatalog().providers.find((provider) => provider.id === 'xai')!
        .models.codex!.find((model) => model.id === 'xai/account-bound'),
    ).toMatchObject({ name: 'Resolved Name', source: 'resolved' });

    clearResolvedProviderModels();

    const afterClear = getActiveCatalog().providers.find((provider) => provider.id === 'xai')!
      .models.codex!;
    expect(afterClear.map((model) => model.id)).toEqual(allIds);
    expect(afterClear.find((model) => model.id === 'xai/account-bound')).toMatchObject({
      name: 'Discovery Name',
    });
    expect(afterClear.find((model) => model.id === 'xai/account-bound')).not.toHaveProperty('source');
  });

  it('refreshes one provider model snapshot without replacing live routing or other providers', () => {
    // registry-free 克隆:本用例只验「换模型快照不换路由」机制,隔离 registry 实体化层。
    const current = structuredClone(BUNDLED_CATALOG);
    delete (current as { modelRegistry?: unknown }).modelRegistry;
    const incoming = structuredClone(current);
    const currentXai = current.providers.find((provider) => provider.id === 'xai');
    const incomingXai = incoming.providers.find((provider) => provider.id === 'xai');
    const currentOpenAi = current.providers.find((provider) => provider.id === 'openai');
    const incomingOpenAi = incoming.providers.find((provider) => provider.id === 'openai');
    if (!currentXai || !incomingXai || !currentOpenAi || !incomingOpenAi) {
      throw new Error('expected bundled xai/openai providers');
    }
    currentXai.routing.codex = {
      ...currentXai.routing.codex!,
      upstream: 'https://current-routing.example.com/v1',
    };
    incomingXai.routing.codex = {
      ...incomingXai.routing.codex!,
      upstream: 'https://incoming-routing.example.com/v1',
    };
    incomingXai.models.codex = [
      {
        id: 'xai/new-model',
        name: 'New xAI Model',
        contextWindow: 256_000,
        efforts: ['high'],
        defaultEffort: 'high',
      },
    ];
    incomingOpenAi.models.codex = [
      {
        id: 'should-not-replace-openai',
        name: 'Should Not Replace OpenAI',
        contextWindow: 1,
        efforts: [],
        defaultEffort: null,
      },
    ];

    setActiveCatalog(current);
    commitModelPlaneFromCatalog(incoming);

    const active = getActiveCatalog();
    expect(active.providers.find((provider) => provider.id === 'xai')?.models.codex).toEqual(
      incomingXai.models.codex,
    );
    expect(active.providers.find((provider) => provider.id === 'xai')?.routing.codex).toEqual(
      currentXai.routing.codex,
    );
    expect(active.providers.find((provider) => provider.id === 'openai')?.models.codex).toEqual(
      currentOpenAi.models.codex,
    );
  });
});
