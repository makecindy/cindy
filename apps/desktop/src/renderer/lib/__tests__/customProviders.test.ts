import { afterEach, describe, expect, it, vi } from 'vitest';

import { customProviderSecretStorageKey } from '@/../shared/providerSecrets';

import {
  appendDiscoveredCustomProviderModels,
  createCustomProvider,
  customProviderModelConfigFromCatalogModel,
  deleteCustomProvider,
  piCatalogProviderIdAfterRouteEdit,
  providerViewToCustomProviderConfig,
  readCustomProviderKey,
  replaceCustomProviderModelId,
  setCustomProviderModelReasoning,
  setCustomProviderModelReasoningEffort,
  setCustomProviderModelSupportsImageInput,
  updateCustomProvider,
} from '../customProviders';
import type {
  CatalogModel,
  ProviderRuntimeModelConfig,
  ProviderView,
} from '@cindy/model-providers';
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('piCatalogProviderIdAfterRouteEdit', () => {
  const official = {
    baseUrl: 'https://api.example.com/anthropic',
    wireProtocol: 'anthropic-messages' as const,
    piCatalogProviderId: 'example',
  };

  it('keeps a newly applied marker and an unchanged official route', () => {
    expect(
      piCatalogProviderIdAfterRouteEdit(
        'pi',
        { ...official, piCatalogProviderId: undefined },
        official,
      ),
    ).toBe('example');
    expect(piCatalogProviderIdAfterRouteEdit('pi', official, official)).toBe('example');
    expect(
      piCatalogProviderIdAfterRouteEdit('pi', official, {
        ...official,
        baseUrl: `${official.baseUrl}/`,
      }),
    ).toBe('example');
  });

  it('clears the marker after either endpoint or protocol is edited', () => {
    expect(
      piCatalogProviderIdAfterRouteEdit('pi', official, {
        ...official,
        baseUrl: 'https://proxy.example/v1',
      }),
    ).toBeUndefined();
    expect(
      piCatalogProviderIdAfterRouteEdit('pi', official, {
        ...official,
        wireProtocol: 'openai-chat',
      }),
    ).toBeUndefined();
  });

  it('keeps the marker when a temporary route edit is reverted before the final save', () => {
    const temporaryEdit = {
      ...official,
      baseUrl: 'https://proxy.example/v1',
    };
    expect(piCatalogProviderIdAfterRouteEdit('pi', official, temporaryEdit)).toBeUndefined();
    expect(
      piCatalogProviderIdAfterRouteEdit('pi', official, {
        ...temporaryEdit,
        baseUrl: official.baseUrl,
      }),
    ).toBe('example');
    expect(
      piCatalogProviderIdAfterRouteEdit('pi', official, {
        ...temporaryEdit,
        wireProtocol: official.wireProtocol,
      }),
    ).toBeUndefined();
  });

  it('treats an omitted Pi protocol as the effective openai-chat default', () => {
    const openAiChat = {
      ...official,
      wireProtocol: 'openai-chat' as const,
    };
    expect(piCatalogProviderIdAfterRouteEdit('pi', openAiChat, {
      ...openAiChat,
      wireProtocol: undefined,
    })).toBe('example');
    expect(piCatalogProviderIdAfterRouteEdit('pi', {
      ...openAiChat,
      wireProtocol: undefined,
    }, openAiChat)).toBe('example');
    expect(piCatalogProviderIdAfterRouteEdit('pi', openAiChat, {
      ...openAiChat,
      wireProtocol: 'anthropic-messages',
    })).toBeUndefined();
  });

  it('clears the marker after any model metadata is edited', () => {
    const withModels: {
      baseUrl: string;
      wireProtocol: 'anthropic-messages';
      piCatalogProviderId: string;
      models: ProviderRuntimeModelConfig[];
    } = {
      ...official,
      models: [{
        id: 'model-a',
        name: 'Model A',
        contextWindow: 128_000,
        supportsImageInput: true,
        reasoning: true,
        reasoningEfforts: ['low', 'high'],
        reasoningDefaultEffort: 'high',
      }],
    };
    expect(piCatalogProviderIdAfterRouteEdit('pi', withModels, withModels)).toBe('example');
    const editedModels: ProviderRuntimeModelConfig[] = [
      { ...withModels.models[0], name: 'Renamed' },
      { ...withModels.models[0], contextWindow: 64_000 },
      { ...withModels.models[0], supportsImageInput: false },
      { ...withModels.models[0], reasoningEfforts: ['low'] },
    ];
    for (const model of editedModels) {
      expect(piCatalogProviderIdAfterRouteEdit('pi', withModels, {
        ...withModels,
        models: [model],
      })).toBeUndefined();
    }
    expect(piCatalogProviderIdAfterRouteEdit('pi', withModels, {
      ...withModels,
      models: [
        ...withModels.models,
        { id: 'models-url-only', name: 'Models URL Only', defaultEnabled: false },
      ],
    })).toBe('example');
    expect(piCatalogProviderIdAfterRouteEdit('pi', withModels, {
      ...withModels,
      models: [{ ...withModels.models[0], defaultEnabled: false }],
    })).toBe('example');
    expect(piCatalogProviderIdAfterRouteEdit('pi', withModels, {
      ...withModels,
      models: [],
    })).toBeUndefined();
    expect(piCatalogProviderIdAfterRouteEdit('pi', withModels, {
      ...withModels,
      models: [{
        id: 'model-b',
        name: 'My Model B',
        contextWindow: 64_000,
        supportsImageInput: false,
        reasoning: true,
        reasoningEfforts: ['low'],
        reasoningDefaultEffort: 'low',
      }],
    })).toBeUndefined();
    expect(piCatalogProviderIdAfterRouteEdit('pi', withModels, {
      ...withModels,
      models: [
        { id: 'new-model', name: 'New model' },
        withModels.models[0],
      ],
    })).toBe('example');
    const twoModels = {
      ...withModels,
      models: [
        withModels.models[0],
        { id: 'model-b', name: 'Model B', contextWindow: 64_000 },
      ],
    };
    expect(piCatalogProviderIdAfterRouteEdit('pi', twoModels, {
      ...twoModels,
      models: [...twoModels.models].reverse(),
    })).toBe('example');
    expect(piCatalogProviderIdAfterRouteEdit('pi', withModels, {
      ...withModels,
      models: [
        { ...withModels.models[0], name: 'Edited first duplicate' },
        withModels.models[0],
      ],
    })).toBeUndefined();
  });
});

describe('replaceCustomProviderModelId', () => {
  it('drops hidden metadata when the model id changes', () => {
    expect(replaceCustomProviderModelId({
      id: 'MiniMax-M3',
      name: 'MiniMax M3',
      contextWindow: 1_000_000,
      supportsImageInput: true,
      reasoning: true,
      reasoningEfforts: ['low', 'high'],
      reasoningDefaultEffort: 'high',
    }, 'another-model')).toEqual({
      id: 'another-model',
      name: 'MiniMax M3',
    });
  });

  it('preserves the original model when the id is unchanged', () => {
    const model = {
      id: 'MiniMax-M3',
      name: 'MiniMax M3',
      contextWindow: 1_000_000,
    };
    expect(replaceCustomProviderModelId(model, model.id)).toBe(model);
  });
});

describe('setCustomProviderModelSupportsImageInput', () => {
  it('updates only the selected model row', () => {
    const models = [
      { id: 'text', name: 'Text' },
      { id: 'vision', name: 'Vision' },
    ];
    expect(setCustomProviderModelSupportsImageInput(models, 1, true)).toEqual([
      models[0],
      { id: 'vision', name: 'Vision', supportsImageInput: true },
    ]);
  });
});

describe('Pi custom-provider reasoning controls', () => {
  it('enables conservative default levels and removes the capability when disabled', () => {
    const models = [{ id: 'reasoner', name: 'Reasoner' }];
    const enabled = setCustomProviderModelReasoning(models, 0, true);
    expect(enabled).toEqual([
      {
        id: 'reasoner',
        name: 'Reasoner',
        reasoning: true,
        reasoningEfforts: ['minimal', 'low', 'medium', 'high'],
      },
    ]);
    expect(setCustomProviderModelReasoning(enabled, 0, false)).toEqual(models);
  });

  it('keeps canonical order and refuses to remove the final supported effort', () => {
    const models: ProviderRuntimeModelConfig[] = [
      {
        id: 'reasoner',
        name: 'Reasoner',
        reasoning: true,
        reasoningEfforts: ['high'],
      },
    ];
    const withXhigh = setCustomProviderModelReasoningEffort(models, 0, 'xhigh', true);
    expect(withXhigh[0]?.reasoningEfforts).toEqual(['high', 'xhigh']);
    const highOnly = setCustomProviderModelReasoningEffort(withXhigh, 0, 'xhigh', false);
    expect(setCustomProviderModelReasoningEffort(highOnly, 0, 'high', false)).toEqual(highOnly);
  });
});

describe('customProviderModelConfigFromCatalogModel', () => {
  it('does not freeze the materialized custom-provider default into user config', () => {
    expect(customProviderModelConfigFromCatalogModel({
      id: 'default-context',
      name: 'Default Context',
      contextWindow: 200_000,
    })).toEqual({
      id: 'default-context',
      name: 'Default Context',
    });
  });

  it('preserves a provider-specific non-default context window', () => {
    expect(customProviderModelConfigFromCatalogModel({
      id: 'MiniMax-M3',
      name: 'MiniMax M3',
      contextWindow: 1_000_000,
    })).toEqual({
      id: 'MiniMax-M3',
      name: 'MiniMax M3',
      contextWindow: 1_000_000,
    });
  });

  it('preserves an explicit override equal to the current default (explicit flag wins)', () => {
    // 用户显式填了 200000:值恰好等于当前默认,但显式覆盖必须在未来默认升级后
    // 原样保留——不能靠等值推断丢掉字段(PR review P1)。
    expect(customProviderModelConfigFromCatalogModel({
      id: 'pinned-default',
      name: 'Pinned',
      contextWindow: 200_000,
      contextWindowExplicit: true,
    })).toEqual({
      id: 'pinned-default',
      name: 'Pinned',
      contextWindow: 200_000,
    });
  });

  it('preserves hidden defaults while round-tripping catalog models', () => {
    expect(customProviderModelConfigFromCatalogModel({
      id: 'discovered',
      name: 'Discovered',
      contextWindow: 200_000,
      defaultEnabled: false,
    })).toEqual({
      id: 'discovered',
      name: 'Discovered',
      defaultEnabled: false,
    });
  });

  it('preserves an explicit Pi image-input capability through the edit round trip', () => {
    expect(customProviderModelConfigFromCatalogModel({
      id: 'vision-model',
      name: 'Vision Model',
      contextWindow: 200_000,
      supportsImageInput: true,
    })).toEqual({
      id: 'vision-model',
      name: 'Vision Model',
      supportsImageInput: true,
    });
  });

  it('reconstructs explicit Pi reasoning capability from catalog efforts only for Pi', () => {
    const catalogModel = {
      id: 'reasoner',
      name: 'Reasoner',
      contextWindow: 200_000,
      efforts: ['low', 'high', 'xhigh'] as CatalogModel['efforts'],
      defaultEffort: 'xhigh' as const,
    };
    expect(customProviderModelConfigFromCatalogModel(catalogModel, 'pi')).toEqual({
      id: 'reasoner',
      name: 'Reasoner',
      reasoning: true,
      reasoningEfforts: ['low', 'high', 'xhigh'],
      reasoningDefaultEffort: 'xhigh',
    });
    expect(customProviderModelConfigFromCatalogModel(catalogModel, 'codex')).toEqual({
      id: 'reasoner',
      name: 'Reasoner',
    });
  });
});

describe('providerViewToCustomProviderConfig Pi catalog metadata', () => {
  it('preserves the hidden Pi official catalog provider id', () => {
    const provider = {
      id: 'deepseek',
      name: 'DeepSeek',
      source: 'user',
      agents: ['pi'],
      auth: { method: 'apiKey' },
      routing: {
        pi: {
          upstream: 'https://api.deepseek.com',
          authStrategy: 'api-key-header',
          piCatalogProviderId: 'deepseek',
        },
      },
      models: {
        pi: [{
          id: 'deepseek-v4-pro',
          name: 'DeepSeek V4 Pro',
          contextWindow: 1_000_000,
          efforts: ['high', 'max'],
          defaultEffort: 'high',
        }],
      },
    } as ProviderView;
    expect(providerViewToCustomProviderConfig(provider).runtimes.pi?.piCatalogProviderId)
      .toBe('deepseek');
  });
});

describe('providerViewToCustomProviderConfig', () => {
  it('restores the stored id for a legacy custom xai runtime projection', () => {
    const provider = {
      id: 'custom:xai',
      name: 'Legacy custom xAI',
      source: 'user',
      agents: ['codex'],
      auth: { method: 'apiKey' },
      access: { kind: 'api' },
      routing: {
        codex: {
          upstream: 'https://private-xai.example/v1',
          authStrategy: 'api-key-header',
        },
      },
      models: {
        codex: [
          {
            id: 'private-grok',
            name: 'Private Grok',
            contextWindow: 200_000,
            efforts: [],
            defaultEffort: null,
          },
        ],
      },
      connected: true,
    } satisfies ProviderView;

    expect(providerViewToCustomProviderConfig(provider).id).toBe('xai');
  });

  it('preserves no-auth and exact request-path fields through the edit round trip', () => {
    const provider = {
      id: 'local-chat',
      name: 'Local Chat',
      source: 'user',
      agents: ['codex'],
      auth: { method: 'none' },
      access: { kind: 'api' },
      routing: {
        codex: {
          upstream: 'http://127.0.0.1:4000/v1',
          authStrategy: 'none',
          wireProtocol: 'openai-chat',
          requestPath: '/tenant/acme/infer?stream=1',
          modelsUrl: 'http://127.0.0.1:4000/v1/models',
        },
      },
      models: {
        codex: [{
          id: 'local-model',
          name: 'Local Model',
          contextWindow: 200_000,
          efforts: [],
          defaultEffort: null,
        }],
      },
      connected: true,
    } satisfies ProviderView;

    expect(providerViewToCustomProviderConfig(provider)).toEqual({
      id: 'local-chat',
      name: 'Local Chat',
      auth: { method: 'none' },
      runtimes: {
        codex: {
          baseUrl: 'http://127.0.0.1:4000/v1',
          requestPath: '/tenant/acme/infer?stream=1',
          wireProtocol: 'openai-chat',
          modelsUrl: 'http://127.0.0.1:4000/v1/models',
          models: [{ id: 'local-model', name: 'Local Model' }],
        },
      },
    });
  });

  it('round-trips Pi reasoning efforts from a provider view', () => {
    const provider = {
      id: 'local-reasoning',
      name: 'Local Reasoning',
      source: 'user',
      agents: ['pi'],
      auth: { method: 'none' },
      access: { kind: 'api' },
      routing: {
        pi: {
          upstream: 'http://127.0.0.1:4000/v1',
          authStrategy: 'none',
          wireProtocol: 'openai-responses',
        },
      },
      models: {
        pi: [
          {
            id: 'reasoner',
            name: 'Reasoner',
            contextWindow: 200_000,
            efforts: ['low', 'high', 'xhigh'],
            defaultEffort: 'high',
          },
        ],
      },
      connected: true,
    } satisfies ProviderView;

    expect(providerViewToCustomProviderConfig(provider).runtimes.pi?.models).toEqual([
      {
        id: 'reasoner',
        name: 'Reasoner',
        reasoning: true,
        reasoningEfforts: ['low', 'high', 'xhigh'],
        reasoningDefaultEffort: 'high',
      },
    ]);
  });

  it('preserves non-secret presence metadata for main-only runtime headers', () => {
    const provider = {
      id: 'headered-provider',
      name: 'Headered provider',
      source: 'user',
      agents: ['codex'],
      auth: { method: 'apiKey' },
      routing: {
        codex: {
          upstream: 'https://api.example/v1',
          authStrategy: 'api-key-header',
          headerOverrideState: 'configured',
        },
      },
      models: {
        codex: [{
          id: 'model',
          name: 'Model',
          contextWindow: 200_000,
          efforts: [],
          defaultEffort: null,
        }],
      },
      connected: true,
    } satisfies ProviderView;

    expect(providerViewToCustomProviderConfig(provider).runtimes.codex).toMatchObject({
      headersState: 'configured',
    });
  });
});

describe('appendDiscoveredCustomProviderModels', () => {
  it('only appends unknown models and defaults them to hidden', () => {
    const result = appendDiscoveredCustomProviderModels(
      [{ id: 'kept', name: 'Kept' }],
      [
        { id: 'kept', name: 'New name' },
        { id: 'new', name: 'New' },
        { id: 'new', name: 'Duplicate new' },
        { id: '', name: 'Invalid' },
      ],
    );
    expect(result).toEqual({
      models: [
        { id: 'kept', name: 'Kept' },
        { id: 'new', name: 'New', defaultEnabled: false },
      ],
      addedIds: ['new'],
    });
  });

  it('carries the endpoint-declared contextWindow into appended models (#386)', () => {
    const result = appendDiscoveredCustomProviderModels(
      [],
      [
        { id: 'big', name: 'Big', contextWindow: 1_000_000 },
        { id: 'plain', name: 'Plain' },
        { id: 'bogus', name: 'Bogus', contextWindow: -1 },
      ],
    );
    expect(result.models).toEqual([
      { id: 'big', name: 'Big', contextWindow: 1_000_000, defaultEnabled: false },
      { id: 'plain', name: 'Plain', defaultEnabled: false },
      // 非法值不落盘,回落保守默认
      { id: 'bogus', name: 'Bogus', defaultEnabled: false },
    ]);
  });
});

describe('custom provider credential lifecycle', () => {
  it('maps the legacy runtime id back to its stored config and credential keys', async () => {
    const read = vi.fn(async () => 'legacy-key');
    const update = vi.fn(async () => ({ ok: true }));
    const remove = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('window', {
      electronAPI: {
        safeStorageRead: read,
        maker: {
          updateCustomProvider: update,
          deleteCustomProvider: remove,
        },
      },
    });
    const config = {
      id: 'custom:xai',
      name: 'Legacy custom xAI',
      runtimes: {
        codex: {
          baseUrl: 'https://private-xai.example/v1',
          models: [{ id: 'private-grok', name: 'Private Grok' }],
        },
      },
    };

    await expect(readCustomProviderKey('custom:xai', 'codex')).resolves.toBe('legacy-key');
    await updateCustomProvider(config, { codex: 'replacement-key' });
    await deleteCustomProvider('custom:xai');

    expect(read).toHaveBeenCalledWith(customProviderSecretStorageKey('xai', 'codex'));
    expect(update).toHaveBeenCalledWith({ ...config, id: 'xai' }, { codex: 'replacement-key' });
    expect(remove).toHaveBeenCalledWith('xai');
  });

  it('submits create config and keys through one main-process mutation', async () => {
    const create = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('window', {
      electronAPI: {
        maker: { createCustomProvider: create },
      },
    });

    const config = {
      id: 'new-provider',
      name: 'New provider',
      auth: { method: 'apiKey' as const },
      runtimes: {
        codex: {
          baseUrl: 'https://api.example/v1',
          models: [{ id: 'model', name: 'Model' }],
        },
      },
    };
    const keys = { codex: 'new-key' };
    await createCustomProvider(config, keys);

    expect(create).toHaveBeenCalledWith(config, keys);
  });

  it('surfaces an atomic main-process create failure', async () => {
    vi.stubGlobal('window', {
      electronAPI: {
        maker: {
          createCustomProvider: vi.fn().mockRejectedValue(
            new Error('credential staging failed'),
          ),
        },
      },
    });
    const config = {
      id: 'partial-create',
      name: 'Partial create',
      auth: { method: 'apiKey' as const },
      runtimes: {
        'claude-code': {
          baseUrl: 'https://api.example/v1',
          models: [{ id: 'claude-model', name: 'Claude model' }],
        },
        codex: {
          baseUrl: 'https://api.example/v1',
          models: [{ id: 'codex-model', name: 'Codex model' }],
        },
      },
    };

    await expect(createCustomProvider(config, {
      'claude-code': 'first-key',
      codex: 'second-key',
    })).rejects.toThrow('credential staging failed');
  });

  it('submits replacement keys with the config through one main-process mutation', async () => {
    const update = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('window', {
      electronAPI: {
        maker: { updateCustomProvider: update },
      },
    });

    const config = {
      id: 'switch-to-key',
      name: 'Switch to key',
      auth: { method: 'apiKey' as const },
      runtimes: {
        codex: {
          baseUrl: 'https://api.example/v1',
          models: [{ id: 'm1', name: 'M1' }],
        },
      },
    };
    await updateCustomProvider(
      config,
      { codex: 'replacement-key' },
    );

    expect(update).toHaveBeenCalledWith(config, { codex: 'replacement-key' });
  });

  it('surfaces an atomic main-process update failure', async () => {
    vi.stubGlobal('window', {
      electronAPI: {
        maker: {
          updateCustomProvider: vi.fn().mockRejectedValue(new Error('credential rollback failed')),
        },
      },
    });

    await expect(
      updateCustomProvider(
        {
          id: 'switch-to-key',
          name: 'Switch to key',
          auth: { method: 'apiKey' },
          runtimes: {
            codex: {
              baseUrl: 'https://api.example/v1',
              models: [{ id: 'm1', name: 'M1' }],
            },
          },
        },
        { codex: 'replacement-key' },
      ),
    ).rejects.toThrow('credential rollback failed');
  });
});
