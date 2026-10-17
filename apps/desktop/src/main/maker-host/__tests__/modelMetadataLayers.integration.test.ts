import { afterEach, describe, expect, it } from 'vitest';

import { deriveAvailableModels } from '../catalog-to-descriptors.js';
import { resolveSendToSessionExecutionConfig } from '../../maker-ipc/sendToSessionExecutionConfig.js';
import type { OrcaWorkerProviderRoutingContext } from '../../maker-ipc/orcaWorkerCreationService.js';

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
  isAgentSelectableModel,
  mergeDiscoveredRuntimeModels,
  parseModelsListResponse,
  type Catalog,
  type CustomProviderConfig,
  type ModelRegistry,
} from '@cindy/model-providers';
import { validateCustomProviderConfig } from '../custom-provider-store.js';
import {
  getActiveCatalog,
  getActiveLocalModelCatalog,
  setActiveCatalog,
  setCustomProviderConfigs,
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
  it.each([undefined, null, 'openai-audio-speech'] as const)(
    'refreshes media protocol declarations without changing explicit user override %s', (nativeApi) => {
      const config: CustomProviderConfig = { id: 'speech-refresh', name: 'Speech', runtimes: {
        codex: { baseUrl: 'https://speech.example.test/v1', wireProtocol: 'openai-chat', models: [{
          id: 'new-server-voice', name: 'Voice',
          discoveredMetadata: { mode: 'audio_speech', nativeApi: 'openai-audio-speech' },
          ...(nativeApi !== undefined ? { nativeApi } : {}),
        }] },
      } };
      const original = structuredClone(config);
      const publish = (declaration: 'openai-audio-speech' | null) => setActiveCatalog({
        ...BUNDLED_CATALOG,
        modelRegistry: { schemaVersion: 5, updatedAt: declaration ? '2026-10-12T06:00:00.000Z' : '2026-10-12T07:00:00.000Z',
          baseModels: [{ id: 'new-server-voice', aliases: [], defaults: { mode: 'audio_speech' } }],
          models: [{ id: 'new-server-voice', name: 'Voice', modelRef: 'new-server-voice', nativeApi: declaration,
            routes: [{ providerId: 'xd', modelId: 'new-server-voice', agents: [] }] }],
        },
      });
      publish('openai-audio-speech');
      setCustomProviderConfigs([config]);
      const activeProvider = () => getActiveCatalog().providers.find(p => p.id === config.id)!;
      expect(activeProvider().audioModels?.[0].nativeApi).toBe(nativeApi === null ? null : 'openai-audio-speech');
      publish(null);
      expect(activeProvider().models.codex![0].nativeApi).toBe(nativeApi === undefined ? null : nativeApi);
      expect(activeProvider().audioModels?.[0].nativeApi).toBe(nativeApi === undefined ? null : nativeApi);
      expect(activeProvider().models.codex![0].userModelConfig).toEqual(original.runtimes.codex!.models[0]);
      expect(config).toEqual(original);
    });

  it('keeps BYOK speech metadata through config validation, JSON persistence and active catalog refresh', () => {
    const discovered = parseModelsListResponse({ data: [{ id: 'gpt-private-voice',
      mode: 'audio_speech', native_api: 'openai-audio-speech' }] })!;
    const config: CustomProviderConfig = { id: 'speech-one', name: 'Speech', runtimes: {
      codex: { baseUrl: 'https://speech.example.test/v1', wireProtocol: 'openai-chat',
        models: mergeDiscoveredRuntimeModels([], discovered) },
    } };
    expect(validateCustomProviderConfig(config)).toEqual({ ok: true });
    const restored = JSON.parse(JSON.stringify(config)) as CustomProviderConfig;
    const other: CustomProviderConfig = { ...restored, id: 'speech-two', runtimes: {
      codex: { ...restored.runtimes.codex!, models: [{ id: 'gpt-private-voice', name: 'Chat', mode: 'chat' }] },
    } };
    const publish = () => setCustomProviders([restored, other].map(c =>
      buildUserProvider(c, { modelRegistry: BUNDLED_CATALOG.modelRegistry })));
    setActiveCatalog(BUNDLED_CATALOG);
    publish();
    for (let refresh = 0; refresh < 2; refresh++) {
      const active = getActiveCatalog();
      const speech = active.providers.find(p => p.id === restored.id)!;
      expect(speech.audioModels?.[0]).toMatchObject({ id: 'gpt-private-voice', mode: 'audio_speech',
        nativeApi: 'openai-audio-speech', sourceAgent: 'codex' });
      expect(isAgentSelectableModel(speech.models.codex![0], { userProvider: true })).toBe(false);
      expect(active.providers.find(p => p.id === other.id)?.audioModels).toBeUndefined();
      restored.runtimes.codex!.models = mergeDiscoveredRuntimeModels(restored.runtimes.codex!.models,
        [{ id: 'gpt-private-voice', name: 'Sparse refresh' }]);
      publish();
    }
  });

  it.each(['absent', 'legacy', 'empty'] as const)(
    'applies local overrides after %s registry fallback',
    (kind) => {
      const bundled = BUNDLED_CATALOG.modelRegistry!.localModels!;
      const [first, second] = bundled.models;
      const modelRegistry: ModelRegistry | undefined =
        kind === 'absent'
          ? undefined
          : {
              schemaVersion: 2,
              updatedAt: '2026-09-08T13:00:00.000Z',
              models: [],
              ...(kind === 'empty'
                ? { localModels: { version: 1 as const, models: [], featuredIds: [] } }
                : {}),
            };
      setActiveCatalog({ ...BUNDLED_CATALOG, modelRegistry });
      setLocalCatalogOverrides(
        sanitizeModelCatalogOverrides({
          version: 1,
          localModels: {
            removedIds: [second.id],
            patches: { [first.id]: { name: 'My fallback model' } },
            additions: [
              {
                id: 'user-local',
                name: 'User local',
                aliases: [],
                variants: [
                  { libraryName: 'user-local:latest', sizeBytes: 2 ** 30, minUnifiedMemoryGb: 4 },
                ],
              },
            ],
            featuredIds: [],
          },
        }).overrides,
      );
      const result = { localModels: getActiveLocalModelCatalog() };
      expect(result.localModels?.featuredIds).toEqual([]);
      expect(result.localModels?.models.some((m) => m.id === second.id)).toBe(false);
      expect(result.localModels?.models.find((m) => m.id === 'user-local')?.name).toBe(
        'User local',
      );
      expect(result.localModels?.models.find((m) => m.id === first.id)?.name).toBe(
        kind === 'empty' ? undefined : 'My fallback model',
      );
      expect(getActiveCatalog().modelRegistry?.models).toEqual(kind === 'absent' ? undefined : []);
      setLocalCatalogOverrides(EMPTY_MODEL_CATALOG_OVERRIDES);
    },
  );
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
  it('clears the main-side valid: none gate once the user declares the effort tiers', () => {
    // issue #5762 的实报路径：自定义供应商手填模型 ID、不配任何推理选项。此时 efforts 只是
    // 占位空表，任何显式档位都被 main 准入按 `effort "…" not supported … valid: none` 拒掉。
    // 用户在本 PR 的「思考」档位多选里声明真实档位后，同一份目录投影出去的 efforts 必须
    // 非空 —— store 侧（modelCatalogThinkingOverride）与准入侧（sendToSessionExecutionConfig）
    // 各有一半测试，中间的 active-catalog → descriptor → effortMetaByModel 投影此前无人看守，
 // 任一侧回归都会让用户在真机上重新撞 valid: none 而单测全绿。
    const runtime = { baseUrl: 'https://relay.example/v1', models: [{ id: 'hand-filled', name: 'Hand filled' }] };
    setCustomProviders([
      buildUserProvider({ id: 'relay', name: 'Relay', runtimes: { pi: runtime } }),
    ]);
    const available = () => deriveAvailableModels(getActiveCatalog(), 'pi');
    // 与 orcaProviderRoutingContext 同一构造：准入真正读的是 effortMetaByModel，
    // 不是 availableModels 上的 efforts（见 sendToSessionExecutionConfig 的 routeEffortMeta）。
    const routing = (): OrcaWorkerProviderRoutingContext => ({
      availability: {
        'claude-code': [],
        codex: [],
        pi: [{
          id: 'relay',
          name: 'Relay',
          models: available().map((m) => m.id),
          fastModels: [],
          effortMetaByModel: Object.fromEntries(
            available().map((m) => [
              m.id,
              {
                efforts: m.efforts,
                defaultEffort: m.defaultEffort,
                ...(m.effortsUnknown === true ? { effortsUnknown: true } : {}),
              },
            ]),
          ),
        }],
      },
      resolveDefaultProviderIdForModel: () => 'relay',
    });
    const submit = () =>
      resolveSendToSessionExecutionConfig({
        source: {
          agentKind: 'pi',
          model: 'hand-filled',
          effort: 'high',
          fastMode: false,
          providerId: 'relay',
        },
        overrides: { effort: 'high' },
        availableModels: available(),
        providerRouting: routing(),
        hasCindyAiApiKey: true,
      });

    // 基线：占位空表 → 显式 high 被拒（本 issue 的报错原文）。
    const before = submit();
    expect(before).toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
    expect(before.ok === false && before.message).toContain(
      'effort "high" not supported by model "hand-filled". valid: none',
    );

    // 声明真实档位后，同一份投影出的 efforts 非空，显式档位原样放行。
    setLocalCatalogOverrides(
      sanitizeModelCatalogOverrides({
        version: 1,
        patches: { 'relay:hand-filled': { base: { efforts: ['high'] } } },
      }).overrides,
    );
    expect(available().find((m) => m.id === 'hand-filled')?.efforts).toEqual(['high']);
    expect(submit()).toMatchObject({ ok: true, config: { effort: 'high', model: 'hand-filled' } });
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


it('keeps complex quotes with their provider snapshot and clears them on successful replacement', () => {
  const displayPricing = { items: [{ label: 'Generated video', tier: 'HD', price: 0.5, unit: 'second', quantity: 1, priceType: 'estimated' as const }], notes: ['Billed by output duration.'] };
  const video = { id: 'example-video', name: 'Video', mode: 'video_generation', agents: [] as const,
    currency: 'USD' as const, costDiscount: 0.2, displayPricing,
    modalities: { input: ['text'], output: ['video'] } };
  setActiveCatalog({ ...BUNDLED_CATALOG });
  setXdGatewayModels([{ ...video, agents: [] }], { authoritative: true });
  const provider = () => getActiveCatalog().providers.find((p) => p.id === 'xd')!;
  expect(provider().videoModels?.[0]).toMatchObject({ displayPricing, currency: 'USD', costDiscount: 0.2 });
  expect(Object.values(provider().models).flat().some((m) => m?.id === video.id)).toBe(false);
  setXdGatewayModels([{ ...video, displayPricing: undefined, agents: [] }], { authoritative: true });
  expect(provider().videoModels?.[0]).not.toHaveProperty('displayPricing');
  setXdGatewayModels([], { authoritative: true });
  expect(provider().videoModels).toEqual([]);
});
