import { afterEach, describe, expect, it } from 'vitest';
import { BUNDLED_CATALOG, type CatalogModel } from '@cindy/model-providers';
import {
  getActiveCatalog,
  setActiveCatalog,
  setDiscoveredCodexModels,
  setLocalCatalogOverrides,
} from '../active-catalog.js';
import { deriveAvailableModels, resolvePiRuntimeModelDescriptor } from '../catalog-to-descriptors.js';
import { EMPTY_MODEL_CATALOG_OVERRIDES, sanitizeModelCatalogOverrides } from '../model-plane/localCatalogOverrides.js';

afterEach(() => {
  setDiscoveredCodexModels([]);
  setLocalCatalogOverrides(EMPTY_MODEL_CATALOG_OVERRIDES);
  setActiveCatalog(BUNDLED_CATALOG);
});

const standard = ['low', 'medium', 'high', 'xhigh', 'max'];

function openAiModels() {
  return getActiveCatalog().providers.find(provider => provider.id === 'openai')!.models;
}

describe('model effort inheritance through the execution catalog', () => {
  it('uses shared defaults online and offline without publishing Pi aliases as extra tiers', () => {
    for (const source of ['offline', 'legacy-server'] as const) {
      const catalog = structuredClone(BUNDLED_CATALOG);
      if (source === 'legacy-server') {
        // Shape of the public Pi declaration: old defaults, no capability evidence.
        catalog.providers.find(p => p.id === 'openai')!.models.pi = [{
          id: 'chatgpt/gpt-5.6-sol', name: 'Sol', contextWindow: 272_000,
          efforts: ['minimal', 'xhigh', 'max'], defaultEffort: 'xhigh',
        }];
      }
      setActiveCatalog(catalog);
      const models = openAiModels();
      for (const agent of ['claude-code', 'codex', 'pi'] as const) {
        const model = models[agent]!.find(m => m.id === (agent === 'codex' ? 'gpt-5.6-sol' : 'chatgpt/gpt-5.6-sol'))!;
        expect(model.defaultEffort, `${source}/${agent}`).toBe('medium');
        expect(model.efforts, `${source}/${agent}`).toEqual(agent === 'codex' ? [...standard, 'ultra'] : standard);
      }
    }
  });

  it('refreshes inherited Pi tiers and keeps catalog, public and runtime descriptors identical', () => {
    const catalog = structuredClone(BUNDLED_CATALOG);
    const base = catalog.modelRegistry!.baseModels!.find(m => m.id === 'openai/gpt-6-astra')!;
    base.defaults.efforts = ['low', 'high'];
    base.defaults.defaultEffort = 'low';
    setActiveCatalog(catalog);
    const id = 'chatgpt/gpt-6-astra';
    const expected = { efforts: ['low', 'high'], defaultEffort: 'low' };
    expect(openAiModels().pi!.find(m => m.id === id)).toMatchObject(expected);
    expect(deriveAvailableModels(getActiveCatalog(), 'pi').find(m => m.id === id)).toMatchObject(expected);
    expect(resolvePiRuntimeModelDescriptor(getActiveCatalog(), 'openai', id)).toMatchObject(expected);

    base.defaults.efforts = [];
    base.defaults.defaultEffort = null;
    setActiveCatalog(catalog);
    expect(resolvePiRuntimeModelDescriptor(getActiveCatalog(), 'openai', id))
      .toMatchObject({ efforts: [], defaultEffort: null });
  });

  it('keeps account restrictions and explicit user exceptions above shared defaults', () => {
    setActiveCatalog(BUNDLED_CATALOG);
    const discovered: CatalogModel = {
      id: 'gpt-6-astra', name: 'Astra', contextWindow: 272_000,
      efforts: ['high'], defaultEffort: 'high',
      discoveredMetadata: { efforts: ['high'], defaultEffort: 'high' },
    };
    setDiscoveredCodexModels([discovered]);
    expect(openAiModels().codex!.find(m => m.id === discovered.id))
      .toMatchObject({ efforts: ['high'], defaultEffort: 'high' });
    expect(openAiModels().pi!.find(m => m.id === `chatgpt/${discovered.id}`))
      .toMatchObject({ efforts: standard, defaultEffort: 'medium' });

    setLocalCatalogOverrides(sanitizeModelCatalogOverrides({ version: 1, patches: {
      'openai:chatgpt/gpt-6-astra': { perAgent: { pi: { efforts: ['low', 'max'], defaultEffort: 'max' } } },
    } }).overrides);
    expect(openAiModels().pi!.find(m => m.id === `chatgpt/${discovered.id}`))
      .toMatchObject({ efforts: ['low', 'max'], defaultEffort: 'max' });
  });

  it.each([true, false])('honors an explicit Pi protocol constraint (reasoning=%s)', reasoning => {
    const catalog = structuredClone(BUNDLED_CATALOG);
    catalog.providers.find(p => p.id === 'openai')!.models.pi = [{
      id: 'chatgpt/gpt-6-astra', name: 'Astra', contextWindow: 272_000,
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium',
      reasoning, ...(reasoning ? { reasoningEfforts: ['high'] } : {}),
    }];
    setActiveCatalog(catalog);
    expect(openAiModels().pi![0]).toMatchObject({
      efforts: reasoning ? ['high'] : [], defaultEffort: reasoning ? 'high' : null,
    });
  });

  it('preserves explicit Pi defaults below force and user overrides', () => {
    const catalog = structuredClone(BUNDLED_CATALOG);
    const id = 'chatgpt/gpt-6-astra';
    catalog.providers.find(p => p.id === 'openai')!.models.pi = [{
      id, name: 'Astra', contextWindow: 272_000,
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium',
      reasoning: true, reasoningEfforts: ['low', 'high'], reasoningDefaultEffort: 'high',
    }];
    const assertDefault = (defaultEffort: string | null) => {
      const active = getActiveCatalog();
      expect(openAiModels().pi!.find(m => m.id === id)?.defaultEffort).toBe(defaultEffort);
      expect(deriveAvailableModels(active, 'pi').find(m => m.id === id)?.defaultEffort).toBe(defaultEffort);
      expect(resolvePiRuntimeModelDescriptor(active, 'openai', id)?.defaultEffort).toBe(defaultEffort);
    };
    setActiveCatalog(catalog);
    assertDefault('high'); // Shared medium would otherwise clamp down to low.
    const route = catalog.modelRegistry!.models.flatMap(m => m.routes)
      .find(r => r.providerId === 'openai' && r.modelId === 'gpt-6-astra')!;
    route.forceOverrides = { defaultEffort: 'low' };
    route.overrideReason = 'Test verified route constraint';
    setActiveCatalog(catalog);
    assertDefault('low');
    setLocalCatalogOverrides(sanitizeModelCatalogOverrides({ version: 1, patches: {
      ['openai:' + id]: { perAgent: { pi: { defaultEffort: 'high' } } },
    } }).overrides);
    assertDefault('high');
    setLocalCatalogOverrides(EMPTY_MODEL_CATALOG_OVERRIDES);
    route.forceOverrides = { efforts: [] };
    setActiveCatalog(catalog);
    assertDefault(null);
  });

  it('inherits shared intent for newly discovered Pi members without copying Codex-only tiers', () => {
    const catalog = structuredClone(BUNDLED_CATALOG);
    catalog.providers.find(p => p.id === 'openai')!.models.pi = catalog.providers
      .find(p => p.id === 'openai')!.models.pi!.filter(m => m.id !== 'chatgpt/gpt-6-astra');
    setActiveCatalog(catalog);
    setDiscoveredCodexModels(['gpt-6-astra', 'unknown-future-model'].map(id => ({
      id, name: id, contextWindow: 272_000,
      efforts: ['low', 'high', 'max', 'ultra'], defaultEffort: 'ultra',
      discoveredMetadata: { efforts: ['low', 'high', 'max', 'ultra'], defaultEffort: 'ultra' },
    })));
    expect(openAiModels().pi!.find(m => m.id === 'chatgpt/gpt-6-astra'))
      .toMatchObject({ efforts: standard, defaultEffort: 'medium' });
    expect(openAiModels().pi!.find(m => m.id === 'chatgpt/unknown-future-model'))
      .toMatchObject({ efforts: ['low', 'high', 'max'], defaultEffort: 'max' });
  });
});
