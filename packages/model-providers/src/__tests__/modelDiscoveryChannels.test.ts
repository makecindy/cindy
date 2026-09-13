import { describe, expect, it } from 'vitest';
import { parseModelsListResponse } from '../modelDiscovery.js';
import { mergeDiscoveredRuntimeModels } from '../modelMetadataLayers.js';
import { buildUserProvider } from '../user-provider.js';

describe('shared provider discovery', () => {
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
  it('keeps non-language Vercel models out of chat and does not treat per-image prices as tokens', () => {
    const [m] = parseModelsListResponse({ data: [{ id: 'vendor/image', type: 'image',
      modalities: { input: ['text'], output: ['image'] }, pricing: { output: '0.04' },
    }] }, 'https://ai-gateway.vercel.sh/v1/models')!;
    expect(m.discoveredMetadata?.mode).toBe('image');
    expect(m.discoveredCost).toBeUndefined();
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
