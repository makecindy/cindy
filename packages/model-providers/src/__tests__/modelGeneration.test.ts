import { describe, expect, it } from 'vitest';
import { previousModelGenerations } from '../modelGeneration.js';
import { buildUserProvider } from '../user-provider.js';
import { BUNDLED_CATALOG } from '../builtin.js';
import { providerModelGenerationRecord, providerModelRecord } from '../providerModelCatalog.js';
import { parseModelsListResponse } from '../modelDiscovery.js';
import { mergeDiscoveredRuntimeModels } from '../modelMetadataLayers.js';
import type { ProviderRuntimeModelConfig, ProviderWireProtocol } from '../types.js';

const build = (models: ProviderRuntimeModelConfig[], wireProtocol: ProviderWireProtocol = 'openai-responses') => {
  const runtime = { baseUrl: 'https://relay.example/v1', wireProtocol, models };
  return buildUserProvider({ id: 'my-sub2api', name: 'Relay', runtimes: {
    codex: runtime, pi: runtime, 'claude-code': runtime,
  } }, { modelRegistry: BUNDLED_CATALOG.modelRegistry });
};
const discovered = (id: string, metadata = {}) => mergeDiscoveredRuntimeModels([], parseModelsListResponse({ data: [{ id, ...metadata }] })!);

describe('new model generation defaults', () => {
  it('imports future GPT generations across all engines without requiring the old model in the account', () => {
    for (const id of ['gpt-7-sol', 'gpt-8-sol', 'openai/gpt-9-luna']) {
      const oldId = id.includes('luna') ? 'gpt-6-luna' : 'gpt-6-sol';
      const previous = build(discovered(oldId)).models.codex![0]!;
      const saved = discovered(id);
      const provider = build(saved);
      for (const agent of ['codex', 'pi', 'claude-code'] as const) {
        const model = provider.models[agent]![0]!;
        expect(model).toMatchObject({ id, name: id, efforts: previous.efforts,
          defaultEffort: previous.defaultEffort, contextWindow: previous.contextWindow,
          maxOutput: previous.maxOutput, supportsImageInput: true });
        expect(model.cost).toBeUndefined();
        expect(model.userModelConfig).toEqual(saved[0]);
      }
    }
  });

  it('takes the closest same-connection generation, preserves explicit disables, and never changes routing', () => {
    const provider = build([
      { id: 'private-6-sol', name: 'Six', discoveredMetadata: { efforts: ['low', 'high'], defaultEffort: 'high', contextWindow: 64000, supportsFastMode: true } },
      { id: 'private-7-sol', name: 'Seven', discoveredMetadata: { efforts: [], supportsFastMode: false } },
      { id: 'private-8-sol', name: 'Eight' },
    ]);
    expect(provider.models.codex![2]).toMatchObject({ id: 'private-8-sol', name: 'Eight',
      efforts: [], defaultEffort: null, contextWindow: 64000, supportsFastMode: false });
    expect(provider.routing.codex?.upstream).toBe('https://relay.example/v1');
  });

  it('prefers a newer account declaration over the older public catalog', () => {
    const models = build([
      { id: 'gpt-8-sol', name: 'Eight', discoveredMetadata: { efforts: ['high'], defaultEffort: null,
        contextWindow: 48000, maxOutputTokens: 4000, supportsFastMode: true } },
      ...discovered('gpt-9-sol'),
    ]).models.codex!;
    expect(models[1]).toMatchObject({ efforts: ['high'], defaultEffort: null,
      contextWindow: 48000, maxOutput: 4000, supportsFastMode: true });
  });

  it('refresh replaces inherited values, while target user settings survive', () => {
    const initial = discovered('gpt-9-sol');
    expect(build(initial).models.pi![0]!.efforts.length).toBeGreaterThan(0);
    const refreshed = mergeDiscoveredRuntimeModels(initial, parseModelsListResponse({ data: [{ id: 'gpt-9-sol',
      supported_reasoning_levels: ['low', 'high'], default_reasoning_level: 'high',
      context_window: 32000, input_modalities: ['text'], service_tiers: [],
    }] })!);
    expect(build(refreshed).models.pi![0]).toMatchObject({ efforts: ['low', 'high'], defaultEffort: 'high',
      contextWindow: 32000, supportsImageInput: false, supportsFastMode: false });
    refreshed[0]!.contextWindow = 16000;
    refreshed[0]!.reasoning = false;
    expect(build(refreshed).models.pi![0]).toMatchObject({ efforts: [], defaultEffort: null, contextWindow: 16000 });
  });

  it('does not inherit from another variant, protocol, private namespace or endpoint', () => {
    const target = { id: 'private-9-sol', name: 'New' };
    for (const source of [
      { id: 'private-8-luna', name: 'Different variant' },
      { id: 'team/private-8-sol', name: 'Private namespace' },
      { id: 'private-8-sol', name: 'Other API', api: 'anthropic-messages' as const },
      { id: 'private-8-sol', name: 'Other endpoint', route: { baseUrl: 'https://other.example/v1', wireProtocol: 'openai-responses' as const } },
    ]) {
      expect(build([{ ...source, reasoning: true, reasoningEfforts: ['high'] }, target]).models.pi![1]!.efforts).toEqual([]);
    }
  });

  it('does not switch the adapter of an already known model while filling defaults', () => {
    const model = build(discovered('claude-sonnet-4-6'), 'anthropic-messages').models.codex![0]!;
    expect(model.api).toBeUndefined();
    expect(model.route).toBeUndefined();
  });

  it('compares numeric generations and keeps model sizes and variants separate', () => {
    const ids = ['gpt-9-sol', 'gpt-6-sol', 'gpt-10-sol', 'gpt-7-luna'];
    expect(previousModelGenerations('gpt-11-sol', ids, id => id)).toEqual(['gpt-6-sol', 'gpt-9-sol', 'gpt-10-sol']);
    expect(previousModelGenerations('grok-4.10', ['grok-4.9', 'grok-4.11'], id => id)).toEqual(['grok-4.9']);
    expect(previousModelGenerations('claude-sonnet-6', ['claude-sonnet-4-6', 'claude-sonnet-5', 'claude-opus-5'], id => id)).toEqual(['claude-sonnet-4-6', 'claude-sonnet-5']);
    expect(previousModelGenerations('qwen4-30b', ['qwen3-235b', 'qwen3-30b'], id => id)).toEqual(['qwen3-30b']);
  });

  it('reuses serializer mappings without copying the predecessor identity, prices, endpoint or headers', () => {
    const source = providerModelRecord('gpt-5.6-sol', 'https://api.openai.com/v1', 'openai-responses')!;
    const inherited = providerModelGenerationRecord('gpt-9-sol', 'https://relay.example/v1', 'openai-responses')!;
    expect(inherited).toMatchObject({ id: 'gpt-9-sol', name: 'gpt-9-sol', upstream: 'https://relay.example/v1', inheritedFrom: 'gpt-5.6-sol' });
    expect(inherited.execution.pi.thinkingLevelMap).toEqual(source.execution.pi.thinkingLevelMap);
    expect(inherited.execution.pi.compat).toEqual(source.execution.pi.compat);
    expect(inherited.cost).toBeUndefined();
    expect(inherited.execution.pi.headers).toBeUndefined();
    expect(providerModelGenerationRecord('gpt-9-sol', 'https://relay.example/v1', 'anthropic-messages')).toBeUndefined();
  });
});
