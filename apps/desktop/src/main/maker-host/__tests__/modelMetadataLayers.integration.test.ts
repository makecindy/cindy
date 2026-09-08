import { afterEach, describe, expect, it } from 'vitest';

it('isolates excess additions and duplicate tags without discarding valid local overrides', () => {
  const model = (n: number) => ({
    id: 'local-' + n,
    name: 'Local ' + n,
    aliases: [],
    variants: [
      { libraryName: 'local-' + n + ':latest', sizeBytes: 2 ** 30, minUnifiedMemoryGb: 4 },
    ],
  });
  const base = { version: 1 as const, models: [model(0), model(1)], featuredIds: ['local-0'] };
  const result = applyLocalModelCatalogOverrides(base, {
    removedIds: ['local-1'],
    patches: { 'local-0': { name: 'Kept patch' } },
    additions: [
      { ...model(99), variants: model(0).variants },
      ...Array.from({ length: 33 }, (_, n) => model(n + 2)),
      { ...model(2), name: 'Replacement at capacity' },
    ],
    featuredIds: [],
  })!;
  expect(result.models).toHaveLength(32);
  expect(result.models.find((m) => m.id === 'local-0')?.name).toBe('Kept patch');
  expect(result.models.find((m) => m.id === 'local-2')?.name).toBe('Replacement at capacity');
  expect(result.models.some((m) => m.id === 'local-1' || m.id === 'local-99')).toBe(false);
  expect(result.featuredIds).toEqual([]);
  const invalidFeatured = applyLocalModelCatalogOverrides(result, {
    patches: { 'local-0': { variants: model(2).variants }, 'local-3': { name: 'Still valid' } },
    featuredIds: ['local-0', 'local-0'],
  })!;
  expect(invalidFeatured.models.find((m) => m.id === 'local-0')?.variants).toEqual(
    model(0).variants,
  );
  expect(invalidFeatured.models.find((m) => m.id === 'local-3')?.name).toBe('Still valid');
});

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
  applyLocalModelCatalogOverrides,
  applyExistingModelLocalPatch,
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
  it('separates escaped supplier IDs from colon-containing model IDs', () => {
    const { overrides, invalid } = sanitizeModelCatalogOverrides({
      version: 1,
      patches: {
        'custom%3Axai:grok:model': { base: { name: 'Migrated', contextWindow: 8000 } },
        'xai:grok:model': { base: { name: 'Built in' } },
        'custom:xai:grok:model': { base: { name: 'Other supplier' } },
        'custom%ZZ:grok:model': { base: { name: 'Malformed' } },
      },
    });
    expect(invalid).toEqual(['patches:custom%ZZ:grok:model']);
    const base = buildUserProvider({
      id: 'relay',
      name: 'Relay',
      runtimes: {
        pi: {
          baseUrl: 'https://relay.example/v1',
          models: [{ id: 'grok:model', name: 'Original' }],
        },
      },
    }).models.pi![0];
    for (const agent of ['pi', 'codex', 'claude-code'] as const) {
      expect(applyExistingModelLocalPatch('custom:xai', agent, base, overrides).name).toBe(
        'Migrated',
      );
      expect(applyExistingModelLocalPatch('xai', agent, base, overrides).name).toBe('Built in');
      expect(
        applyExistingModelLocalPatch('custom', agent, { ...base, id: 'xai:grok:model' }, overrides)
          .name,
      ).toBe('Other supplier');
    }
  });

  it('projects every public user field onto local variants and adapts the final default', () => {
    const r = registry();
    r.localModels = {
      version: 1,
      models: [
        {
          id: 'local',
          modelRef: 'maker/model',
          name: 'Local',
          aliases: [],
          variants: [{ libraryName: 'local:quant', sizeBytes: 2 ** 30, minUnifiedMemoryGb: 4 }],
        },
      ],
      featuredIds: [],
    };
    setActiveCatalog({ ...BUNDLED_CATALOG, modelRegistry: r });
    const runtime = {
      baseUrl: 'http://127.0.0.1:11434/v1',
      models: [
        {
          id: 'local:quant',
          name: 'Imported',
          contextWindow: 2000,
          reasoning: true,
          reasoningEfforts: ['low', 'high'] as const,
          reasoningDefaultEffort: 'high' as const,
        },
      ],
    };
    setCustomProviders(
      ['cindy-local-ollama', 'relay'].map((id) =>
        buildUserProvider(
          {
            id,
            name: id,
            runtimes: {
              pi: {
                ...runtime,
                models: runtime.models.map((m) => ({
                  ...m,
                  reasoningEfforts: [...m.reasoningEfforts],
                })),
              },
              codex: {
                ...runtime,
                models: runtime.models.map((m) => ({
                  ...m,
                  reasoningEfforts: [...m.reasoningEfforts],
                })),
              },
            },
          },
          { modelRegistry: r },
        ),
      ),
    );
    const original = model('cindy-local-ollama', 'pi');
    const apply = (specific = false, clear = false) =>
      setLocalCatalogOverrides(
        sanitizeModelCatalogOverrides({
          version: 1,
          baseModels: {
            'maker/model': {
              name: 'User local',
              description: 'User description',
              group: 'User group',
              contextWindow: 9000,
              maxOutputTokens: 80,
              supportsImageInput: true,
              supportsFastMode: true,
              efforts: ['low'],
              ...(clear ? { defaultEffort: null } : {}),
            },
          },
          ...(specific
            ? {
                patches: {
                  'cindy-local-ollama:local:quant': {
                    base: { contextWindow: 12000, supportsImageInput: false },
                  },
                },
              }
            : {}),
        }).overrides,
      );
    apply();
    for (const agent of ['pi', 'codex'] as const) {
      expect(model('cindy-local-ollama', agent)).toMatchObject({
        name: 'User local',
        description: 'User description',
        group: 'User group',
        contextWindow: 9000,
        maxOutput: 80,
        supportsImageInput: true,
        supportsFastMode: true,
        efforts: ['low'],
        defaultEffort: 'low',
      });
      expect(model('relay', agent)).toMatchObject({
        name: 'Imported',
        contextWindow: 2000,
        defaultEffort: 'high',
      });
    }
    apply(true, true);
    expect(model('cindy-local-ollama', 'pi')).toMatchObject({
      contextWindow: 12000,
      supportsImageInput: false,
      efforts: ['low'],
      defaultEffort: null,
    });
    expect(getActiveCatalog().modelRegistry?.localModels?.featuredIds).toEqual([]);
    expect(getActiveCatalog().modelRegistry?.localModels?.models).toHaveLength(1);
    setLocalCatalogOverrides(EMPTY_MODEL_CATALOG_OVERRIDES);
    expect(model('cindy-local-ollama', 'pi')).toEqual(original);
  });
  it.each([200, 201, 256, 257])(
    'aligns public override keys with the %i-character registry identity',
    (length) => {
      const r = registry();
      const id = 'm'.repeat(length);
      r.baseModels![0].id = id;
      r.models[0].modelRef = id;
      setActiveCatalog({ ...BUNDLED_CATALOG, modelRegistry: r });
      setXdGatewayModels([
        { id: 'model', name: 'Supplier', contextWindow: 3000, agents: ['codex'] },
      ]);
      const { overrides } = sanitizeModelCatalogOverrides({
        version: 1,
        baseModels: { [id]: { name: 'User name' } },
      });
      expect(overrides.baseModels?.[id]).toEqual(length <= 256 ? { name: 'User name' } : undefined);
      if (length <= 256) {
        setLocalCatalogOverrides(overrides);
        expect(model('xd')?.name).toBe('User name');
      }
    },
  );
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
              reasoning: true,
              reasoningEfforts: ['high' as const],
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
    setLocalCatalogOverrides(
      sanitizeModelCatalogOverrides({
        version: 1,
        baseModels: {
          'maker/model': {
            name: 'Shared rename',
            contextWindow: 9000,
            supportsImageInput: true,
            maxOutputTokens: 80,
            efforts: ['low'],
          },
        },
      }).overrides,
    );
    expect(model('relay', 'pi')).toMatchObject({
      name: 'My model',
      contextWindow: 6000,
      supportsImageInput: false,
      maxOutput: 80,
      efforts: ['high'],
      defaultEffort: 'high',
    });
    // Clearing specific user choices makes the shared patch visible again.
    setCustomProviders([
      buildUserProvider(
        {
          ...config,
          runtimes: {
            pi: {
              ...config.runtimes.pi,
              models: [
                {
                  id: 'model',
                  name: 'Supplier',
                  discoveredMetadata: { name: 'Supplier' },
                },
              ],
            },
          },
        },
        { modelRegistry: r },
      ),
    ]);
    expect(model('relay', 'pi')).toMatchObject({
      name: 'Shared rename',
      contextWindow: 9000,
      supportsImageInput: true,
      maxOutput: 80,
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
