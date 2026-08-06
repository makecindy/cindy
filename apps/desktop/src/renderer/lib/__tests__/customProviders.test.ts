import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  appendDiscoveredCustomProviderModels,
  createCustomProvider,
  customProviderModelConfigForSave,
  customProviderModelConfigFromCatalogModel,
  fillCustomProviderModelMetadata,
  fillCustomProviderModelsMetadata,
  fillMatchingCustomProviderPickerModels,
  mergeCustomProviderPickerSelection,
  providerViewToCustomProviderConfig,
  refreshCustomProviderModels,
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

type FetchProviderModelsInput = Parameters<
  typeof window.electronAPI.maker.fetchProviderModels
>[0];

afterEach(() => {
  vi.unstubAllGlobals();
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
    };
    expect(customProviderModelConfigFromCatalogModel(catalogModel, 'pi')).toEqual({
      id: 'reasoner',
      name: 'Reasoner',
      reasoning: true,
      reasoningEfforts: ['low', 'high', 'xhigh'],
    });
    expect(customProviderModelConfigFromCatalogModel(catalogModel, 'codex')).toEqual({
      id: 'reasoner',
      name: 'Reasoner',
    });
  });

  it('preserves provider modalities/capabilities through the edit round trip', () => {
    expect(customProviderModelConfigFromCatalogModel({
      id: 'vlm',
      name: 'VLM',
      contextWindow: 1_048_576,
      modalities: { input: ['text', 'image'], output: ['text'] },
      capabilities: { reasoning: true, toolCall: true },
    })).toEqual({
      id: 'vlm',
      name: 'VLM',
      contextWindow: 1_048_576,
      modalities: { input: ['text', 'image'], output: ['text'] },
      capabilities: { reasoning: true, toolCall: true },
    });
  });

  it('preserves provider maxOutput through the edit round trip', () => {
    expect(customProviderModelConfigFromCatalogModel({
      id: 'limited-output',
      name: 'Limited Output',
      contextWindow: 128_000,
      maxOutput: 8_192,
    })).toEqual({
      id: 'limited-output',
      name: 'Limited Output',
      contextWindow: 128_000,
      maxOutput: 8_192,
    });
  });
});

describe('CustomProviderDialog model metadata projection', () => {
  it('preserves model capability fields through the canonical no-op save projection', () => {
    const original: ProviderRuntimeModelConfig = {
      id: '  vlm  ',
      name: '  Vision Model  ',
      mode: 'responses',
      contextWindow: 1_048_576,
      maxOutput: 8_192,
      modalities: { input: ['text', 'image'], output: ['text'] },
      capabilities: { reasoning: true, toolCall: true, attachment: false },
      defaultEnabled: false,
      supportsImageInput: true,
      reasoning: true,
      reasoningEfforts: ['low', 'high'],
    };

    const saved = customProviderModelConfigForSave(original);

    expect(saved).toEqual({
      ...original,
      id: 'vlm',
      name: 'Vision Model',
    });
    expect(saved.modalities).not.toBe(original.modalities);
    expect(saved.capabilities).not.toBe(original.capabilities);
    expect(saved.reasoningEfforts).not.toBe(original.reasoningEfforts);
  });

  it('normalizes bounded provider modes and drops unsafe mode values on save', () => {
    expect(customProviderModelConfigForSave({
      id: 'm',
      name: 'M',
      mode: '  responses  ',
    })).toEqual({ id: 'm', name: 'M', mode: 'responses' });
    expect(customProviderModelConfigForSave({
      id: 'm',
      name: 'M',
      mode: 'x'.repeat(129),
    })).toEqual({ id: 'm', name: 'M' });
  });

  it('gap-fills resolved metadata without overriding existing facts or persisting unknown capabilities', () => {
    expect(fillCustomProviderModelMetadata(
      {
        id: 'vlm',
        name: 'VLM',
        mode: 'chat',
        contextWindow: 128_000,
        maxOutput: 16_384,
        modalities: { input: ['text'], output: ['text'] },
      },
      {
        mode: 'embedding',
        contextWindow: 1_048_576,
        maxOutput: 8_192,
        modalities: { input: ['text', 'image'], output: ['text'] },
        capabilities: { reasoning: true, toolCall: true, unknown: true },
      },
    )).toEqual({
      id: 'vlm',
      name: 'VLM',
      mode: 'embedding',
      contextWindow: 128_000,
      maxOutput: 8_192,
      modalities: { input: ['text'], output: ['text'] },
      capabilities: { reasoning: true, toolCall: true },
    });
  });

  it('replays metadata that arrived before picker rows were created', () => {
    const earlyResolved = [{
      id: 'model-a',
      mode: 'responses',
      contextWindow: 1_000_000,
      maxOutput: 16_384,
      capabilities: { reasoning: true },
    }];

    expect(fillCustomProviderModelsMetadata(
      [{ id: 'model-a', name: 'Model A' }],
      earlyResolved,
    )).toEqual([{
      id: 'model-a',
      name: 'Model A',
      mode: 'responses',
      contextWindow: 1_000_000,
      maxOutput: 16_384,
      capabilities: { reasoning: true },
    }]);
  });

  it('keeps the conservative maxOutput through picker confirmation while preserving form edits', () => {
    const result = mergeCustomProviderPickerSelection(
      [
        { id: 'edited', name: 'Edited Name', maxOutput: 16_384 },
        { id: 'late-manual', name: 'Late Manual', maxOutput: 2_048 },
      ],
      [
        { id: 'edited', name: 'Fetched Name', maxOutput: 8_192 },
        { id: 'resolved', name: 'Resolved', maxOutput: 16_384 },
        { id: 'unchecked', name: 'Unchecked', maxOutput: 32_768 },
      ],
      new Set(['edited', 'resolved']),
    );

    expect(result).toEqual([
      { id: 'edited', name: 'Edited Name', maxOutput: 8_192 },
      { id: 'resolved', name: 'Resolved', maxOutput: 16_384 },
      { id: 'late-manual', name: 'Late Manual', maxOutput: 2_048 },
    ]);
  });

  it('applies a late resolve push only to its exact request picker', () => {
    const picker = {
      requestId: 'request-new',
      agent: 'codex',
      models: [{ id: 'model-a', name: 'Model A' }],
      selected: new Set(['model-a']),
      query: '',
    };
    const resolved = [{ id: 'model-a', mode: 'responses' }];

    expect(fillMatchingCustomProviderPickerModels(
      picker,
      'request-new',
      'codex',
      resolved,
    )?.models).toEqual([{ id: 'model-a', name: 'Model A', mode: 'responses' }]);
    expect(fillMatchingCustomProviderPickerModels(
      picker,
      'request-old',
      'codex',
      resolved,
    )).toBe(picker);
    expect(fillMatchingCustomProviderPickerModels(
      picker,
      'request-new',
      'claude-code',
      resolved,
    )).toBe(picker);
  });
});

describe('providerViewToCustomProviderConfig', () => {
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
      },
    ]);
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
      changed: true,
    });
  });

  // #386「端点声明的 contextWindow 随发现落盘」的入参形状已改为 providerReported,
  // 同语义由下面 'persists provider-reported contextWindow into the config' 覆盖
  // (含非正数忽略),不再保留旧形状的重复用例。

  it('backfills provider-reported contextWindow onto existing models that lack one', () => {
    const result = appendDiscoveredCustomProviderModels(
      [
        { id: 'has', name: 'Has', contextWindow: 128_000 }, // 已有值 → 不覆盖
        { id: 'gap', name: 'Gap' }, // 缺失 + 厂商上报 → 回填
        { id: 'nogap', name: 'NoGap' }, // 缺失但厂商未上报 → 不动
      ],
      [
        { id: 'has', name: 'Has', providerReported: { contextWindow: 999_999 } },
        { id: 'gap', name: 'Gap', providerReported: { contextWindow: 1_000_000 } },
        { id: 'nogap', name: 'NoGap' },
      ],
    );
    expect(result).toEqual({
      models: [
        { id: 'has', name: 'Has', contextWindow: 128_000 },
        { id: 'gap', name: 'Gap', contextWindow: 1_000_000 },
        { id: 'nogap', name: 'NoGap' },
      ],
      addedIds: [],
      changed: true,
    });
  });

  it('reports changed=false when there is nothing to add or backfill', () => {
    const result = appendDiscoveredCustomProviderModels(
      [{ id: 'a', name: 'A', contextWindow: 128_000 }],
      [{ id: 'a', name: 'A', providerReported: { contextWindow: 999_999 } }],
    );
    expect(result).toEqual({
      models: [{ id: 'a', name: 'A', contextWindow: 128_000 }],
      addedIds: [],
      changed: false,
    });
  });

  it('persists provider-reported contextWindow into the config (survives restart / feeds save-resolve)', () => {
    const result = appendDiscoveredCustomProviderModels(
      [],
      [
        { id: 'a', name: 'A', providerReported: { contextWindow: 1_000_000 } },
        { id: 'b', name: 'B' }, // 无上报 → 不写假窗口
        { id: 'c', name: 'C', providerReported: { contextWindow: 0 } }, // 非正数忽略
      ],
    );
    expect(result.models).toEqual([
      { id: 'a', name: 'A', defaultEnabled: false, contextWindow: 1_000_000 },
      { id: 'b', name: 'B', defaultEnabled: false },
      { id: 'c', name: 'C', defaultEnabled: false },
    ]);
  });

  it('persists maxOutput, accepts lower limits, and never auto-raises an existing limit', () => {
    const result = appendDiscoveredCustomProviderModels(
      [
        { id: 'kept', name: 'Kept', maxOutput: 4_096 },
        { id: 'lowered', name: 'Lowered', maxOutput: 16_384 },
        { id: 'gap', name: 'Gap' },
      ],
      [
        { id: 'kept', name: 'Kept', providerReported: { maxOutput: 16_384 } },
        { id: 'lowered', name: 'Lowered', providerReported: { maxOutput: 8_192 } },
        { id: 'gap', name: 'Gap', providerReported: { maxOutput: 8_192 } },
        { id: 'fresh', name: 'Fresh', providerReported: { maxOutput: 32_768 } },
        { id: 'invalid', name: 'Invalid', providerReported: { maxOutput: Number.POSITIVE_INFINITY } },
      ],
    );

    expect(result.models).toEqual([
      { id: 'kept', name: 'Kept', maxOutput: 4_096 },
      { id: 'lowered', name: 'Lowered', maxOutput: 8_192 },
      { id: 'gap', name: 'Gap', maxOutput: 8_192 },
      { id: 'fresh', name: 'Fresh', defaultEnabled: false, maxOutput: 32_768 },
      { id: 'invalid', name: 'Invalid', defaultEnabled: false },
    ]);
    expect(result.changed).toBe(true);
  });

  it('persists provider-reported mode so non-chat classification survives restart', () => {
    const result = appendDiscoveredCustomProviderModels(
      [
        { id: 'existing-chat', name: 'Existing Chat', mode: 'chat' },
        { id: 'existing-embedding', name: 'Existing Embedding', mode: 'embedding' },
      ],
      [
        {
          id: 'existing-chat',
          name: 'Existing Chat',
          providerReported: { mode: 'embedding' },
        },
        {
          id: 'existing-embedding',
          name: 'Existing Embedding',
          providerReported: { mode: 'chat' },
        },
        { id: 'new-responses', name: 'New Responses', providerReported: { mode: 'responses' } },
      ],
    );
    expect(result.models).toEqual([
      { id: 'existing-chat', name: 'Existing Chat', mode: 'embedding' },
      { id: 'existing-embedding', name: 'Existing Embedding', mode: 'chat' },
      { id: 'new-responses', name: 'New Responses', mode: 'responses', defaultEnabled: false },
    ]);
    expect(result.changed).toBe(true);
  });

  it('persists provider-reported modalities/capabilities on new models, narrowing unknown capability keys', () => {
    const result = appendDiscoveredCustomProviderModels(
      [],
      [
        {
          id: 'vlm',
          name: 'VLM',
          providerReported: {
            contextWindow: 1_048_576,
            modalities: { input: ['text', 'image'], output: ['text'] },
            // 宽松上报:只保留已知 boolean 键,丢弃未知键与非 boolean。
            capabilities: { reasoning: true, toolCall: false, bogus: 'x', temperature: 1 },
          },
        },
      ],
    );
    expect(result.models).toEqual([
      {
        id: 'vlm',
        name: 'VLM',
        defaultEnabled: false,
        contextWindow: 1_048_576,
        modalities: { input: ['text', 'image'], output: ['text'] },
        capabilities: { reasoning: true, toolCall: false },
      },
    ]);
    expect(result.changed).toBe(true);
  });

  it('backfills modalities/capabilities onto existing models that lack them, per field', () => {
    const result = appendDiscoveredCustomProviderModels(
      [
        // 已有 modalities → 不覆盖;缺 capabilities → 回填。
        { id: 'has-mod', name: 'HasMod', modalities: { input: ['text'], output: ['text'] } },
        // 三者皆缺 → 全部回填。
        { id: 'bare', name: 'Bare' },
      ],
      [
        {
          id: 'has-mod',
          name: 'HasMod',
          providerReported: {
            modalities: { input: ['text', 'image'], output: ['text'] }, // 应被忽略(已有)
            capabilities: { toolCall: true },
          },
        },
        {
          id: 'bare',
          name: 'Bare',
          providerReported: {
            contextWindow: 262_144,
            modalities: { input: ['text'], output: ['text'] },
            capabilities: { reasoning: true },
          },
        },
      ],
    );
    expect(result.models).toEqual([
      {
        id: 'has-mod',
        name: 'HasMod',
        modalities: { input: ['text'], output: ['text'] },
        capabilities: { toolCall: true },
      },
      {
        id: 'bare',
        name: 'Bare',
        contextWindow: 262_144,
        modalities: { input: ['text'], output: ['text'] },
        capabilities: { reasoning: true },
      },
    ]);
    expect(result.addedIds).toEqual([]);
    expect(result.changed).toBe(true);
  });
});

describe('refreshCustomProviderModels', () => {
  function twoAgentProvider(): ProviderView {
    const model = {
      id: 'shared-model',
      name: 'Shared Model',
      contextWindow: 200_000,
      efforts: [],
      defaultEffort: null,
    };
    return {
      id: 'openrouter',
      name: 'OpenRouter',
      source: 'user',
      agents: ['claude-code', 'codex'],
      auth: { method: 'apiKey' },
      access: { kind: 'api' },
      routing: {
        'claude-code': {
          upstream: 'https://openrouter.example/v1',
          authStrategy: 'api-key-header',
          wireProtocol: 'anthropic-messages',
        },
        codex: {
          upstream: 'https://openrouter.example/v1',
          authStrategy: 'api-key-header',
          wireProtocol: 'openai-responses',
        },
      },
      models: {
        'claude-code': [{ ...model }],
        codex: [{ ...model }],
      },
      connected: true,
    };
  }

  it('defers per-agent resolve and executes one saved-provider batch when config is unchanged', async () => {
    const fetchProviderModels = vi.fn(async (_input: FetchProviderModelsInput) => ({
      ok: true,
      models: [{ id: 'shared-model', name: 'Shared Model' }],
    }));
    const resolveSavedProviderModels = vi.fn(async () => ({ ok: true as const }));
    const update = vi.fn(async () => ({ ok: true as const }));
    vi.stubGlobal('window', {
      electronAPI: {
        safeStorageRead: vi.fn(async () => 'provider-key'),
        maker: {
          fetchProviderModels,
          resolveSavedProviderModels,
          updateCustomProvider: update,
        },
      },
    });

    await expect(refreshCustomProviderModels(twoAgentProvider())).resolves.toEqual({
      ok: true,
      added: 0,
      changed: false,
    });
    expect(fetchProviderModels).toHaveBeenCalledTimes(2);
    expect(fetchProviderModels.mock.calls.map(([input]) => input)).toEqual([
      expect.objectContaining({
        agent: 'claude-code',
        savedProviderId: 'openrouter',
        deferResolve: true,
      }),
      expect.objectContaining({
        agent: 'codex',
        savedProviderId: 'openrouter',
        deferResolve: true,
      }),
    ]);
    expect(resolveSavedProviderModels).toHaveBeenCalledOnce();
    expect(resolveSavedProviderModels).toHaveBeenCalledWith('openrouter');
    expect(update).not.toHaveBeenCalled();
  });

  it('persists all agent discoveries once and lets update trigger the single save-resolve batch', async () => {
    const fetchProviderModels = vi.fn(async ({ agent }: FetchProviderModelsInput) => ({
      ok: true,
      models: [
        { id: 'shared-model', name: 'Shared Model' },
        { id: `${agent}-new`, name: `${agent} New` },
      ],
    }));
    const resolveSavedProviderModels = vi.fn(async () => ({ ok: true as const }));
    const update = vi.fn(async () => ({ ok: true as const }));
    vi.stubGlobal('window', {
      electronAPI: {
        safeStorageRead: vi.fn(async () => 'provider-key'),
        maker: {
          fetchProviderModels,
          resolveSavedProviderModels,
          updateCustomProvider: update,
        },
      },
    });

    await expect(refreshCustomProviderModels(twoAgentProvider())).resolves.toEqual({
      ok: true,
      added: 2,
      changed: true,
    });
    expect(fetchProviderModels).toHaveBeenCalledTimes(2);
    expect(fetchProviderModels.mock.calls.every(([input]) => input.deferResolve === true)).toBe(true);
    expect(update).toHaveBeenCalledOnce();
    expect(resolveSavedProviderModels).not.toHaveBeenCalled();
  });
});

describe('custom provider credential lifecycle', () => {
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
