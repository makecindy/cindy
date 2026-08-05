import { afterEach, describe, expect, it, vi } from 'vitest';

import { BUNDLED_CATALOG } from '@cindy/model-providers';

import {
  getActiveCatalog,
  getActiveCatalogRevision,
  setActiveCatalog,
  setActiveCatalogChangedListener,
  setAnthropicDiscoveredModels,
  setDiscoveredCodexModels,
  setProviderModelsFromCatalog,
} from '../active-catalog.js';

describe('active catalog revision', () => {
  afterEach(() => {
    setActiveCatalogChangedListener(null);
    setActiveCatalog(BUNDLED_CATALOG);
    setAnthropicDiscoveredModels([]);
    setDiscoveredCodexModels([]);
  });

  it('invalidates the merged catalog before notifying one monotonic revision', () => {
    const start = getActiveCatalogRevision();
    const listener = vi.fn((revision: number) => ({
      revision,
      ids: getActiveCatalog().providers
        .find((provider) => provider.id === 'openai')
        ?.models.codex?.map((model) => model.id),
    }));
    setActiveCatalogChangedListener(listener);

    setDiscoveredCodexModels([{
      id: 'gpt-next-live',
      name: 'GPT Next Live',
      contextWindow: 300_000,
      efforts: ['high'],
      defaultEffort: 'high',
    }]);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.results[0]?.value).toMatchObject({ revision: start + 1 });
    expect(listener.mock.results[0]?.value.ids).toContain('gpt-next-live');
  });

  it('routes Anthropic discovery through the same revision listener', () => {
    const start = getActiveCatalogRevision();
    const listener = vi.fn((revision: number) => ({
      revision,
      ids: getActiveCatalog().providers
        .find((provider) => provider.id === 'anthropic')
        ?.models['claude-code']?.map((model) => model.id),
    }));
    setActiveCatalogChangedListener(listener);

    setAnthropicDiscoveredModels([{
      id: 'claude-opus-next',
      name: 'Claude Opus Next',
      contextWindow: 1_000_000,
      efforts: ['high'],
      defaultEffort: 'high',
    }]);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.results[0]?.value).toMatchObject({ revision: start + 1 });
    expect(listener.mock.results[0]?.value.ids).toContain('claude-opus-next');
  });

  it('refreshes one provider model snapshot without replacing live routing or other providers', () => {
    const current = structuredClone(BUNDLED_CATALOG);
    const incoming = structuredClone(BUNDLED_CATALOG);
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
    incomingXai.models.codex = [{
      id: 'xai/new-model',
      name: 'New xAI Model',
      contextWindow: 256_000,
      efforts: ['high'],
      defaultEffort: 'high',
    }];
    incomingOpenAi.models.codex = [{
      id: 'should-not-replace-openai',
      name: 'Should Not Replace OpenAI',
      contextWindow: 1,
      efforts: [],
      defaultEffort: null,
    }];

    setActiveCatalog(current);
    setProviderModelsFromCatalog('xai', incoming);

    const active = getActiveCatalog();
    expect(active.providers.find((provider) => provider.id === 'xai')?.models.codex)
      .toEqual(incomingXai.models.codex);
    expect(active.providers.find((provider) => provider.id === 'xai')?.routing.codex)
      .toEqual(currentXai.routing.codex);
    expect(active.providers.find((provider) => provider.id === 'openai')?.models.codex)
      .toEqual(currentOpenAi.models.codex);
  });
});
