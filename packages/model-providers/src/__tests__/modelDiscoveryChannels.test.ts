import { describe, expect, it } from 'vitest';
import { parseModelsListResponse } from '../modelDiscovery.js';
import { mergeDiscoveredRuntimeModels } from '../modelMetadataLayers.js';
import { buildUserProvider } from '../user-provider.js';
import { BUNDLED_CATALOG } from '../catalog.js';

describe('shared provider discovery', () => {
  it('retains the working window when a refresh only reports maximum capacity', () => {
    const original = parseModelsListResponse({ data: [{ id: 'private-model',
      context_window: 272000, max_context_window: 1050000 }] })!;
    const refresh = parseModelsListResponse({ data: [{ id: 'private-model',
      max_context_window: 2000000 }] })!;
    expect(refresh[0].contextWindow).toBeUndefined();
    expect(refresh[0].discoveredMetadata?.contextWindow).toBeUndefined();
    const models = mergeDiscoveredRuntimeModels(original, refresh);
    expect(models[0].discoveredMetadata).toMatchObject({ contextWindow: 272000, contextWindowMax: 2000000 });
    for (const agent of ['claude-code', 'codex', 'pi'] as const) {
      const provider = buildUserProvider({ id: 'relay', name: 'Relay', runtimes: {
        [agent]: { baseUrl: 'https://relay.example/v1', models },
      } });
      expect(provider.models[agent]?.[0]).toMatchObject({ contextWindow: 272000, contextWindowMax: 2000000 });
    }
  });

  it('shrinks a saved discovered working window when a max-only refresh reduces capacity', () => {
    const original = mergeDiscoveredRuntimeModels([], parseModelsListResponse({ data: [
      { id: 'private-model', context_window: 128000, max_context_window: 256000 },
    ] })!);
    const refreshed = mergeDiscoveredRuntimeModels(original, parseModelsListResponse({ data: [
      { id: 'private-model', max_context_window: 64000 },
    ] })!);
    expect(original[0].discoveredMetadata?.contextWindow).toBe(128000);
    expect(refreshed[0].discoveredMetadata).toMatchObject({ contextWindow: 64000, contextWindowMax: 64000 });
    for (const agent of ['claude-code', 'codex', 'pi'] as const) {
      const provider = buildUserProvider({ id: 'relay', name: 'Relay', runtimes: {
        [agent]: { baseUrl: 'https://relay.example/v1', models: refreshed },
      } });
      expect(provider.models[agent]?.[0]).toMatchObject({ contextWindow: 64000, contextWindowMax: 64000 });
    }
  });

  it('uses max-only discovery as the first working window, ahead of inherited defaults', () => {
    const discovered = parseModelsListResponse({ data: [{ id: 'gpt-9-sol', max_context_window: 32000 }] })!;
    for (const models of [discovered, mergeDiscoveredRuntimeModels([], discovered)]) {
      for (const agent of ['claude-code', 'codex', 'pi'] as const) {
        const provider = buildUserProvider({ id: 'relay', name: 'Relay', runtimes: {
          [agent]: { baseUrl: 'https://relay.example/v1', wireProtocol: 'openai-responses', models },
        } }, { modelRegistry: BUNDLED_CATALOG.modelRegistry });
        expect(provider.models[agent]?.[0]).toMatchObject({
          contextWindow: 32000, contextWindowMax: 32000, contextWindowVerified: true,
        });
      }
    }
    const saved = mergeDiscoveredRuntimeModels([], discovered);
    const refreshed = mergeDiscoveredRuntimeModels(saved, parseModelsListResponse({ data: [
      { id: 'gpt-9-sol', max_context_window: 64000 },
    ] })!);
    expect(refreshed[0].discoveredMetadata).toMatchObject({ contextWindow: 32000, contextWindowMax: 64000 });
  });

  it('imports Vercel token prices, output capacity, image inputs and declared effort levels', () => {
    const models = parseModelsListResponse({ data: [{ id: 'vendor/new', name: 'New', type: 'language',
      context_window: 128000, max_tokens: 32000,
      modalities: { input: ['text', 'image'], output: ['text'] },
      reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'xhigh'] }],
      pricing: { input: '0.000001', output: '0.000003', input_cache_read: '0' },
    }] }, 'https://ai-gateway.vercel.sh/v1/models')!;
    for (const agent of ['claude-code', 'codex', 'pi'] as const) {
      const provider = buildUserProvider({ id: 'my-gateway', name: 'Gateway', runtimes: {
        [agent]: { baseUrl: 'https://ai-gateway.vercel.sh/v1', models },
      } });
      expect(provider.models[agent]?.[0]).toMatchObject({ supportsImageInput: true,
        contextWindow: 128000, maxOutput: 32000, efforts: ['low', 'medium', 'xhigh'],
        cost: { input: 1, output: 3, cacheRead: 0 } });
    }
  });
  it('keeps Google embedding models out of chat discovery', () => {
    const models = parseModelsListResponse({ models: [
      { name: 'models/gemini-3.5-flash', displayName: 'Gemini', supportedGenerationMethods: ['generateContent', 'countTokens'] },
      { name: 'models/text-embedding-004', displayName: 'Embedding', supportedGenerationMethods: ['embedContent', 'batchEmbedContents'] },
      { name: 'models/aqa', displayName: 'AQA', supportedGenerationMethods: ['generateAnswer'] },
    ] });
    expect(models?.map(model => model.id)).toEqual(['gemini-3.5-flash']);
  });
  it('keeps non-language Vercel models out of chat and does not treat per-image prices as tokens', () => {
    expect(parseModelsListResponse({ data: [{ id: 'vendor/image', type: 'image',
      modalities: { input: ['text'], output: ['image'] }, pricing: { output: '0.04' },
    }] }, 'https://ai-gateway.vercel.sh/v1/models')).toEqual([]);
  });
  it('preserves IDs on LiteLLM aliases and reads its declared model info', () => {
    const [m] = parseModelsListResponse({ data: [{ model_name: 'my-team-model',
      litellm_params: { model: 'provider/actual-id' },
      model_info: { max_input_tokens: 128000, max_output_tokens: 8192,
        supports_vision: true, supports_function_calling: true },
    }] })!;
    expect(m.id).toBe('my-team-model');
    expect(m.discoveredMetadata).toMatchObject({ contextWindow: 128000, maxOutputTokens: 8192,
      supportsImageInput: true, supportsToolCalls: true });
  });
  it('reads LM Studio keys/capabilities, and accepts plain compatible inventories', () => {
    expect(parseModelsListResponse({ models: [{ key: 'local/model', display_name: 'Local',
      max_context_length: 65536, capabilities: { vision: false, trained_for_tool_use: true },
    }] })?.[0]).toMatchObject({ id: 'local/model', name: 'Local', discoveredMetadata: {
      contextWindow: 65536, supportsImageInput: false, supportsToolCalls: true,
    } });
    for (const payload of [{ data: [{ id: 'local-id' }] }, { models: ['local-id'] }, ['local-id']]) {
      expect(parseModelsListResponse(payload)?.map(m => m.id)).toEqual(['local-id']);
      expect(parseModelsListResponse(payload)?.[0].discoveredMetadata?.supportsImageInput).toBeUndefined();
    }
  });
  it('does not invent prices for another host or overwrite explicit false', () => {
    const payload = { data: [{ id: 'new', supports_image_input: false,
      modalities: { input: ['text', 'image'], output: ['text'] }, pricing: { input: '1', output: '2' } }] };
    expect(parseModelsListResponse(payload, 'https://proxy.example/v1/models')?.[0])
      .toMatchObject({ discoveredMetadata: { supportsImageInput: false } });
    expect(parseModelsListResponse(payload, 'https://proxy.example/v1/models')?.[0].discoveredCost).toBeUndefined();
  });
  it('retains cached capabilities on ID-only refresh, while accepting explicit changes', () => {
    const old = [{ id: 'new', name: 'New', supportsImageInput: true, discoveredMetadata: {
      supportsImageInput: true, contextWindow: 64000,
    } }];
    const retained = mergeDiscoveredRuntimeModels(old, parseModelsListResponse({ data: [{ id: 'new' }] })!);
    expect(retained[0].discoveredMetadata).toEqual(old[0].discoveredMetadata);
    const updated = mergeDiscoveredRuntimeModels(retained, [{ id: 'new', name: 'New',
      discoveredMetadata: { supportsImageInput: false } }]);
    expect(updated[0].discoveredMetadata).toEqual({ supportsImageInput: false, contextWindow: 64000 });
    expect(updated[0].supportsImageInput).toBe(true);
  });
});


it('does not offer thinking when a complete parameter list explicitly excludes it', () => {
  const models = parseModelsListResponse({ data: [
    { id: 'plain-model', supported_parameters: ['tools', 'temperature'], context_length: 32000 },
    { id: 'undocumented-model' },
    { id: 'reasoning-model', supported_parameters: ['tools', 'reasoning_effort'] },
  ] });
  expect(models?.[0]?.discoveredMetadata?.efforts).toEqual([]);
  expect(models?.[1]?.discoveredMetadata?.efforts).toBeUndefined();
  expect(models?.[2]?.discoveredMetadata?.efforts).toBeUndefined();
});


describe('Sub2API Codex manifest reasoning', () => {
  // Sub2API configuredCodexModelDescriptor uses slug, supported_reasoning_levels
  // ({ effort, description } objects) and default_reasoning_level.
  it.each(['models', 'data'] as const)('imports declared efforts from the %s envelope into all engines', (envelope) => {
    for (const id of ['gpt-6-sol', 'gpt-6-luna', 'team-coding-model']) {
      const models = parseModelsListResponse({ [envelope]: [{
        ...(envelope === 'models' ? { slug: id } : { id }),
        display_name: id,
        supported_reasoning_levels: [{ effort: 'high', description: 'High' }, { effort: 'max', description: 'Maximum' }],
        default_reasoning_level: 'high',
      }] })!;
      expect(models[0].discoveredMetadata).toMatchObject({ efforts: ['high', 'max'], defaultEffort: 'high' });
      for (const agent of ['claude-code', 'codex', 'pi'] as const) {
        for (const modelRegistry of [undefined, BUNDLED_CATALOG.modelRegistry]) {
          const provider = buildUserProvider({ id: 'custom-sub2api', name: 'Sub2API', runtimes: {
            [agent]: { baseUrl: 'https://relay.example/v1', models: mergeDiscoveredRuntimeModels([], models) },
          } }, { modelRegistry });
          expect(provider.models[agent]?.[0]).toMatchObject({ id, efforts: ['high', 'max'], defaultEffort: 'high' });
        }
      }
    }
  });

  it('keeps absent, invalid, empty and none-only declarations distinct', () => {
    const entries = [
      {},
      { supported_reasoning_levels: null },
      { supported_reasoning_levels: [{ description: 'missing effort' }] },
      { supported_reasoning_levels: [] },
      { supported_reasoning_levels: [{ effort: 'none' }], default_reasoning_level: 'none' },
      { supported_reasoning_levels: ['none', 'low', 'high'], default_reasoning_level: 'high' },
      { supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }], default_reasoning_level: null },
    ];
    const models = parseModelsListResponse({ models: entries.map((entry, i) => ({ slug: `model-${i}`, ...entry })) })!;
    expect(models.map(model => model.discoveredMetadata?.efforts))
      .toEqual([undefined, undefined, undefined, [], [], ['low', 'high'], ['low', 'high']]);
    expect(models[4].discoveredMetadata?.defaultEffort).toBeNull();
    expect(models[5].discoveredMetadata?.defaultEffort).toBe('high');
    expect(models[6].discoveredMetadata?.defaultEffort).toBeNull();
  });

  it('preserves existing reasoning fields when both formats are present', () => {
    const [model] = parseModelsListResponse({ data: [{ id: 'gpt-6-sol',
      reasoning: { supportedEfforts: [], defaultEffort: null },
      supported_reasoning_levels: [{ effort: 'high' }], default_reasoning_level: 'high',
    }] })!;
    expect(model.discoveredMetadata).toMatchObject({ efforts: [], defaultEffort: null });
  });
});

describe('Sub2API Grok model discovery', () => {
  it.each(['grok-4.6', 'grok-4.7', 'team-grok'])('imports and refreshes %s without rewriting user choices', id => {
    const payload = { data: [{ id, supportsReasoningEffort: true, reasoningEffort: 'high',
      reasoningEfforts: [
        { value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' },
        { value: 'high', label: 'High', default: true }, { value: 'xhigh', label: 'xHigh' },
      ],
    }] };
    const discovered = parseModelsListResponse(payload)!;
    expect(discovered[0].discoveredMetadata).toMatchObject({
      efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high',
    });
    const models = mergeDiscoveredRuntimeModels([{ id, name: 'My model', discoveredMetadata: {} }], discovered);
    // Refresh must repair old name-only imports and survive configuration serialization.
    for (const agent of ['claude-code', 'codex', 'pi'] as const) {
      const config = { id: 'sub2api', name: 'Relay', runtimes: {
        [agent]: { baseUrl: 'https://relay.example/v1', models },
      } };
      const provider = buildUserProvider(JSON.parse(JSON.stringify(config)));
      expect(provider.models[agent]?.[0]).toMatchObject({ id,
        efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high',
      });
    }
    const overridden = mergeDiscoveredRuntimeModels([{ id, name: id, reasoning: false }], discovered);
    expect(buildUserProvider({ id: 'sub2api', name: 'Relay', runtimes: {
      codex: { baseUrl: 'https://relay.example/v1', models: overridden },
    } }).models.codex?.[0]).toMatchObject({ efforts: [], defaultEffort: null });
  });

  it('does not invent levels from the support flag and respects explicit disabling', () => {
    const models = parseModelsListResponse({ data: [
      { id: 'unknown', supportsReasoningEffort: true, reasoningEffort: 'high' },
      { id: 'disabled', supportsReasoningEffort: false, reasoningEfforts: [{ value: 'high' }] },
      { id: 'empty', supportsReasoningEffort: true, reasoningEfforts: [] },
      { id: 'invalid', reasoningEfforts: [{ label: 'High' }] },
      { id: 'strings', reasoningEfforts: ['low', 'high'], reasoningEffort: null },
      { id: 'canonical', reasoning: { supportedEfforts: ['low'], defaultEffort: null },
        reasoningEfforts: [{ value: 'high' }], reasoningEffort: 'high' },
    ] })!;
    expect(models.map(model => model.discoveredMetadata?.efforts))
      .toEqual([undefined, [], [], undefined, ['low', 'high'], ['low']]);
    expect(models[4].discoveredMetadata?.defaultEffort).toBeNull();
    expect(models[5].discoveredMetadata?.defaultEffort).toBeNull();
  });
});

describe('Sub2API manifest capabilities', () => {
  it('preserves vision, Fast and capacity separately through save and refresh for every engine', () => {
    const discovered = parseModelsListResponse({ models: [{ slug: 'private-model',
      context_window: 272000, max_context_window: 1050000,
      input_modalities: ['text', 'image'], service_tiers: [{ id: 'priority', name: 'Fast' }],
    }] })!;
    const saved = JSON.parse(JSON.stringify(mergeDiscoveredRuntimeModels([], discovered)));
    const refreshed = mergeDiscoveredRuntimeModels(saved, parseModelsListResponse({ data: [{ id: 'private-model' }] })!);
    for (const agent of ['claude-code', 'codex', 'pi'] as const) {
      const provider = buildUserProvider({ id: 'relay', name: 'Relay', runtimes: {
        [agent]: { baseUrl: 'https://relay.example/v1', models: refreshed },
      } });
      expect(provider.models[agent]?.[0]).toMatchObject({ contextWindow: 272000,
        contextWindowMax: 1050000, supportsFastMode: true, supportsImageInput: true });
    }
  });
  it('distinguishes omitted, malformed, disabled and explicit canonical capability fields', () => {
    const values = [ {}, { input_modalities: [null], service_tiers: [{}], max_context_window: -1 },
      { input_modalities: [], service_tiers: [] },
      { supports_image_input: false, supports_fast_mode: false,
        input_modalities: ['image'], service_tiers: [{ id: 'priority' }] },
      { context_window: 100000, max_context_window: 32000 },
    ];
    const models = parseModelsListResponse({ models: values.map((value, i) => ({ slug: `model-${i}`, ...value })) })!;
    expect(models.map(m => m.discoveredMetadata?.supportsImageInput)).toEqual([undefined, undefined, false, false, undefined]);
    expect(models.map(m => m.discoveredMetadata?.supportsFastMode)).toEqual([undefined, undefined, false, false, undefined]);
    expect(models.every(m => m.discoveredMetadata?.contextWindowMax === undefined)).toBe(true);
  });
});
