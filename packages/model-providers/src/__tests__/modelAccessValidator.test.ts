import { describe, expect, it } from 'vitest';

import {
  MODEL_ACCESS_CATALOG_LEGACY_SCHEMA_VERSION,
  MODEL_ACCESS_CATALOG_SCHEMA_VERSION,
  MODEL_ACCESS_CATALOG_V5_SCHEMA_VERSION,
  MODEL_ACCESS_CATALOG_V3_SCHEMA_VERSION,
  MODEL_ACCESS_CATALOG_V2_SCHEMA_VERSION,
  MODEL_ACCESS_MODELS_PATH,
  MODEL_REGISTRY_LEGACY_SCHEMA_VERSION,
  MODEL_REGISTRY_SCHEMA_VERSION,
  MODEL_REGISTRY_STATUSES,
  modelRegistryCanonicalJson,
  parseListModelsResponse,
  parseModelRegistry,
  type ListModelsResponse,
  type ModelRegistry,
} from '../index.js';

const VALID_RESPONSE: ListModelsResponse = {
  schemaVersion: MODEL_ACCESS_CATALOG_V2_SCHEMA_VERSION,
  models: [
    {
      id: 'example-chat-model',
      mode: 'chat',
      currency: 'CNY',
      agents: ['claude-code', 'codex'],
      newSessionDefault: ['claude-code', 'codex'],
      name: 'Example Chat Model',
      icon: 'example',
      contextWindow: 200_000,
      modalities: { input: ['text', 'image'], output: ['text'] },
      inputCostPerToken: 0.000_001,
      outputCostPerToken: 0.000_002,
      efforts: ['low', 'medium', 'high'],
      defaultEffort: 'medium',
      perAgent: {
        'claude-code': { supportsFastMode: false },
      },
      tieredPricing: [
        {
          range: [0, 200_000],
          inputCostPerToken: 0.000_001,
          outputCostPerToken: 0.000_002,
        },
      ],
    },
  ],
};

const VALID_V3_RESPONSE: ListModelsResponse = {
  ...VALID_RESPONSE,
  schemaVersion: MODEL_ACCESS_CATALOG_V3_SCHEMA_VERSION,
  models: [
    {
      ...VALID_RESPONSE.models[0]!,
      perAgent: {
        'claude-code': {
          supportsFastMode: false,
          wireProtocol: 'anthropic-messages',
        },
        codex: { wireProtocol: 'openai-responses' },
      },
    },
  ],
};

const VALID_V4_RESPONSE: ListModelsResponse = {
  ...VALID_V3_RESPONSE,
  schemaVersion: MODEL_ACCESS_CATALOG_SCHEMA_VERSION,
};

const VALID_V5_RESPONSE: ListModelsResponse = {
  schemaVersion: MODEL_ACCESS_CATALOG_V5_SCHEMA_VERSION,
  accountTier: 'free',
  models: VALID_V4_RESPONSE.models.map((model) => ({
    ...model,
    availability: 'requires_payment',
  })),
};

const VALID_REGISTRY: ModelRegistry = {
  schemaVersion: MODEL_REGISTRY_SCHEMA_VERSION,
  updatedAt: '2026-07-31T00:00:00.000Z',
  models: [
    {
      id: 'example/model',
      name: 'Example Model',
      status: 'active',
      contextWindow: 200_000,
      efforts: ['low', 'medium', 'high'],
      defaultEffort: 'medium',
      routes: [
        {
          providerId: 'example',
          modelId: 'example-model',
          agents: ['claude-code', 'codex'],
          referencePrices: [
            {
              currency: 'USD',
              variant: 'standard',
              inputPerMtok: 1,
              outputPerMtok: 5,
              cacheReadPerMtok: 0.1,
              minInputTokens: 0,
              maxInputTokens: 200_000,
              effectiveFrom: '2026-07-01',
              source: {
                kind: 'provider-official',
                url: 'https://example.com/pricing',
                verifiedAt: '2026-07-31',
              },
            },
          ],
        },
      ],
    },
  ],
};

function expectReject(value: unknown, path: string): void {
  const result = parseListModelsResponse(value);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('unreachable');
  expect(result.error).toContain(path);
}

describe('model access catalog contract', () => {
  it('round-trips the versioned model catalog with its declared currency', () => {
    const wire = JSON.parse(JSON.stringify(VALID_RESPONSE));
    const result = parseListModelsResponse(wire);
    expect(result).toEqual({ ok: true, value: VALID_RESPONSE });
    expect(MODEL_ACCESS_MODELS_PATH).toBe('/api/model-access/models');
  });

  it('parses strict v5 availability and account tier fields', () => {
    expect(parseListModelsResponse(VALID_V5_RESPONSE)).toEqual({
      ok: true,
      value: VALID_V5_RESPONSE,
    });
    expectReject({ ...VALID_V5_RESPONSE, accountTier: 'vip' }, 'response.accountTier');
    expectReject(
      {
        ...VALID_V5_RESPONSE,
        models: [{ ...VALID_V5_RESPONSE.models[0]!, availability: 'unavailable' }],
      },
      'response.models[0].availability',
    );
  });

  it('continues to parse v1 responses, while v1 rejects the v2-only default field', () => {
    const { newSessionDefault: _newSessionDefault, ...legacyModel } = VALID_RESPONSE.models[0]!;
    const legacy = {
      ...VALID_RESPONSE,
      schemaVersion: MODEL_ACCESS_CATALOG_LEGACY_SCHEMA_VERSION,
      models: [legacyModel],
    };
    expect(parseListModelsResponse(JSON.parse(JSON.stringify(legacy))).ok).toBe(true);
    expectReject(
      {
        ...legacy,
        models: [{ ...legacyModel, newSessionDefault: ['claude-code'] }],
      },
      'response.models[0].newSessionDefault',
    );
  });

  it('enforces the complete per-version ListModels allowlist', () => {
    const { newSessionDefault: _newSessionDefault, ...legacyModel } = VALID_RESPONSE.models[0]!;
    const versions = [
      [MODEL_ACCESS_CATALOG_LEGACY_SCHEMA_VERSION, legacyModel],
      [MODEL_ACCESS_CATALOG_V2_SCHEMA_VERSION, VALID_RESPONSE.models[0]!],
      [MODEL_ACCESS_CATALOG_V3_SCHEMA_VERSION, VALID_V3_RESPONSE.models[0]!],
      [MODEL_ACCESS_CATALOG_SCHEMA_VERSION, VALID_V4_RESPONSE.models[0]!],
    ] as const;

    for (const [schemaVersion, model] of versions) {
      const response = { schemaVersion, models: [model] };
      const tier = model.tieredPricing![0]!;
      const cases: [unknown, string][] = [
        [{ ...response, producerRevision: 'stale-v2' }, 'response.producerRevision'],
        [{ ...response, models: [{ ...model, family: 'example' }] }, 'response.models[0].family'],
        [
          {
            ...response,
            models: [{ ...model, provenance: { source: 'stale-v2' } }],
          },
          'response.models[0].provenance',
        ],
        [
          {
            ...response,
            models: [
              {
                ...model,
                perAgent: {
                  'claude-code': { supportsFastMode: false, verified: true },
                },
              },
            ],
          },
          'response.models[0].perAgent.claude-code.verified',
        ],
        [
          {
            ...response,
            models: [
              {
                ...model,
                tieredPricing: [{ ...tier, provenance: 'stale-v2' }],
              },
            ],
          },
          'response.models[0].tieredPricing[0].provenance',
        ],
        [
          {
            ...response,
            models: [
              {
                ...model,
                modalities: { ...model.modalities!, source: 'stale-v2' },
              },
            ],
          },
          'response.models[0].modalities.source',
        ],
      ];

      for (const [value, path] of cases) expectReject(value, path);
    }
  });

  it('rejects malformed v2 newSessionDefault values', () => {
    const withDefault = (value: unknown) => ({
      ...VALID_RESPONSE,
      models: [{ ...VALID_RESPONSE.models[0], newSessionDefault: value }],
    });
    expectReject(withDefault([]), 'response.models[0].newSessionDefault');
    expectReject(withDefault(['codex', 'codex']), 'response.models[0].newSessionDefault');
    expect(parseListModelsResponse(withDefault(['pi']))).toMatchObject({
      ok: true,
    });
    expectReject(
      {
        ...VALID_RESPONSE,
        models: [
          {
            ...VALID_RESPONSE.models[0],
            agents: ['claude-code'],
            newSessionDefault: ['codex'],
          },
        ],
      },
      'response.models[0].newSessionDefault',
    );
  });

  it('validates existing mode and normalized modalities in both schema versions', () => {
    const { newSessionDefault: _newSessionDefault, ...legacyModel } = VALID_RESPONSE.models[0]!;
    for (const [schemaVersion, model] of [
      [MODEL_ACCESS_CATALOG_LEGACY_SCHEMA_VERSION, legacyModel],
      [MODEL_ACCESS_CATALOG_V2_SCHEMA_VERSION, VALID_RESPONSE.models[0]!],
      [MODEL_ACCESS_CATALOG_V3_SCHEMA_VERSION, VALID_V3_RESPONSE.models[0]!],
      [MODEL_ACCESS_CATALOG_SCHEMA_VERSION, VALID_V4_RESPONSE.models[0]!],
    ] as const) {
      expect(parseListModelsResponse({ schemaVersion, models: [model] }).ok).toBe(true);
      expectReject({ schemaVersion, models: [{ ...model, mode: 42 }] }, 'response.models[0].mode');
      expectReject(
        { schemaVersion, models: [{ ...model, icon: '   ' }] },
        'response.models[0].icon',
      );
      expectReject({ schemaVersion, models: [{ ...model, icon: 42 }] }, 'response.models[0].icon');
      expectReject(
        {
          schemaVersion,
          models: [{ ...model, modalities: { input: ['text', 42], output: ['text'] } }],
        },
        'response.models[0].modalities.input',
      );
    }
  });

  it.each([undefined, 'responses'] as const)(
    '仍要求 mode=%s 的可聊天模型提供 contextWindow',
    (mode) => {
      const { contextWindow: _contextWindow, mode: _mode, ...withoutContextWindow } =
        VALID_V3_RESPONSE.models[0]!;
      expectReject(
        {
          schemaVersion: MODEL_ACCESS_CATALOG_SCHEMA_VERSION,
          models: [{ ...withoutContextWindow, ...(mode === undefined ? {} : { mode }) }],
        },
        'response.models[0].contextWindow',
      );
    },
  );

  it('v4 允许媒体模型省略 contextWindow，v3 保持已发布约束', () => {
    for (const mode of ['image_generation', 'video_generation'] as const) {
      const mediaModel = {
        id: `${mode}-model`,
        name: `${mode} model`,
        mode,
        currency: 'CNY',
        agents: [],
        modalities: {
          input: mode === 'image_generation' ? ['text'] : ['text', 'image'],
          output: [mode === 'image_generation' ? 'image' : 'video'],
        },
      } as const;
      expect(
        parseListModelsResponse({
          schemaVersion: MODEL_ACCESS_CATALOG_SCHEMA_VERSION,
          models: [mediaModel],
        }).ok,
      ).toBe(true);
      expectReject(
        {
          schemaVersion: MODEL_ACCESS_CATALOG_V3_SCHEMA_VERSION,
          models: [mediaModel],
        },
        'response.models[0].agents',
      );
      expectReject(
        {
          schemaVersion: MODEL_ACCESS_CATALOG_SCHEMA_VERSION,
          models: [{ ...mediaModel, agents: ['codex'] }],
        },
        'response.models[0].agents must be empty',
      );
    }
  });

  it.each(['CNY', 'USD'] as const)('accepts the supported %s currency', (currency) => {
    const result = parseListModelsResponse({
      ...VALID_RESPONSE,
      models: [{ ...VALID_RESPONSE.models[0], currency }],
    });
    expect(result.ok).toBe(true);
  });

  it('accepts missing currency for legacy fallback and rejects unsupported explicit values', () => {
    const { currency: _currency, ...withoutCurrency } = VALID_RESPONSE.models[0]!;
    expect(parseListModelsResponse({ ...VALID_RESPONSE, models: [withoutCurrency] })).toEqual({
      ok: true,
      value: { ...VALID_RESPONSE, models: [withoutCurrency] },
    });
    expectReject(
      {
        ...VALID_RESPONSE,
        models: [{ ...VALID_RESPONSE.models[0], currency: 'EUR' }],
      },
      'response.models[0].currency',
    );
  });

  it('accepts missing or empty agents, filters future kinds, and rejects malformed values', () => {
    const {
      agents: _agents,
      newSessionDefault: _newSessionDefault,
      perAgent: _perAgent,
      ...withoutAgents
    } = VALID_RESPONSE.models[0]!;

    for (const model of [withoutAgents, { ...withoutAgents, agents: [] }]) {
      expect(parseListModelsResponse({ ...VALID_RESPONSE, models: [model] }).ok).toBe(true);
    }
    expect(
      parseListModelsResponse({
        ...VALID_RESPONSE,
        models: [{ ...withoutAgents, agents: ['future-agent'] }],
      }),
    ).toMatchObject({ ok: true, value: { models: [{ agents: [] }] } });
    expectReject(
      { ...VALID_RESPONSE, models: [{ ...withoutAgents, agents: [42] }] },
      'response.models[0].agents',
    );
  });

  it('accepts null defaults from Model Access at the model and agent-override levels', () => {
    expect(
      parseListModelsResponse({
        ...VALID_RESPONSE,
        models: [
          {
            ...VALID_RESPONSE.models[0],
            defaultEffort: null,
            perAgent: { codex: { defaultEffort: null } },
          },
        ],
      }).ok,
    ).toBe(true);
  });

  it('rejects unsupported schema versions and malformed nested pricing', () => {
    expectReject({ ...VALID_RESPONSE, schemaVersion: 6 }, 'response.schemaVersion');
    expectReject(
      {
        ...VALID_RESPONSE,
        models: [
          {
            ...VALID_RESPONSE.models[0],
            tieredPricing: [{ range: [200_000, 0] }],
          },
        ],
      },
      'response.models[0].tieredPricing[0].range',
    );
  });

  it('treats Pi wireProtocol as a forward-compatible last-priority hint while keeping Claude and Codex fixed', () => {
    const piModel = {
      ...VALID_V3_RESPONSE.models[0],
      agents: ['claude-code', 'codex', 'pi'],
      perAgent: {
        ...VALID_V3_RESPONSE.models[0]!.perAgent,
        pi: { wireProtocol: 'openai-responses' },
      },
    } as const;
    for (const wireProtocol of [
      'anthropic-messages',
      'openai-responses',
      'openai-completions',
      'google-generative-ai',
    ] as const) {
      expect(
        parseListModelsResponse({
          ...VALID_V3_RESPONSE,
          models: [{
            ...piModel,
            perAgent: { ...piModel.perAgent, pi: { wireProtocol } },
          }],
        }).ok,
      ).toBe(true);
    }
    expect(
      parseListModelsResponse({
        ...VALID_V3_RESPONSE,
        models: [{
          ...piModel,
          perAgent: {
            'claude-code': { wireProtocol: 'anthropic-messages' },
            codex: { wireProtocol: 'openai-responses' },
          },
        }],
      }).ok,
    ).toBe(true);
    expectReject(
      { ...VALID_V3_RESPONSE, models: [{ ...piModel, perAgent: {} }] },
      'response.models[0].perAgent.claude-code.wireProtocol',
    );
    expectReject(
      {
        ...VALID_V3_RESPONSE,
        models: [{
          ...piModel,
          perAgent: {
            ...piModel.perAgent,
            codex: { wireProtocol: 'anthropic-messages' },
          },
        }],
      },
      'response.models[0].perAgent.codex.wireProtocol must be openai-responses',
    );
    expect(
      parseListModelsResponse({
        ...VALID_V3_RESPONSE,
        models: [{
          ...piModel,
          perAgent: {
            ...piModel.perAgent,
            pi: { wireProtocol: 'future-protocol' },
          },
        }],
      }).ok,
    ).toBe(true);
    for (const wireProtocol of ['', 42, { api: 'openai-responses' }]) {
      expectReject(
        {
          ...VALID_V3_RESPONSE,
          models: [{
            ...piModel,
            perAgent: { ...piModel.perAgent, pi: { wireProtocol } },
          }],
        },
        'response.models[0].perAgent.pi.wireProtocol must be a non-empty string',
      );
    }
  });

  it('requires complete runtime metadata in v3 without changing v2', () => {
    const {
      name: _name,
      contextWindow: _contextWindow,
      ...incomplete
    } = VALID_V3_RESPONSE.models[0]!;
    expectReject(
      {
        ...VALID_V3_RESPONSE,
        models: [{ ...incomplete, contextWindow: 200_000 }],
      },
      'response.models[0].name',
    );
    expectReject(
      {
        ...VALID_V3_RESPONSE,
        models: [{ ...incomplete, name: 'Example Chat Model' }],
      },
      'response.models[0].contextWindow',
    );
    expect(
      parseListModelsResponse({
        ...VALID_RESPONSE,
        models: [{ ...incomplete, perAgent: VALID_RESPONSE.models[0]!.perAgent }],
      }).ok,
    ).toBe(true);
  });

  it('rejects defaults that are absent from the declared effort list', () => {
    expectReject(
      {
        ...VALID_RESPONSE,
        models: [
          {
            ...VALID_RESPONSE.models[0],
            efforts: ['low'],
            defaultEffort: 'high',
          },
        ],
      },
      'response.models[0].defaultEffort',
    );
    expectReject(
      {
        ...VALID_RESPONSE,
        models: [
          {
            ...VALID_RESPONSE.models[0],
            perAgent: { codex: { efforts: ['low'], defaultEffort: 'high' } },
          },
        ],
      },
      'response.models[0].perAgent.codex.defaultEffort',
    );
    expectReject(
      {
        ...VALID_RESPONSE,
        models: [
          {
            ...VALID_RESPONSE.models[0],
            efforts: ['low', 'high'],
            defaultEffort: 'high',
            perAgent: { codex: { efforts: ['low'] } },
          },
        ],
      },
      'response.models[0].perAgent.codex.efforts',
    );
  });

  it('rejects duplicate ids and overrides for unsupported agents', () => {
    expectReject(
      {
        ...VALID_RESPONSE,
        models: [{ ...VALID_RESPONSE.models[0] }, { ...VALID_RESPONSE.models[0] }],
      },
      'response.models[1].id',
    );
    expectReject(
      {
        ...VALID_RESPONSE,
        models: [
          {
            ...VALID_RESPONSE.models[0],
            agents: ['claude-code'],
            newSessionDefault: ['claude-code'],
            perAgent: { codex: { supportsFastMode: true } },
          },
        ],
      },
      'response.models[0].perAgent.codex',
    );
  });
});

function expectRegistryReject(value: unknown, path: string): void {
  const result = parseModelRegistry(value);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('unreachable');
  expect(result.error).toContain(path);
}

describe('public model registry contract', () => {
  it('round-trips canonical metadata, provider routes, and sourced reference prices', () => {
    const wire = JSON.parse(JSON.stringify(VALID_REGISTRY));
    expect(parseModelRegistry(wire)).toEqual({
      ok: true,
      value: VALID_REGISTRY,
    });
  });

  it('continues to parse legacy v1 registries, while v1 rejects the v2-only field', () => {
    const legacy = {
      ...VALID_REGISTRY,
      schemaVersion: MODEL_REGISTRY_LEGACY_SCHEMA_VERSION,
    };
    expect(parseModelRegistry(JSON.parse(JSON.stringify(legacy))).ok).toBe(true);
    expectRegistryReject(
      {
        ...legacy,
        models: [{ ...legacy.models[0], newSessionDefault: ['claude-code'] }],
      },
      'modelRegistry.models[0].newSessionDefault',
    );
  });

  it('accepts newSessionDefault as a subset of the entry route agents', () => {
    const entry = VALID_REGISTRY.models[0]!;
    const wire = {
      ...VALID_REGISTRY,
      models: [{ ...entry, newSessionDefault: ['claude-code', 'codex'] }],
    };
    const result = parseModelRegistry(JSON.parse(JSON.stringify(wire)));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.models[0]!.newSessionDefault).toEqual(['claude-code', 'codex']);
  });

  it('rejects a malformed newSessionDefault (empty / duplicate / unknown agent)', () => {
    const entry = VALID_REGISTRY.models[0]!;
    const withDefault = (v: unknown) => ({
      ...VALID_REGISTRY,
      models: [{ ...entry, newSessionDefault: v }],
    });
    expectRegistryReject(withDefault([]), 'modelRegistry.models[0].newSessionDefault');
    expectRegistryReject(
      withDefault(['claude-code', 'claude-code']),
      'modelRegistry.models[0].newSessionDefault',
    );
    expectRegistryReject(withDefault(['bogus-agent']), 'modelRegistry.models[0].newSessionDefault');
  });

  it('rejects newSessionDefault agents not backed by any route', () => {
    const entry = VALID_REGISTRY.models[0]!;
    const route = entry.routes[0]!;
    const wire = {
      ...VALID_REGISTRY,
      models: [
        {
          ...entry,
          routes: [{ ...route, agents: ['claude-code'] }],
          newSessionDefault: ['codex'],
        },
      ],
    };
    expectRegistryReject(
      JSON.parse(JSON.stringify(wire)),
      'modelRegistry.models[0].newSessionDefault',
    );
  });

  it('rejects newSessionDefault on retired registry entries', () => {
    const entry = VALID_REGISTRY.models[0]!;
    expectRegistryReject(
      {
        ...VALID_REGISTRY,
        models: [{ ...entry, status: 'retired', newSessionDefault: ['claude-code'] }],
      },
      'modelRegistry.models[0].newSessionDefault',
    );
  });

  it('rejects client provenance and every other field outside the versioned schema', () => {
    const entry = VALID_REGISTRY.models[0]!;
    const route = entry.routes[0]!;
    const price = route.referencePrices![0]!;
    const cases: [unknown, string][] = [
      [{ ...VALID_REGISTRY, contextWindowVerified: true }, 'modelRegistry.contextWindowVerified'],
      [
        {
          ...VALID_REGISTRY,
          models: [{ ...entry, contextWindowExplicit: true }],
        },
        'modelRegistry.models[0].contextWindowExplicit',
      ],
      [
        {
          ...VALID_REGISTRY,
          models: [
            {
              ...entry,
              routes: [{ ...route, discoveredAt: '2026-07-31T00:00:00.000Z' }],
            },
          ],
        },
        'modelRegistry.models[0].routes[0].discoveredAt',
      ],
      [
        {
          ...VALID_REGISTRY,
          models: [{ ...entry, perAgent: { codex: { verified: true } } }],
        },
        'modelRegistry.models[0].perAgent.codex.verified',
      ],
      [
        {
          ...VALID_REGISTRY,
          models: [
            {
              ...entry,
              routes: [
                {
                  ...route,
                  referencePrices: [{ ...price, userOverride: true }],
                },
              ],
            },
          ],
        },
        'modelRegistry.models[0].routes[0].referencePrices[0].userOverride',
      ],
      [
        {
          ...VALID_REGISTRY,
          models: [
            {
              ...entry,
              routes: [
                {
                  ...route,
                  referencePrices: [
                    {
                      ...price,
                      source: { ...price.source, internalNote: 'client-only' },
                    },
                  ],
                },
              ],
            },
          ],
        },
        'modelRegistry.models[0].routes[0].referencePrices[0].source.internalNote',
      ],
    ];

    for (const [value, path] of cases) expectRegistryReject(value, path);
  });

  it('rejects unsupported versions, duplicate canonical ids, and duplicate routes', () => {
    expectRegistryReject({ ...VALID_REGISTRY, schemaVersion: 3 }, 'modelRegistry.schemaVersion');
    expectRegistryReject(
      {
        ...VALID_REGISTRY,
        models: [VALID_REGISTRY.models[0], VALID_REGISTRY.models[0]],
      },
      'modelRegistry.models[1].id',
    );
    expectRegistryReject(
      {
        ...VALID_REGISTRY,
        models: [
          {
            ...VALID_REGISTRY.models[0],
            routes: [VALID_REGISTRY.models[0]!.routes[0], VALID_REGISTRY.models[0]!.routes[0]],
          },
        ],
      },
      'modelRegistry.models[0].routes[1]',
    );
  });

  it('requires a canonical, calendar-valid UTC timestamp', () => {
    for (const updatedAt of [
      '2026-07-31',
      'July 31, 2026',
      '2026-07-31T00:00:00Z',
      '2026-02-29T00:00:00.000Z',
      '2026-07-31T08:00:00.000+08:00',
    ]) {
      expectRegistryReject({ ...VALID_REGISTRY, updatedAt }, 'modelRegistry.updatedAt');
    }
  });

  it('rejects malformed price bands and untraceable price sources', () => {
    const baseRoute = VALID_REGISTRY.models[0]!.routes[0]!;
    const basePrice = baseRoute.referencePrices![0]!;
    expectRegistryReject(
      {
        ...VALID_REGISTRY,
        models: [
          {
            ...VALID_REGISTRY.models[0],
            routes: [
              {
                ...baseRoute,
                referencePrices: [
                  {
                    ...basePrice,
                    minInputTokens: 200_000,
                    maxInputTokens: 200_000,
                  },
                ],
              },
            ],
          },
        ],
      },
      'maxInputTokens',
    );
    expectRegistryReject(
      {
        ...VALID_REGISTRY,
        models: [
          {
            ...VALID_REGISTRY.models[0],
            routes: [
              {
                ...baseRoute,
                referencePrices: [
                  {
                    ...basePrice,
                    source: {
                      ...basePrice.source,
                      url: 'http://example.com/pricing',
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
      'source.url',
    );
  });

  it('allows scheduled prices and agent-specific metadata only on supported routes', () => {
    const baseRoute = VALID_REGISTRY.models[0]!.routes[0]!;
    const basePrice = baseRoute.referencePrices![0]!;
    expect(
      parseModelRegistry({
        ...VALID_REGISTRY,
        models: [
          {
            ...VALID_REGISTRY.models[0],
            perAgent: { codex: { contextWindow: 272_000 } },
            routes: [
              {
                ...baseRoute,
                referencePrices: [
                  { ...basePrice, effectiveUntil: '2026-09-01' },
                  {
                    ...basePrice,
                    inputPerMtok: 2,
                    outputPerMtok: 10,
                    effectiveFrom: '2026-09-01',
                  },
                ],
              },
            ],
          },
        ],
      }).ok,
    ).toBe(true);

    expectRegistryReject(
      {
        ...VALID_REGISTRY,
        models: [
          {
            ...VALID_REGISTRY.models[0],
            routes: [{ ...baseRoute, agents: ['claude-code'] }],
            perAgent: { codex: { contextWindow: 272_000 } },
          },
        ],
      },
      'perAgent.codex',
    );
  });

  it('carries a materialization-complete presence shape on the current v2 wire', () => {
    // The exact shape a policy-based client requires before deriving a
    // selectable entry (MODEL_REGISTRY.md "Presence, entitlement, and sale
    // availability"): explicit status + self-consistent capability set +
    // per-agent divergence.
    expect(MODEL_REGISTRY_SCHEMA_VERSION).toBe(2);
    const wire = {
      ...VALID_REGISTRY,
      models: [
        {
          ...VALID_REGISTRY.models[0],
          status: 'preview',
          maxOutputTokens: 64_000,
          perAgent: {
            codex: {
              contextWindow: 272_000,
              efforts: ['low', 'medium', 'high'],
              defaultEffort: 'high',
            },
          },
        },
      ],
    };
    expect(parseModelRegistry(JSON.parse(JSON.stringify(wire))).ok).toBe(true);
  });

  it.each(MODEL_REGISTRY_STATUSES)('accepts the %s lifecycle status', (status) => {
    expect(
      parseModelRegistry({
        ...VALID_REGISTRY,
        models: [{ ...VALID_REGISTRY.models[0], status }],
      }).ok,
    ).toBe(true);
  });

  it('accepts a fixed-effort entry: empty efforts with no default', () => {
    const { defaultEffort: _defaultEffort, ...entry } = VALID_REGISTRY.models[0]!;
    expect(
      parseModelRegistry({
        ...VALID_REGISTRY,
        models: [{ ...entry, efforts: [] }],
      }).ok,
    ).toBe(true);
  });

  it('canonicalizes object key order while preserving snapshot content changes', () => {
    const reordered = {
      models: VALID_REGISTRY.models,
      updatedAt: VALID_REGISTRY.updatedAt,
      schemaVersion: VALID_REGISTRY.schemaVersion,
    };
    expect(modelRegistryCanonicalJson(reordered)).toBe(modelRegistryCanonicalJson(VALID_REGISTRY));
    expect(
      modelRegistryCanonicalJson({
        ...reordered,
        models: reordered.models.slice(1),
      }),
    ).not.toBe(modelRegistryCanonicalJson(VALID_REGISTRY));

    const secondModel = {
      ...VALID_REGISTRY.models[0]!,
      id: 'example/other-model',
      routes: [
        {
          ...VALID_REGISTRY.models[0]!.routes[0]!,
          modelId: 'other-model',
        },
      ],
    };
    const orderedModels = [VALID_REGISTRY.models[0]!, secondModel];
    expect(modelRegistryCanonicalJson({ ...VALID_REGISTRY, models: orderedModels })).not.toBe(
      modelRegistryCanonicalJson({
        ...VALID_REGISTRY,
        models: [...orderedModels].reverse(),
      }),
    );
  });

  it('keeps availability and selectability out of the wire schema', () => {
    // Presence is the only registry-owned signal; availability/selectability
    // markers are foreign fields at every level.
    const entry = VALID_REGISTRY.models[0]!;
    const route = entry.routes[0]!;
    const cases: [unknown, string][] = [
      [{ ...entry, available: true }, 'modelRegistry.models[0].available'],
      [{ ...entry, selectable: true }, 'modelRegistry.models[0].selectable'],
      [
        { ...entry, routes: [{ ...route, available: true }] },
        'modelRegistry.models[0].routes[0].available',
      ],
    ];
    for (const [model, path] of cases) {
      expectRegistryReject({ ...VALID_REGISTRY, models: [model] }, path);
    }
  });

  it('rejects client-derived agent harnesses on routes and per-agent overrides', () => {
    // Projection harnesses (for example a client-side pi tab) never appear on
    // the wire; the closed agent enum keeps them client-owned.
    const entry = VALID_REGISTRY.models[0]!;
    const route = entry.routes[0]!;
    const cases: [unknown, string][] = [
      [
        { ...entry, routes: [{ ...route, agents: ['claude-code', 'pi'] }] },
        'modelRegistry.models[0].routes[0].agents',
      ],
      [
        { ...entry, perAgent: { pi: { contextWindow: 200_000 } } },
        'modelRegistry.models[0].perAgent.pi',
      ],
    ];
    for (const [model, path] of cases) {
      expectRegistryReject({ ...VALID_REGISTRY, models: [model] }, path);
    }
  });

  it('rejects ambiguous overlapping reference prices for the same currency and variant', () => {
    const baseRoute = VALID_REGISTRY.models[0]!.routes[0]!;
    const basePrice = baseRoute.referencePrices![0]!;
    for (const overlappingPrice of [
      { ...basePrice },
      { ...basePrice, minInputTokens: 100_000, maxInputTokens: 300_000 },
      {
        ...basePrice,
        effectiveFrom: '2026-07-15',
        effectiveUntil: '2026-08-01',
      },
    ]) {
      expectRegistryReject(
        {
          ...VALID_REGISTRY,
          models: [
            {
              ...VALID_REGISTRY.models[0],
              routes: [
                {
                  ...baseRoute,
                  referencePrices: [basePrice, overlappingPrice],
                },
              ],
            },
          ],
        },
        'referencePrices[1] overlaps referencePrices[0]',
      );
    }
  });
});
