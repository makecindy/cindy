import { describe, expect, it } from 'vitest';
import { BUNDLED_CATALOG, buildUserProvider, type ProviderPreset } from '@cindy/model-providers';
import { presetCandidateRoute, presetModelCandidate, presetSupplementalModels } from '../providerModelCandidates';
import { presetConnectionRuntime } from '../presetConnectionRuntime';

function deepseekFixture() {
  const preset = structuredClone(BUNDLED_CATALOG.presets!.find(candidate => candidate.id === 'deepseek')!);
  for (const runtime of Object.values(preset.runtimes)) {
    runtime!.models = runtime!.models.filter(model => ['deepseek-flash', 'deepseek-v4-pro'].includes(model.id));
  }
  return { preset, registry: structuredClone(BUNDLED_CATALOG.modelRegistry!) };
}

describe('provider model candidates', () => {
  it('uses exact interface declarations without changing preset membership or defaults', () => {
    const { preset, registry } = deepseekFixture();
    const before = structuredClone(preset);
    for (const agent of ['claude-code', 'codex', 'pi'] as const) {
      const candidates = presetSupplementalModels(preset, agent, registry);
      expect(candidates.some(model => model.id === 'deepseek-v4-flash')).toBe(true);
      expect(candidates.some(model => model.id === 'deepseek-v4-flash-vision-exp')).toBe(true);
    }
    expect(preset).toEqual(before);
  });

  it('preserves a Chat-only binding through preset saving and runtime projection', () => {
    const { preset, registry } = deepseekFixture();
    const model = { id: 'deepseek-v4-flash-vision-exp', name: 'Chat-only fixture' };
    registry.models.push({ id: 'review/chat-only', name: 'Chat-only fixture', routes: [{ providerId: preset.id, modelId: model.id,
      agents: ['claude-code'], interfaces: [{ profileId: 'deepseek-openai-completions' }] }] });
    const candidate = presetSupplementalModels(preset, 'claude-code', registry).find(value => value.id === model.id)!;
    expect(candidate).toMatchObject({ interfaceId: 'deepseek-openai-completions',
      route: { baseUrl: 'https://api.deepseek.com', wireProtocol: 'openai-chat' } });
    const config = { id: 'review-fixture', name: 'Review fixture', runtimes: {
      'claude-code': presetConnectionRuntime(preset, 'claude-code', [candidate]),
    } };
    const provider = buildUserProvider(JSON.parse(JSON.stringify(config)), { presets: [preset], modelRegistry: registry });
    expect(provider.models['claude-code']![0]).toMatchObject({ api: 'openai-completions', route: candidate.route });
  });

  it.each(['retired', 'empty-binding', 'unsupported-requirement'] as const)('does not revive %s interfaces from the bundled catalog', kind => {
    const { preset, registry } = deepseekFixture();
    const id = 'deepseek-v4-flash-vision-exp';
    registry.models.push({ id: 'review/blocked', name: 'Blocked fixture', ...(kind === 'retired' ? { status: 'retired' as const } : {}),
      routes: [{ providerId: preset.id, modelId: id, agents: ['claude-code'], interfaces: kind === 'empty-binding' ? [] : [{
        profileId: 'deepseek-openai-completions', ...(kind === 'unsupported-requirement' ? { requires: ['not-implemented'] } : {}),
      }] }] });
    expect(presetSupplementalModels(preset, 'claude-code', registry).some(model => model.id === id)).toBe(false);
  });

  it('does not lend official transports to custom origins or explicit request paths', () => {
    const { preset, registry } = deepseekFixture();
    expect(presetSupplementalModels(preset, 'claude-code', registry, 'https://custom.example')).toEqual([]);
    preset.runtimes['claude-code']!.requestPath = '/tenant/messages';
    expect(presetSupplementalModels(preset, 'claude-code', registry)).toEqual([]);
  });

  it('uses an exact Chat-only binding for a newly discovered ID without a static whitelist', () => {
    const { preset, registry } = deepseekFixture();
    const model = { id: 'account-only-new-model', name: 'New model' };
    registry.models.push({ id: 'review/discovered', name: model.name, routes: [{ providerId: preset.id,
      modelId: model.id, agents: ['claude-code'], interfaces: [{ profileId: 'deepseek-openai-completions' }] }] });
    const route = presetCandidateRoute(preset, 'claude-code');
    const candidate = presetModelCandidate(preset, 'claude-code', model, registry, route, route, true);
    expect(candidate).toMatchObject({ id: model.id, interfaceId: 'deepseek-openai-completions',
      route: { baseUrl: 'https://api.deepseek.com', wireProtocol: 'openai-chat' } });
  });

  it('allows current product-wide declarations for previously unknown discovered models', () => {
    const { preset, registry } = deepseekFixture();
    const model = { id: 'not-in-static-catalog', name: 'New model' };
    const route = presetCandidateRoute(preset, 'claude-code');
    expect(presetModelCandidate(preset, 'claude-code', model, registry, route, route, true)).toEqual(model);
  });

  it('keeps legacy direct-protocol discovery but does not infer another protocol from a shared inventory', () => {
    const preset: ProviderPreset = { id: 'review', name: 'Review', runtimes: {
      'claude-code': { baseUrl: 'https://review.example/anthropic', models: [] },
    } };
    const model = { id: 'new-model', name: 'New model' };
    const route = presetCandidateRoute(preset, 'claude-code');
    expect(presetModelCandidate(preset, 'claude-code', model, undefined, route)).toEqual(model);
    expect(presetModelCandidate(preset, 'claude-code', model, undefined, route, route, true)).toBeUndefined();
  });
});
