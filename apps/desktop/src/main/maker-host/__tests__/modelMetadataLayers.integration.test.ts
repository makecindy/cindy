import { afterEach, describe, expect, it } from 'vitest';
import {
  BUNDLED_CATALOG,
  buildUserProvider,
  type Catalog,
  type ModelRegistry,
} from '@cindy/model-providers';
import {
  getActiveCatalog,
  setActiveCatalog,
  setCustomProviders,
  setLocalCatalogOverrides,
  setXdGatewayModels,
} from '../active-catalog.js';
import {
  EMPTY_MODEL_CATALOG_OVERRIDES,
  sanitizeModelCatalogOverrides,
} from '../model-plane/localCatalogOverrides.js';

function registry(): ModelRegistry {
  return {
    schemaVersion: 4,
    updatedAt: '2026-09-08T07:00:00.000Z',
    baseModels: [
      {
        id: 'maker/model',
        aliases: ['model'],
        defaults: {
          name: 'Public',
          contextWindow: 1000,
          efforts: ['low', 'high'],
          defaultEffort: 'low',
        },
      },
    ],
    models: [
      {
        id: 'saved',
        name: 'Public',
        modelRef: 'maker/model',
        routes: [
          {
            providerId: 'xd',
            modelId: 'model',
            agents: ['claude-code', 'codex'],
            defaults: { contextWindow: 2000 },
            forceOverrides: { maxOutputTokens: 50 },
            overrideReason: 'Verified output limit',
          },
          {
            providerId: 'relay',
            modelId: 'model',
            agents: ['codex'],
            forceOverrides: { contextWindow: 4000, supportsImageInput: true },
            overrideReason: 'Verified supplier capability correction',
          },
        ],
      },
    ],
  };
}
function model(provider: string, agent: 'codex' | 'pi' = 'codex') {
  return getActiveCatalog().providers.find((p) => p.id === provider)?.models[agent]?.[0];
}
afterEach(() => {
  setCustomProviders([]);
  setXdGatewayModels([]);
  setLocalCatalogOverrides(EMPTY_MODEL_CATALOG_OVERRIDES);
  setActiveCatalog(BUNDLED_CATALOG);
});
describe('metadata layers through the active catalog', () => {
  it('merges sparse Gateway facts, server force and user patches without inventing membership', () => {
    setActiveCatalog({ ...BUNDLED_CATALOG, modelRegistry: registry() });
    setXdGatewayModels([
      {
        id: 'model',
        name: 'Supplier',
        contextWindow: 3000,
        efforts: ['low', 'high'],
        agents: ['codex'],
      },
    ]);
    expect(model('xd')).toMatchObject({
      name: 'Supplier',
      contextWindow: 3000,
      maxOutput: 50,
      defaultEffort: 'low',
    });
    setLocalCatalogOverrides(
      sanitizeModelCatalogOverrides({
        version: 1,
        baseModels: { 'maker/model': { name: 'My shared name', maxOutputTokens: 60 } },
        patches: {
          'xd:model': {
            base: {
              contextWindow: 5000,
              maxOutput: 70,
              defaultEffort: null,
              supportsImageInput: false,
            },
          },
          'xd:missing': { base: { name: 'Must stay absent' } },
        },
      }).overrides,
    );
    expect(model('xd')).toMatchObject({
      name: 'My shared name',
      contextWindow: 5000,
      maxOutput: 70,
      defaultEffort: null,
      supportsImageInput: false,
    });
    setXdGatewayModels([
      {
        id: 'model',
        name: 'New supplier name',
        contextWindow: 3500,
        efforts: ['low', 'high'],
        defaultEffort: 'high',
        agents: ['codex'],
      },
    ]);
    expect(model('xd')).toMatchObject({
      name: 'My shared name',
      contextWindow: 5000,
      defaultEffort: null,
    });
    expect(getActiveCatalog().providers.find((p) => p.id === 'xd')?.models.codex).toHaveLength(1);
  });
  it('keeps explicit custom Pi values above force and inherits public metadata for an unknown supplier', () => {
    const r = registry();
    setActiveCatalog({ ...BUNDLED_CATALOG, modelRegistry: r });
    const config = {
      id: 'relay',
      name: 'Relay',
      runtimes: {
        pi: {
          baseUrl: 'https://relay.example/v1',
          models: [
            {
              id: 'model',
              name: 'My model',
              nameExplicit: true,
              contextWindow: 6000,
              supportsImageInput: false,
              discoveredMetadata: { name: 'Supplier', contextWindow: 3000 },
            },
          ],
        },
      },
    };
    setCustomProviders([buildUserProvider(config, { modelRegistry: r })]);
    expect(model('relay', 'pi')).toMatchObject({
      name: 'My model',
      contextWindow: 6000,
      supportsImageInput: false,
    });
    const unknown = buildUserProvider(
      {
        ...config,
        id: 'new-supplier',
        runtimes: {
          pi: {
            ...config.runtimes.pi,
            models: [{ id: 'model', name: 'model', discoveredMetadata: {} }],
          },
        },
      },
      { modelRegistry: r },
    );
    expect(unknown.models.pi?.[0]).toMatchObject({
      name: 'Public',
      contextWindow: 1000,
      defaultEffort: 'low',
    });
    expect(unknown.models.pi?.[0].supportsImageInput).toBeUndefined();
    expect(unknown.routing.pi?.upstream).toBe('https://relay.example/v1');
  });
  it('overlays local recommendations after a remote refresh, supports empty recommendations and ignores malformed variants', () => {
    const catalog = structuredClone(BUNDLED_CATALOG) as Catalog;
    const id = catalog.modelRegistry!.localModels!.models[0].id;
    setActiveCatalog(catalog);
    setLocalCatalogOverrides(
      sanitizeModelCatalogOverrides({
        version: 1,
        localModels: { featuredIds: [], patches: { [id]: { name: 'My local choice' } } },
      }).overrides,
    );
    expect(getActiveCatalog().modelRegistry?.localModels).toMatchObject({
      featuredIds: [],
      models: [
        expect.objectContaining({ id, name: 'My local choice' }),
        ...catalog.modelRegistry!.localModels!.models.slice(1),
      ],
    });
    catalog.modelRegistry!.localModels!.models[0].name = 'Remote rename';
    setActiveCatalog(catalog);
    expect(getActiveCatalog().modelRegistry?.localModels?.models[0].name).toBe('My local choice');
    setLocalCatalogOverrides(
      sanitizeModelCatalogOverrides({
        localModels: {
          additions: [null, 42, {}],
          patches: { [id]: { variants: [{ libraryName: 'cloud:latest' }] } },
        },
      }).overrides,
    );
    expect(getActiveCatalog().modelRegistry?.localModels?.models[0].variants).toEqual(
      catalog.modelRegistry!.localModels!.models[0].variants,
    );
  });
});
