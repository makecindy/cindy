import { describe, expect, it } from 'vitest';
import { parseModelsListResponse } from '../modelDiscovery.js';
import { mergeDiscoveredRuntimeModels } from '../modelMetadataLayers.js';
import { buildUserProvider } from '../user-provider.js';
import { BUNDLED_CATALOG } from '../catalog.js';

describe('shared provider discovery', () => {
  // #11446 / #8311, unit: real discovery -> refresh -> JSON save -> three engines.
  // Previous coverage only exercised Go; Zen's image/jpeg persisted false.
  it.each([
    ['https://opencode.ai/zen/go/v1/models', 'deepseek-v4.1-flash', 1_000_000],
    ['https://opencode.ai/inference/go/v1/models', 'deepseek-v4.1-flash', 1_000_000],
    ['https://opencode.ai/zen/v1/models', 'deepseek-v4.1-flash-free', 200_000],
    ['https://opencode.ai/inference/v1/models', 'deepseek-v4.1-flash-free', 200_000],
  ])('restores OpenCode MIME image input on refresh without changing user denials: %s', (sourceUrl, id, context) => {
    const discovered = parseModelsListResponse({ data: [
      { id, limit: { context, output: 32_000 },
        modalities: { input: ['text', 'image/jpeg', 'image/png', 'image/gif', 'image/webp'], output: ['text'] } },
      { id: 'deepseek-v4-pro', modalities: { input: ['text'], output: ['text'] } },
    ] }, sourceUrl)!;
    expect(discovered[0].discoveredMetadata).toMatchObject({ supportsImageInput: true,
      modalities: { input: ['text', 'image'], output: ['text'] } });
    const previous = [{ id, name: id, discoveredMetadata: { supportsImageInput: false } }];
    const models = JSON.parse(JSON.stringify(mergeDiscoveredRuntimeModels(previous, discovered)));
    const runtime = { baseUrl: sourceUrl.replace(/\/models$/, ''), models };
    for (const agent of ['claude-code', 'codex', 'pi'] as const) {
      const provider = buildUserProvider({ id: 'opencode', name: 'OpenCode', runtimes: { [agent]: runtime } });
      expect(provider.models[agent]?.find(model => model.id === id)).toMatchObject({
        supportsImageInput: true, contextWindow: context, maxOutput: 32_000,
      });
      expect(provider.models[agent]?.find(model => model.id === 'deepseek-v4-pro')?.supportsImageInput).toBe(false);
      const disabled = buildUserProvider({ id: 'opencode', name: 'OpenCode', runtimes: { [agent]: {
        ...runtime, models: models.map((model: typeof previous[number]) => ({ ...model, supportsImageInput: false })),
      } } });
      expect(disabled.models[agent]?.find(model => model.id === id)?.supportsImageInput).toBe(false);
    }
    expect(previous[0].discoveredMetadata.supportsImageInput).toBe(false);
  });

  it('keeps coarse OpenCode media types while excluding document MIME from vision', () => {
    for (const sourceUrl of ['https://opencode.ai/zen/go/v1/models', 'https://opencode.ai/zen/v1/models']) {
      const [model] = parseModelsListResponse({ data: [{ id: 'media-model', modalities: {
        input: ['text', 'audio/wav', 'video/mp4', 'application/pdf'], output: ['image/png', 'image'],
      } }] }, sourceUrl)!;
      expect(model.discoveredMetadata).toMatchObject({ supportsImageInput: false,
        modalities: { input: ['text', 'audio', 'video'], output: ['image'] } });
    }
  });

  it.each([
    { input: ['text', 'application/pdf'], output: ['image/png'] },
    { input: ['text'], output: ['image/png'] },
  ])('does not infer OpenCode image input from PDF or output MIME: %j', modalities => {
    for (const sourceUrl of ['https://opencode.ai/zen/go/v1/models', 'https://opencode.ai/zen/v1/models']) {
      const [model] = parseModelsListResponse({ data: [{ id: 'private-model', modalities }] },
        sourceUrl)!;
      expect(model.discoveredMetadata?.supportsImageInput).toBe(false);
    }
  });

  it.each([
    'https://proxy.example/v1/models',
    'https://opencode.ai.proxy.example/zen/go/v1/models',
    'https://opencode.ai/other/v1/models',
    'http://opencode.ai/zen/v1/models',
    'https://opencode.ai:8443/zen/v1/models',
    'https://opencode.ai.proxy.example/zen/v1/models',
    'https://proxy.example/zen/v1/models',
    undefined,
  ])('keeps MIME-only proxy declarations conservative: %s', sourceUrl => {
    const [model] = parseModelsListResponse({ data: [{ id: 'private-model',
      modalities: { input: ['text', 'image/jpeg'], output: ['text'] },
    }] }, sourceUrl)!;
    expect(model.discoveredMetadata?.supportsImageInput).toBe(false);
    expect(model.discoveredMetadata?.modalities).toBeUndefined();
  });

  it.each([{ supports_image_input: false }, { model_info: { supports_vision: false } },
    { capabilities: { vision: false } }])('keeps explicit OpenCode image denials ahead of MIME: %j', fields => {
    for (const sourceUrl of ['https://opencode.ai/zen/go/v1/models', 'https://opencode.ai/zen/v1/models']) {
      const [model] = parseModelsListResponse({ data: [{ id: 'private-model', ...fields,
        modalities: { input: ['text', 'image/jpeg', 'audio/wav'], output: ['text', 'image/png'] },
      }] }, sourceUrl)!;
      expect(model.discoveredMetadata).toMatchObject({ supportsImageInput: false,
        modalities: { input: ['text', 'audio'], output: ['text', 'image'] } });
    }
  });

  it.each([
    { context_length: '1000000' },
    { context_window: '1000000' },
    { max_context_length: '1000000' },
    { max_input_tokens: '1000000' },
    { contextWindow: '1000000' },
    { model_info: { max_input_tokens: '1000000' } },
    { limit: { context: '1000000' } },
  ])('normalizes string context limits through discovery, refresh, save and all engines: %j', fields => {
    const discovered = parseModelsListResponse({ data: [{ id: 'private-model', ...fields }] })!;
    expect(discovered[0]).toMatchObject({ contextWindow: 1_000_000,
      discoveredMetadata: { contextWindow: 1_000_000 } });
    const previous = [{ id: 'private-model', name: 'Private',
      discoveredMetadata: { contextWindow: 200_000 } }];
    const refreshed = mergeDiscoveredRuntimeModels(previous, discovered);
    const sparse = parseModelsListResponse({ data: [{ id: 'private-model' }] })!;
    const models = JSON.parse(JSON.stringify(mergeDiscoveredRuntimeModels(refreshed, sparse)));
    for (const agent of ['claude-code', 'codex', 'pi'] as const) {
      const runtime = { baseUrl: 'https://relay.example/v1', models };
      expect(buildUserProvider({ id: 'relay', name: 'Relay', runtimes: { [agent]: runtime } })
        .models[agent]?.[0]).toMatchObject({ contextWindow: 1_000_000, contextWindowVerified: true });
      expect(buildUserProvider({ id: 'relay', name: 'Relay', runtimes: { [agent]: {
        ...runtime, models: [{ ...models[0], contextWindow: 128_000 }],
      } } }).models[agent]?.[0]?.contextWindow).toBe(128_000);
    }
    expect(previous[0].discoveredMetadata.contextWindow).toBe(200_000);
  });

  it.each(['', ' ', '1M', '1,000,000', '0', '-1', '0.5', '1000000.5', 'Infinity',
    'NaN', '0x100000', '1e6', '9007199254740992', true, {}, []])(
    'does not invent context limits from invalid values: %j', value => {
      for (const fields of [{ context_length: value }, { contextWindow: value },
        { model_info: { max_input_tokens: value } }, { limit: { context: value } }]) {
        const [model] = parseModelsListResponse({ data: [{ id: 'private-model', ...fields }] })!;
        expect(model.contextWindow).toBeUndefined();
        expect(model.discoveredMetadata?.contextWindow).toBeUndefined();
      }
    });

  it.each(['contextWindowMax', 'max_context_window'])(
    'normalizes string capacity without inventing a reported working window: %s', key => {
      const [model] = parseModelsListResponse({ data: [{ id: 'private-model', [key]: '1000000' }] })!;
      expect(model.discoveredMetadata?.contextWindowMax).toBe(1_000_000);
      expect(model.discoveredMetadata?.contextWindow).toBeUndefined();
      expect(model.contextWindow).toBeUndefined();
    });

  it('keeps output validation unchanged when normalizing nested context strings', () => {
    const [model] = parseModelsListResponse({ data: [{ id: 'private-model',
      limit: { context: '1000000', output: '8192' },
    }] })!;
    expect(model.contextWindow).toBe(1_000_000);
    expect(model.discoveredMetadata?.maxOutputTokens).toBeUndefined();
  });

  it('preserves field precedence and skips invalid context aliases', () => {
    const models = parseModelsListResponse({ data: [
      { id: 'first', context_length: '128000', context_window: 1_000_000,
        contextWindow: 2_000_000, limit: { context: 3_000_000 } },
      { id: 'second', context_length: 'invalid', context_window: ' 1000000 ' },
    ] })!;
    expect(models.map(model => model.contextWindow)).toEqual([128_000, 1_000_000]);
  });

  // #8867: flat-window coverage missed OpenCode's nested limit metadata.
  // Unit: real discovery -> refresh merge -> JSON save -> three runtime catalogs.
  it('retains nested token limits through refresh and save without overriding user budgets', () => {
    const discovered = parseModelsListResponse({ data: [{ id: 'deepseek-v4.1-flash',
      limit: { context: 1_000_000, output: 384_000 },
    }] })!;
    expect(discovered[0]).toMatchObject({ contextWindow: 1_000_000,
      discoveredMetadata: { contextWindow: 1_000_000, maxOutputTokens: 384_000 } });
    const existing = [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek',
      discoveredMetadata: { contextWindow: 200_000, maxOutputTokens: 8192 } }];
    const models = JSON.parse(JSON.stringify(mergeDiscoveredRuntimeModels(existing, discovered)));
    for (const agent of ['claude-code', 'codex', 'pi'] as const) {
      const runtime = { baseUrl: 'https://relay.example/v1', models };
      const provider = buildUserProvider({ id: 'relay', name: 'Relay', runtimes: { [agent]: runtime } });
      expect(provider.models[agent]?.[0]).toMatchObject({
        contextWindow: 1_000_000, maxOutput: 384_000, contextWindowVerified: true,
      });
      const overridden = buildUserProvider({ id: 'relay', name: 'Relay', runtimes: {
        [agent]: { ...runtime, models: [{ ...models[0], contextWindow: 128_000, maxOutputTokens: 4096 }] },
      } });
      expect(overridden.models[agent]?.[0]).toMatchObject({ contextWindow: 128_000, maxOutput: 4096 });
    }
  });

  it.each([{ context_length: 128_000 }, { contextWindow: 128_000 }])(
    'keeps existing flat token fields ahead of nested limits: %j', fields => {
      const [model] = parseModelsListResponse({ data: [{ id: 'private-model',
        ...fields, max_output_tokens: 8192,
        limit: { context: 1_000_000, output: 384_000 },
      }] })!;
      expect(model).toMatchObject({ contextWindow: 128_000,
        discoveredMetadata: { contextWindow: 128_000, maxOutputTokens: 8192 } });
    });

  it('ignores invalid nested token limits independently and retains unknown-model defaults', () => {
    for (const value of [undefined, null, '', '1M', 0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      const [badContext, badOutput] = parseModelsListResponse({ data: [
        { id: 'private-model', limit: { context: value, output: 8192 } },
        { id: 'other-model', limit: { context: 128_000, output: value } },
      ] })!;
      expect(badContext.contextWindow).toBeUndefined();
      expect(badContext.discoveredMetadata?.contextWindow).toBeUndefined();
      expect(badContext.discoveredMetadata?.maxOutputTokens).toBe(8192);
      expect(badOutput.contextWindow).toBe(128_000);
      expect(badOutput.discoveredMetadata?.maxOutputTokens).toBeUndefined();
      const models = mergeDiscoveredRuntimeModels([], [badContext]);
      const provider = buildUserProvider({ id: 'relay', name: 'Relay', runtimes: {
        pi: { baseUrl: 'https://relay.example/v1', models },
      } });
      expect(provider.models.pi?.[0]?.contextWindow).toBe(500_000);
      expect(provider.models.pi?.[0]?.contextWindowVerified).not.toBe(true);
    }
  });

  it.each([
    { service_tiers: [{ id: 'priority' }, { id: 'ultrafast' }] },
    { additional_speed_tiers: ['fast', 'ultrafast'] },
  ])('keeps account speed tiers through discovery and JSON save: %j', fields => {
    const models = JSON.parse(JSON.stringify(mergeDiscoveredRuntimeModels([],
      parseModelsListResponse({ models: [{ slug: 'gpt-6.1-sol', ...fields }] })!)));
    const provider = buildUserProvider({ id: 'openai-one', name: 'Account',
      auth: { method: 'oauth', native: 'codex' }, runtimes: { codex: {
        baseUrl: 'https://chatgpt.com/backend-api/codex', wireProtocol: 'openai-responses', models,
      } } }, { modelRegistry: BUNDLED_CATALOG.modelRegistry });
    expect(provider.models.codex![0]).toMatchObject({ supportsFastMode: true, supportsUltrafastMode: true });
    expect(models[0].discoveredMetadata).not.toHaveProperty('supportsUltrafastMode');
  });

  it.each([
    { contextWindow: 128000, contextWindowMax: 64000 },
    { context_window: 128000, contextWindowMax: 64000 },
    { contextWindow: 128000, max_context_window: 64000 },
    { model_info: { max_input_tokens: 128000 }, contextWindowMax: 64000 },
    { contextWindow: 128000, contextWindowMax: 64000, max_context_window: 32000 },
  ])('ignores a maximum smaller than the normalized working window: %j', fields => {
    const models = parseModelsListResponse({ data: [{ id: 'private-model', ...fields }] })!;
    expect(models[0].discoveredMetadata?.contextWindow).toBe(128000);
    expect(models[0].discoveredMetadata).not.toHaveProperty('contextWindowMax');
    const provider = buildUserProvider({ id: 'relay', name: 'Relay', runtimes: {
      'claude-code': { baseUrl: 'https://relay.example/v1', models },
    } });
    expect(provider.models['claude-code']?.[0]).toMatchObject({ contextWindow: 128000 });
    expect(provider.models['claude-code']?.[0].contextWindowMax).not.toBe(64000);
  });

  it.each(['contextWindowMax', 'max_context_window'])('retains a valid %s with or without a working window', key => {
    for (const fields of [{}, { contextWindow: 128000 }]) {
      const [model] = parseModelsListResponse({ data: [{ id: 'private-model', ...fields, [key]: 256000 }] })!;
      expect(model.discoveredMetadata?.contextWindowMax).toBe(256000);
    }
  });

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

  it.each([
    [{ context_window: 272000 }, { max_context_window: 64000 }],
    [{ context_window: 272000, max_context_window: 1050000 }, { contextWindowMax: 64000 }],
    [{ context_window: 32000, max_context_window: 64000 }, { context_window: 272000 }],
  ])('reconciles working and maximum windows after a sparse refresh: %j + %j', (before, refresh) => {
    const original = mergeDiscoveredRuntimeModels([], parseModelsListResponse({ data: [
      { id: 'private-model', ...before },
    ] })!);
    const models = mergeDiscoveredRuntimeModels(original, parseModelsListResponse({ data: [
      { id: 'private-model', ...refresh },
    ] })!);
    expect(original[0].discoveredMetadata?.contextWindow).toBe(before.context_window);
    expect(models[0].discoveredMetadata?.contextWindow).toBe(272000);
    expect(models[0].discoveredMetadata).not.toHaveProperty('contextWindowMax');
    for (const agent of ['claude-code', 'codex', 'pi'] as const) {
      const provider = buildUserProvider({ id: 'relay', name: 'Relay', runtimes: {
        [agent]: { baseUrl: 'https://relay.example/v1', models },
      } });
      expect(provider.models[agent]?.[0].contextWindow).toBe(272000);
      expect(provider.models[agent]?.[0].contextWindowMax).toBeUndefined();
    }
  });

  it('retains maximum-only account capacity below the public working default', () => {
    const models = mergeDiscoveredRuntimeModels([], parseModelsListResponse({ data: [{
      id: 'gpt-6-astra', max_context_window: 872000,
    }] })!);
    for (const agent of ['claude-code', 'codex', 'pi'] as const) {
      const provider = buildUserProvider({ id: 'relay', name: 'Relay', runtimes: {
        [agent]: { baseUrl: 'https://relay.example/v1', models },
      } }, { modelRegistry: BUNDLED_CATALOG.modelRegistry });
      expect(provider.models[agent]?.[0]).toMatchObject({ contextWindow: 872000, contextWindowMax: 872000 });
      expect(provider.models[agent]?.[0].discoveredMetadata).toEqual({ contextWindowMax: 872000 });
    }
  });

  it('uses maximum-only discovery as an unverified working fallback without saving it as a report', () => {
    const discovered = parseModelsListResponse({ data: [{ id: 'private-model', max_context_window: 64000 }] })!;
    const models = mergeDiscoveredRuntimeModels([], discovered);
    expect(models[0].discoveredMetadata?.contextWindow).toBeUndefined();
    for (const agent of ['claude-code', 'codex', 'pi'] as const) {
      const provider = buildUserProvider({ id: 'relay', name: 'Relay', runtimes: {
        [agent]: { baseUrl: 'https://relay.example/v1', models },
      } });
      expect(provider.models[agent]?.[0]).toMatchObject({
        contextWindow: 64000, contextWindowMax: 64000, contextWindowVerified: false,
      });
      expect(provider.models[agent]?.[0].userModelConfig?.discoveredMetadata?.contextWindow).toBeUndefined();
    }
    const refreshed = mergeDiscoveredRuntimeModels(models, parseModelsListResponse({ data: [
      { id: 'private-model', context_window: 32000 },
    ] })!);
    const provider = buildUserProvider({ id: 'relay', name: 'Relay', runtimes: {
      pi: { baseUrl: 'https://relay.example/v1', models: refreshed },
    } });
    expect(provider.models.pi?.[0]).toMatchObject({ contextWindow: 32000, contextWindowMax: 64000, contextWindowVerified: true });
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


it('does not infer reasoning support from missing parameter names', () => {
  const models = parseModelsListResponse({ data: [
    { id: 'plain-model', supported_parameters: ['tools', 'temperature'], context_length: 32000 },
    { id: 'undocumented-model' },
    { id: 'reasoning-model', supported_parameters: ['tools', 'reasoning_effort'] },
  ] });
  expect(models?.[0]?.discoveredMetadata?.efforts).toBeUndefined();
  expect(models?.[1]?.discoveredMetadata?.efforts).toBeUndefined();
  expect(models?.[2]?.discoveredMetadata?.efforts).toBeUndefined();
});

// #11018, unit: parse -> refresh -> JSON save -> real three-engine catalog.
// Previous coverage treated sparse supported_parameters as an explicit denial and
// never refreshed a persisted empty efforts list against the known model registry.
describe('sparse reasoning discovery refresh', () => {
  it.each([
    { supported_parameters: ['max_tokens', 'tools'] },
    {},
  ])('restores known capabilities after an incomplete response: %j', fields => {
    const id = 'claude-fable-5-2';
    const existing = [{ id, name: id, discoveredMetadata: { efforts: [], contextWindow: 128000 } }];
    const discovered = parseModelsListResponse({ data: [{ id, ...fields }] })!;
    expect(discovered[0].discoveredMetadata?.efforts).toBeUndefined();
    const models = JSON.parse(JSON.stringify(mergeDiscoveredRuntimeModels(existing, discovered)));
    expect(models[0].discoveredMetadata).not.toHaveProperty('efforts');
    expect(models[0].discoveredMetadata.contextWindow).toBe(128000);
    expect(existing[0].discoveredMetadata.efforts).toEqual([]);
    for (const agent of ['claude-code', 'codex', 'pi'] as const) {
      const build = (rows: typeof models) => buildUserProvider({ id: 'relay', name: 'Relay', runtimes: {
        [agent]: { baseUrl: 'https://relay.example/v1', models: rows },
      } }, { modelRegistry: BUNDLED_CATALOG.modelRegistry }).models[agent]![0];
      const expected = build([{ id, name: id, discoveredMetadata: {} }]);
      expect(expected.efforts.length).toBeGreaterThan(0);
      expect(build(models)).toMatchObject({ efforts: expected.efforts, defaultEffort: expected.defaultEffort });
      for (const override of [{ efforts: ['low' as const], defaultEffort: 'low' as const }, { efforts: [], defaultEffort: null }]) {
        const manual = mergeDiscoveredRuntimeModels([{ ...existing[0], ...override }], discovered);
        expect(build(JSON.parse(JSON.stringify(manual)))).toMatchObject(override);
      }
    }
    const unknown = parseModelsListResponse({ data: [{ id: 'private-undocumented', ...fields }] })!;
    expect(buildUserProvider({ id: 'relay', name: 'Relay', runtimes: { codex: {
      baseUrl: 'https://relay.example/v1', models: mergeDiscoveredRuntimeModels([], unknown),
    } } }).models.codex![0]).toMatchObject({ efforts: [], defaultEffort: null, effortsUnknown: true });
  });

  it.each([
    { reasoning: false },
    { model_info: { supports_reasoning: false } },
    { reasoning: { supportedEfforts: [] } },
    { reasoning: { supportedEfforts: ['low', 'high'] } },
  ])('keeps a fresh explicit declaration authoritative: %j', fields => {
    const id = 'claude-fable-5-2';
    const discovered = parseModelsListResponse({ data: [{ id, supported_parameters: ['tools'], ...fields }] })!;
    const expected = 'reasoning' in fields && typeof fields.reasoning === 'object'
      ? fields.reasoning.supportedEfforts : [];
    const models = JSON.parse(JSON.stringify(mergeDiscoveredRuntimeModels([
      { id, name: id, discoveredMetadata: { efforts: [] } },
    ], discovered)));
    for (const agent of ['claude-code', 'codex', 'pi'] as const) {
      const model = buildUserProvider({ id: 'relay', name: 'Relay', runtimes: {
        [agent]: { baseUrl: 'https://relay.example/v1', models },
      } }, { modelRegistry: BUNDLED_CATALOG.modelRegistry }).models[agent]![0];
      expect(model.efforts).toEqual(expected);
      expect(model.effortsUnknown).not.toBe(true);
    }
  });
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

describe('mergeDiscoveredRuntimeModels 排序', () => {
  it('新发现的型号排在已有型号之前，已有型号位置不动', () => {
    const existing = [
      { id: 'old-b', name: 'Old B' },
      { id: 'old-a', name: 'Old A' },
    ];
    const merged = mergeDiscoveredRuntimeModels(existing, [
      { id: 'old-a', name: 'Old A' },
      { id: 'new-1', name: 'New 1' },
      { id: 'old-b', name: 'Old B' },
      { id: 'new-2', name: 'New 2' },
    ]);
    expect(merged.map((model) => model.id)).toEqual(['new-1', 'new-2', 'old-b', 'old-a']);
  });
});

// 回归价值：2026-11-19 #11456；Magpie 自定义 URL 此前漏解析 OpenRouter pricing 且刷新缺少 pricing 时
// 残留旧 discoveredCost。最小失效输入：带 pricing 与无 pricing（混合分组）的 Magpie 清单及刷新快照。tier: unit。
describe('Magpie discovery pricing and refresh cleanup', () => {
  it.each([
    'https://magpie.example/v1/models',
    undefined,
  ])('parses Magpie OpenRouter-format pricing into discoveredCost regardless of sourceUrl (%s)', (sourceUrl) => {
    const models = parseModelsListResponse({
      data: [
        {
          id: 'fixed-group',
          magpie_label: 'Claude Sonnet · Channel A',
          owned_by: 'anthropic',
          pricing: {
            prompt: '0.000003',
            completion: '0.000015',
            input_cache_read: '0.0000003',
            input_cache_write: '0.00000375',
          },
        },
        {
          id: 'mixed-group',
          magpie_label: 'Smart Routing · Mix',
          owned_by: 'magpie',
        },
        {
          id: 'invalid-group',
          magpie_label: 'Broken · Channel B',
          owned_by: 'openai',
          pricing: { prompt: '', completion: '-1' },
        },
      ],
    }, sourceUrl)!;

    expect(models[0]).toMatchObject({
      id: 'fixed-group',
      opaqueModelId: true,
      discoveredCost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    });
    expect(models[1].opaqueModelId).toBe(true);
    expect(models[1].discoveredCost).toBeUndefined();
    expect(models[2].opaqueModelId).toBe(true);
    expect(models[2].discoveredCost).toBeUndefined();
  });

  it('clears stale discoveredCost on refresh when pricing disappears while keeping unlisted models intact', () => {
    const initial = mergeDiscoveredRuntimeModels([], parseModelsListResponse({
      data: [
        {
          id: 'group-a',
          magpie_label: 'Group A',
          owned_by: 'anthropic',
          pricing: { prompt: '0.000003', completion: '0.000015' },
        },
        {
          id: 'group-unlisted',
          magpie_label: 'Unlisted',
          owned_by: 'openai',
          pricing: { prompt: '0.000002', completion: '0.000008' },
        },
      ],
    })!);
    const refreshed = mergeDiscoveredRuntimeModels(initial, parseModelsListResponse({
      data: [
        {
          id: 'group-a',
          magpie_label: 'Group A (mixed)',
          owned_by: 'magpie',
        },
      ],
    })!);
    const provider = buildUserProvider({
      id: 'custom-magpie',
      name: 'Magpie',
      runtimes: { 'claude-code': { baseUrl: 'https://magpie.example', models: refreshed } },
    });
    const refreshedGroup = provider.models['claude-code']?.find((m) => m.id === 'group-a');
    const unlistedGroup = provider.models['claude-code']?.find((m) => m.id === 'group-unlisted');
    expect(refreshedGroup?.opaqueModelId).toBe(true);
    expect(refreshedGroup?.cost).toBeUndefined();
    expect(unlistedGroup?.cost).toEqual({ input: 2, output: 8 });
  });
});

