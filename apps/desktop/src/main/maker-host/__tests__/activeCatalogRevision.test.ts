import { afterEach, describe, expect, it, vi } from 'vitest';

import { BUNDLED_CATALOG } from '@cindy/model-providers';

import {
  commitModelPlaneFromCatalog,
  getActiveCatalog,
  getActiveCatalogRevision,
  setActiveCatalog,
  setActiveCatalogChangedListener,
  setAnthropicDiscoveredModels,
  setCustomProviderConfigs,
  setDiscoveredCodexModels,
  setXaiDiscoveredModels,
} from '../active-catalog.js';

describe('active catalog revision', () => {
  afterEach(() => {
    setActiveCatalogChangedListener(null);
    setActiveCatalog(BUNDLED_CATALOG);
    setAnthropicDiscoveredModels([]);
    setDiscoveredCodexModels([]);
    setXaiDiscoveredModels(null);
    setCustomProviderConfigs([]);
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

  it('keeps legacy custom xai isolated across catalog refresh and owner config reload', () => {
    setCustomProviderConfigs([
      {
        id: 'xai',
        name: 'Private xAI-compatible endpoint',
        runtimes: {
          codex: {
            baseUrl: 'https://private-xai.example/v1',
            models: [{ id: 'private-grok', name: 'Private Grok' }],
          },
        },
      },
    ]);
    setActiveCatalog(structuredClone(BUNDLED_CATALOG));

    const active = getActiveCatalog();
    expect(active.providers.find((provider) => provider.id === 'xai')?.source).toBe('builtin');
    expect(active.providers.find((provider) => provider.id === 'custom:xai')).toMatchObject({
      source: 'user',
      routing: { codex: { upstream: 'https://private-xai.example/v1' } },
    });

    setCustomProviderConfigs([]);
    expect(getActiveCatalog().providers.some((provider) => provider.id === 'custom:xai')).toBe(
      false,
    );
    expect(getActiveCatalog().providers.some((provider) => provider.id === 'xai')).toBe(true);
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

  it('refreshes xAI catalog metadata and routing without replacing other providers', () => {
    // registry-free 克隆：server Catalog 可更新 xAI routing/metadata；账号快照只在
    // computeMerged 阶段决定 membership。这里隔离 registry 实体化层，只验证 provider
    // plane 更新不会连带替换其他 provider。
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
      incomingXai.routing.codex,
    );
    expect(active.providers.find((provider) => provider.id === 'openai')?.models.codex).toEqual(
      currentOpenAi.models.codex,
    );
  });
});
