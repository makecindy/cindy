import { afterEach, describe, expect, it } from 'vitest';
import {
  BUNDLED_CATALOG, buildUserProvider, mergeDiscoveredRuntimeModels, parseModelsListResponse,
  type AgentKind, type Catalog, type CustomProviderConfig,
} from '@cindy/model-providers';
import {
  getActiveCatalog, setActiveCatalog, setCustomProviderConfigs, setCustomProviders,
  setDiscoveredCodexModels, setLocalCatalogOverrides,
} from '../active-catalog.js';
import { invocationModelRecord } from '../pi-provider-transport.js';
import { resolveModelDefaultContextWindow } from '../catalog-to-descriptors.js';
import { EMPTY_MODEL_CATALOG_OVERRIDES } from '../model-plane/localCatalogOverrides.js';

const agents: AgentKind[] = ['claude-code', 'codex', 'pi'];
const discovery = (fields = {}) => mergeDiscoveredRuntimeModels([], parseModelsListResponse({ models: [{
  slug: 'gpt-6-astra', context_window: 1_024_000, max_context_window: 1_050_000, ...fields,
}] })!);
function config(models = discovery(), id = 'custom:sub2api'): CustomProviderConfig {
  return { id, name: id, runtimes: Object.fromEntries(agents.map(agent => [agent, {
    baseUrl: 'https://relay.example/v1', wireProtocol: 'openai-responses', models,
  }])) };
}
function row(agent: AgentKind, id = 'gpt-6-astra', provider = 'custom:sub2api') {
  return getActiveCatalog().providers.find(p => p.id === provider)!.models[agent]!.find(m => m.id === id)!;
}
afterEach(() => {
  setCustomProviders([]);
  setDiscoveredCodexModels([]);
  setLocalCatalogOverrides(EMPTY_MODEL_CATALOG_OVERRIDES);
  setActiveCatalog(BUNDLED_CATALOG);
});

describe('all OpenAI routes share the daily context default', () => {
  it('imports and refreshes Sub2API without turning capacity or the default into a user edit', () => {
    setActiveCatalog(BUNDLED_CATALOG);
    const original = config();
    setCustomProviderConfigs([original]);
    const check = () => {
      for (const agent of agents) {
        expect(row(agent)).toMatchObject({ contextWindow: 272_000, contextWindowMax: 1_050_000 });
        expect(resolveModelDefaultContextWindow(getActiveCatalog(), agent, 'custom:sub2api', 'gpt-6-astra')).toBe(272_000);
        expect(row(agent).userModelConfig?.contextWindow).toBeUndefined();
        expect(row(agent).discoveredMetadata?.contextWindow).toBe(1_024_000);
        expect(invocationModelRecord(row(agent), 'https://relay.example/v1', 'openai-responses')?.contextWindow).toBe(1_050_000);
      }
    };
    check();
    const saved = JSON.parse(JSON.stringify(original));
    for (const agent of agents) saved.runtimes[agent].models = mergeDiscoveredRuntimeModels(
      saved.runtimes[agent].models, parseModelsListResponse({ data: [{ id: 'gpt-6-astra' }] })!,
    );
    setCustomProviderConfigs([saved]);
    check();
    setActiveCatalog(structuredClone(BUNDLED_CATALOG), { capabilityEvidence: 'fallback' });
    check();
    expect(original.runtimes.codex!.models[0].discoveredMetadata?.contextWindow).toBe(1_024_000);
  });

  it.each(['user', 'organization', undefined] as const)('covers %s connections, public aliases and future OpenAI families', source => {
    setActiveCatalog(BUNDLED_CATALOG);
    const ids = ['gpt-6-astra', 'openai/gpt-6-astra', 'codex/gpt-7-astra', 'chatgpt/gpt-7-astra', 'o5', 'openai/o5-pro', 'codex-next'];
    const provider = buildUserProvider(config(mergeDiscoveredRuntimeModels([], parseModelsListResponse({ data: ids.map(id => ({
      id, context_window: 872_000,
    })) })!)));
    // Legacy catalogs may omit source; current providers require an explicit source.
    if (source === undefined) Reflect.deleteProperty(provider, 'source');
    else provider.source = source;
    setCustomProviders([provider]);
    for (const agent of agents) for (const id of ids) {
      expect(row(agent, id)).toMatchObject({ contextWindow: 272_000, contextWindowMax: 872_000 });
    }
  });

  it('covers third-party presets and exact Registry deployment identities', () => {
    const catalog = structuredClone(BUNDLED_CATALOG) as Catalog;
    catalog.modelRegistry!.models.push({
      id: 'relay/astra-deployment', name: 'Astra deployment', modelRef: 'openai/gpt-6-astra',
      routes: [{ providerId: 'custom:sub2api', modelId: 'deployment-astra', agents: ['claude-code', 'codex'] }],
    });
    setActiveCatalog(catalog);
    const models = parseModelsListResponse({ data: [{ id: 'deployment-astra' }] })!;
    setCustomProviderConfigs([config(models), {
      id: 'custom:router', name: 'Router',
      runtimes: Object.fromEntries(agents.map(agent => [agent, {
        catalogPresetId: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1', wireProtocol: 'openai-chat',
        models: mergeDiscoveredRuntimeModels([], parseModelsListResponse({ data: [{ id: 'openai/gpt-6-astra', context_length: 1_050_000 }] })!),
      }])),
    }]);
    for (const agent of agents) {
      expect(row(agent, 'deployment-astra')).toMatchObject({ contextWindow: 272_000, contextWindowMax: 1_050_000 });
      expect(row(agent, 'openai/gpt-6-astra', 'custom:router')).toMatchObject({ contextWindow: 272_000, contextWindowMax: 1_050_000 });
    }
  });

  it('keeps maximum-only manifests separate from the default', () => {
    setActiveCatalog(BUNDLED_CATALOG);
    setCustomProviderConfigs([config(discovery({ context_window: undefined, max_context_window: 872_000 }))]);
    for (const agent of agents) expect(row(agent)).toMatchObject({ contextWindow: 272_000, contextWindowMax: 872_000 });
  });

  it.each(['user', 'organization'] as const)('keeps known non-OpenAI identities ahead of GPT-like names on %s connections', source => {
    const catalog = structuredClone(BUNDLED_CATALOG) as Catalog;
    catalog.modelRegistry!.baseModels!.push({
      id: 'other/vendor-model', aliases: ['codex-other', 'o99'],
      defaults: { contextWindow: 1_000_000, contextWindowMax: 1_000_000 },
    });
    catalog.modelRegistry!.models.push({
      id: 'relay/other-deployment', name: 'Other vendor', modelRef: 'other/vendor-model',
      routes: [{ providerId: 'custom:sub2api', modelId: 'gpt-6-astra', agents: ['claude-code', 'codex'] }],
    });
    setActiveCatalog(catalog);
    const ids = ['gpt-6-astra', 'codex-other', 'o99'];
    const models = mergeDiscoveredRuntimeModels([], parseModelsListResponse({ data: ids.map(id => ({
      id, context_window: 1_000_000, max_context_window: 1_000_000,
    })) })!);
    const provider = buildUserProvider(config(models), { modelRegistry: catalog.modelRegistry });
    provider.source = source;
    setCustomProviders([provider]);
    for (const agent of agents) for (const id of ids) {
      expect(row(agent, id)).toMatchObject({ contextWindow: 1_000_000, contextWindowMax: 1_000_000 });
      expect(resolveModelDefaultContextWindow(getActiveCatalog(), agent, 'custom:sub2api', id)).toBe(1_000_000);
    }
  });

  it('preserves manual model windows and connection/engine patches, and restores the current default', () => {
    setActiveCatalog(BUNDLED_CATALOG);
    const models = discovery().map(model => ({ ...model, contextWindow: 800_000 }));
    setCustomProviderConfigs([config(models)]);
    for (const agent of agents) expect(row(agent).contextWindow).toBe(800_000);
    setCustomProviderConfigs([config()]);
    setLocalCatalogOverrides({ ...EMPTY_MODEL_CATALOG_OVERRIDES, patches: {
      'custom%3Asub2api:gpt-6-astra': { base: { contextWindow: 700_000 }, perAgent: { codex: { contextWindow: 900_000 } } },
    } });
    for (const agent of agents) expect(row(agent).contextWindow).toBe(agent === 'codex' ? 900_000 : 700_000);
    setLocalCatalogOverrides({ ...EMPTY_MODEL_CATALOG_OVERRIDES, patches: {
      'custom%3Asub2api:gpt-6-astra': { agents: ['codex'], base: { contextWindow: 800_000 } },
    } });
    for (const agent of agents) expect(row(agent).contextWindow).toBe(agent === 'codex' ? 800_000 : 272_000);
    setLocalCatalogOverrides(EMPTY_MODEL_CATALOG_OVERRIDES);
    for (const agent of agents) expect(row(agent)).toMatchObject({ contextWindow: 272_000, contextWindowMax: 1_050_000 });
  });

  it('preserves public overrides and local additions after subscription/bridge projection', () => {
    setActiveCatalog(BUNDLED_CATALOG);
    setCustomProviderConfigs([config()]);
    setLocalCatalogOverrides({ ...EMPTY_MODEL_CATALOG_OVERRIDES, baseModels: {
      'openai/gpt-6-astra': { contextWindow: 800_000 },
    } });
    for (const agent of agents) expect(row(agent).contextWindow).toBe(800_000);
    setLocalCatalogOverrides({ ...EMPTY_MODEL_CATALOG_OVERRIDES, additions: {
      'openai:gpt-7-astra': { agents: ['codex', 'claude-code', 'pi'], base: {
        name: 'GPT-7 Astra', contextWindow: 800_000, efforts: [], defaultEffort: null,
      } },
    } });
    const openai = getActiveCatalog().providers.find(p => p.id === 'openai')!;
    for (const agent of agents) expect(openai.models[agent]!.find(m => m.id ===
      (agent === 'codex' ? 'gpt-7-astra' : 'chatgpt/gpt-7-astra'))?.contextWindow).toBe(800_000);
  });

  it('preserves smaller OpenAI windows and leaves other vendors, private IDs and media alone', () => {
    setActiveCatalog(BUNDLED_CATALOG);
    const models = parseModelsListResponse({ data: [
      { id: 'gpt-6-astra', context_window: 128_000 },
      { id: 'claude-opus-5', context_window: 1_000_000 },
      { id: 'private/gpt-6-astra', context_window: 1_000_000 },
      { id: 'gpt-image-next', mode: 'image_generation', context_window: 1_000_000 },
    ] })!;
    const provider = buildUserProvider(config(models));
    // Exercise the projection's media guard even when an older catalog kept media in models.
    for (const agent of agents) provider.models[agent]!.push({
      id: 'gpt-image-next', name: 'Image', mode: 'image_generation', contextWindow: 1_000_000,
      efforts: [], defaultEffort: null,
    });
    setCustomProviders([provider]);
    for (const agent of agents) {
      expect(row(agent).contextWindow).toBe(128_000);
      for (const id of ['claude-opus-5', 'private/gpt-6-astra', 'gpt-image-next']) expect(row(agent, id).contextWindow).toBe(1_000_000);
    }
  });
});
