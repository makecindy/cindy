import { describe, expect, it } from 'vitest';
import { parseModelsListResponse } from '../modelDiscovery.js';
import { mergeDiscoveredRuntimeModels } from '../modelMetadataLayers.js';
import { buildUserProvider } from '../user-provider.js';

describe('shared provider discovery', () => {
  it('imports Grok option objects and Codex Sol/Luna levels without model-name heuristics', () => {
    const levels = ['low', 'medium', 'high', 'xhigh', 'max'];
    const models = parseModelsListResponse({ models: [
      { id: 'grok-4.6', supportsReasoningEffort: true, reasoningEffort: 'high',
        reasoningEfforts: levels.slice(0, 4).map(value => ({ value, label: value })) },
      ...['gpt-6-sol', 'gpt-6-luna', 'unknown-model'].map(slug => ({ slug,
        supported_reasoning_levels: levels.map(effort => ({ effort, description: effort })),
        default_reasoning_level: 'medium',
      })),
    ] })!;
    expect(models[0].discoveredMetadata).toMatchObject({ efforts: levels.slice(0, 4), defaultEffort: 'high' });
    for (const model of models.slice(1)) {
      expect(model.discoveredMetadata).toMatchObject({ efforts: levels, defaultEffort: 'medium' });
    }
    const refreshed = mergeDiscoveredRuntimeModels([
      { id: 'gpt-6-luna', name: 'Luna', reasoning: true, reasoningEfforts: ['low'], reasoningDefaultEffort: 'low' },
    ], models);
    expect(refreshed.find(model => model.id === 'gpt-6-luna')).toMatchObject({
      reasoningEfforts: ['low'], reasoningDefaultEffort: 'low',
      discoveredMetadata: { efforts: levels, defaultEffort: 'medium' },
    });
    const provider = buildUserProvider({ id: 'proxy', name: 'Proxy', runtimes: {
      codex: { baseUrl: 'https://proxy.example/v1', models: refreshed },
    } });
    expect(provider.models.codex?.find(model => model.id === 'gpt-6-sol'))
      .toMatchObject({ efforts: levels, defaultEffort: 'medium' });
    expect(provider.models.codex?.find(model => model.id === 'gpt-6-luna'))
      .toMatchObject({ efforts: ['low'], defaultEffort: 'low' });
  });

  it.each(['reasoningEfforts', 'supported_reasoning_levels'])('handles empty, unknown and off levels in %s', field => {
    const metadata = (value: unknown) => parseModelsListResponse({ data: [{ id: 'model', [field]: value }] })![0].discoveredMetadata;
    expect(metadata([])?.efforts).toEqual([]);
    expect(metadata(['none'])?.efforts).toEqual([]);
    expect(metadata(['future', {}, null])?.efforts).toBeUndefined();
    expect(metadata('high')?.efforts).toBeUndefined();
    expect(metadata(['none', 'low', 'future', 'low', { value: 'high' }])?.efforts).toEqual(['low', 'high']);
    const refreshed = parseModelsListResponse({ data: [{ id: 'model', [field]: ['future'] }] })!;
    expect(mergeDiscoveredRuntimeModels([{ id: 'model', name: 'Model', discoveredMetadata: { efforts: ['high'] } }], refreshed)[0]
      .discoveredMetadata?.efforts).toEqual(['high']);
  });

  it('honors explicit disable, null defaults, canonical fields and option defaults', () => {
    const metadata = (fields: object) => parseModelsListResponse({ data: [{ id: 'model', ...fields }] })![0].discoveredMetadata;
    expect(metadata({ supportsReasoningEffort: false, reasoningEfforts: ['high'] })?.efforts).toEqual([]);
    expect(metadata({ supported_reasoning_levels: ['none'], default_reasoning_level: 'none' }))
      .toMatchObject({ efforts: [], defaultEffort: null });
    expect(metadata({ reasoning: { supportedEfforts: [], defaultEffort: null }, reasoningEfforts: ['high'], reasoningEffort: 'high' }))
      .toMatchObject({ efforts: [], defaultEffort: null });
    expect(metadata({ reasoningEfforts: [{ value: 'high', default: true }] })?.defaultEffort).toBe('high');
    expect(metadata({ default_reasoning_level: null, reasoningEffort: 'high' })?.defaultEffort).toBeNull();
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
