import { afterEach, describe, expect, it } from 'vitest';
import { BUNDLED_CATALOG, type Catalog, type CatalogModel, type Provider } from '@cindy/model-providers';
import { getActiveCatalog, setActiveCatalog, setCustomProviders, setLocalCatalogOverrides } from '../active-catalog.js';
import { EMPTY_MODEL_CATALOG_OVERRIDES } from '../model-plane/localCatalogOverrides.js';

const current = 'deepseek-flash';
const old = 'deepseek-v4-flash';
function provider(): Provider {
  const model = (id: string): CatalogModel => ({ id, name: id,
    contextWindow: id === old ? 1_000_000 : 1_048_576,
    maxOutput: id === old ? 384_000 : 393_216,
    efforts: ['low', 'high', 'max'], defaultEffort: 'high',
    modalities: { input: ['text'], output: ['text'] },
    userModelConfig: { id, name: id, discoveredMetadata: {} },
  });
  return { id: 'test-ds', name: 'DS', source: 'user', auth: { method: 'apiKey' },
    agents: ['codex'], routing: { codex: { upstream: 'https://api.deepseek.com', wireProtocol: 'openai-chat', authStrategy: 'api-key-header' } },
    models: { codex: [model(current), model(old)] } };
}
function setup() {
  setLocalCatalogOverrides(EMPTY_MODEL_CATALOG_OVERRIDES);
  setActiveCatalog({ ...BUNDLED_CATALOG, providers: [], modelRegistry: {
    schemaVersion: 5, updatedAt: '2026-11-04T00:00:00Z', models: [],
    baseModels: [{ id: 'deepseek/deepseek-v4.1-flash', aliases: [current, old], defaults: {} }],
  } } as Catalog);
  setCustomProviders([provider()]);
}
afterEach(() => { setCustomProviders([]); setLocalCatalogOverrides(EMPTY_MODEL_CATALOG_OVERRIDES); setActiveCatalog(BUNDLED_CATALOG); });
const actual = () => getActiveCatalog().providers.find((p) => p.id === 'test-ds')!;

describe('active catalog verified aliases and user metadata', () => {
  it('projects the real raw IDs without deleting members or changing their original windows', () => {
    setup();
    expect(actual().models.codex!.map((m) => m.selectionAliasKey)).toEqual([current, current]);
    expect(actual().models.codex!.map((m) => m.id)).toEqual([current, old]);
    expect(actual().models.codex!.map((m) => m.contextWindow)).toEqual([1_048_576, 1_000_000]);
    expect(actual().models.codex!.every((m) => m.supportsImageInput && m.maxOutput === 393_216)).toBe(true);
  });
  it.each(['public', 'member', 'agent'] as const)('retains %s user overrides rather than correcting or merging them away', (kind) => {
    setup();
    setLocalCatalogOverrides({ version: 1, additions: {}, patches: kind === 'member'
      ? { [`test-ds:${old}`]: { base: { contextWindow: 200_000, supportsImageInput: false } } }
      : kind === 'agent' ? { [`test-ds:${old}`]: { perAgent: { codex: { contextWindow: 200_000, supportsImageInput: false } } } } : {},
      ...(kind === 'public' ? { baseModels: { 'deepseek/deepseek-v4.1-flash': { contextWindow: 200_000, supportsImageInput: false } } } : {}),
    });
    const legacy = actual().models.codex!.find((m) => m.id === old)!;
    expect(legacy.contextWindow).toBe(200_000);
    expect(legacy.supportsImageInput).not.toBe(true);
    expect(actual().models.codex!.every((m) => !m.selectionAliasKey)).toBe(true);
  });
});
