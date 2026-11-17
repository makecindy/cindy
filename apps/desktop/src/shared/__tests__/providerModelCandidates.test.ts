import { describe, expect, it } from 'vitest';
import { BUNDLED_CATALOG, buildUserProvider, parseModelRegistry, type ProviderPreset } from '@cindy/model-providers';
import { presetCandidateRoute, presetModelCandidate, presetSupplementalModels } from '../providerModelCandidates';
import { presetConnectionRuntime } from '../presetConnectionRuntime';

// Unit: exact supplemental-model evidence through production candidate selection
// and saved runtime projection. The old wizard only tested per-protocol lists.
const id = 'deepseek-v4-flash-vision-exp';
function fixture() {
  const preset = structuredClone(BUNDLED_CATALOG.presets!.find(p => p.id === 'deepseek')!);
  for (const rt of Object.values(preset.runtimes)) rt!.models = rt!.models.filter(m => m.id !== id);
  return { preset, registry: structuredClone(BUNDLED_CATALOG.modelRegistry!), model: { id, name: id } };
}

describe('supplemental preset candidates', () => {
  it('accepts newly discovered OpenHubs models through the connection default without a model whitelist', () => {
    const preset = BUNDLED_CATALOG.presets!.find(p => p.id === 'openhubs')!;
    const route = presetCandidateRoute(preset, 'pi');
    const model = { id: 'unknown-openai-tagged', name: 'Unknown' };
    expect(presetModelCandidate(preset, 'pi', model, BUNDLED_CATALOG.modelRegistry, route))
      .toMatchObject({ ...model, interfaceId: 'auto' });
  });
  it('uses exact declared APIs for all engines without changing recommendations', () => {
    const { preset, registry } = fixture();
    const before = structuredClone(preset);
    for (const agent of ['claude-code', 'codex', 'pi'] as const) {
      expect(presetSupplementalModels(preset, agent, registry).find(m => m.id === id))
        .toMatchObject({ id, interfaceId: 'auto' });
    }
    expect(preset).toEqual(before);
  });

  it.each(['retired', 'empty', 'requires', 'duplicate'] as const)('does not revive a %s declaration from offline inventory', kind => {
    const { preset, registry } = fixture();
    const entry = { id: 'test/vision', name: 'Vision', ...(kind === 'retired' ? { status: 'retired' as const } : {}),
      routes: [{ providerId: preset.id, modelId: id, agents: ['claude-code' as const],
        interfaces: kind === 'empty' ? [] : [{ profileId: 'deepseek-anthropic-messages',
          ...(kind === 'requires' ? { requires: ['future-v99'] } : {}) }] }] };
    registry.models.push(entry);
    if (kind === 'duplicate') registry.models.push({ ...entry, id: 'test/duplicate' });
    expect(presetSupplementalModels(preset, 'claude-code', registry).some(m => m.id === id)).toBe(false);
  });

  // Interface compatibility is not engine membership. A shared inventory must
  // not add a supplemental model to a non-Pi engine excluded by its exact route.
  it.each([
    ['claude-code', ['codex']], ['claude-code', []],
    ['codex', ['claude-code']], ['codex', []],
  ] as const)('respects exact Registry membership for %s with agents %j', (agent, agents) => {
    const { preset, registry, model } = fixture();
    const route = presetCandidateRoute(preset, agent);
    registry.models.push({ id: 'test/vision', name: 'Vision',
      ...(agents.length === 0 ? { mode: 'image_generation' as const } : {}),
      routes: [{ providerId: preset.id, modelId: id, agents: [...agents] }] });
    expect(parseModelRegistry(registry).ok).toBe(true);
    expect(presetModelCandidate(preset, agent, model, registry, route)).toBeUndefined();
    expect(presetModelCandidate(preset, agent, model, registry, route,
      { ...route, requestPath: '/tenant/infer' })).toBeUndefined();
    expect(presetSupplementalModels(preset, agent, registry).some(m => m.id === id)).toBe(false);
    // Pi membership comes from its own inventory, not Registry's two-engine list.
    expect(presetModelCandidate(preset, 'pi', model, registry, presetCandidateRoute(preset, 'pi')))
      .toMatchObject({ id });
  });

  it('does not bypass missing required behavior via an explicit discovery path', () => {
    const { preset, registry, model } = fixture();
    for (const profile of registry.interfaceProfiles!.filter(p => p.providerId === preset.id)) {
      profile.requires = ['future-v99'];
    }
    const route = presetCandidateRoute(preset, 'claude-code');
    expect(presetModelCandidate(preset, 'claude-code', model, registry, route,
      { ...route, requestPath: '/tenant/infer' })).toBeUndefined();
  });

  it('pins a Chat-only interface through JSON saving and real runtime projection', () => {
    const { preset, registry, model } = fixture();
    registry.models.push({ id: 'test/vision', name: 'Vision', routes: [{ providerId: preset.id,
      modelId: id, agents: ['claude-code'], interfaces: [{ profileId: 'deepseek-openai-completions' }] }] });
    const candidate = presetModelCandidate(preset, 'claude-code', model, registry, presetCandidateRoute(preset, 'claude-code'))!;
    expect(candidate.interfaceId).toBe('deepseek-openai-completions');
    const saved = JSON.parse(JSON.stringify({ id: 'test', name: 'Test', runtimes: {
      'claude-code': presetConnectionRuntime(preset, 'claude-code', [candidate]),
    } }));
    expect(buildUserProvider(saved, { presets: [preset], modelRegistry: registry }).models['claude-code']![0])
      .toMatchObject({ api: 'openai-completions', route: { wireProtocol: 'openai-chat' } });
  });

  it('keeps one saved automatic choice live across a default change, while an explicit choice stays pinned', () => {
    const { preset, registry, model } = fixture();
    const candidate = presetModelCandidate(preset, 'claude-code', model, registry, presetCandidateRoute(preset, 'claude-code'))!;
    const saved = JSON.parse(JSON.stringify({ id: 'test', name: 'Test', runtimes: {
      'claude-code': presetConnectionRuntime(preset, 'claude-code', [candidate,
        { ...model, id: 'explicit-model', interfaceId: 'deepseek-anthropic-messages' }]),
    } }));
    const before = JSON.stringify(saved);
    const project = () => buildUserProvider(saved, { presets: [preset], modelRegistry: registry }).models['claude-code']!;
    expect(project()[0].api).toBe('anthropic-messages');
    registry.interfaceProfiles!.find(p => p.id === 'deepseek-anthropic-messages')!.defaultFor = [];
    registry.interfaceProfiles!.find(p => p.id === 'deepseek-openai-completions')!.defaultFor = ['claude-code', 'pi'];
    expect(project()[0].api).toBe('openai-completions');
    expect(project()[1].api).toBe('anthropic-messages');
    expect(JSON.stringify(saved)).toBe(before);
  });

  it('does not lend official declarations to a custom host or erase a discovery request path', () => {
    const { preset, registry, model } = fixture();
    expect(presetSupplementalModels(preset, 'claude-code', registry, 'https://tenant.example')).toEqual([]);
    const route = presetCandidateRoute(preset, 'claude-code');
    const source = { ...route, requestPath: '/tenant/infer' };
    expect(presetModelCandidate(preset, 'claude-code', model, registry, route, source, true))
      .toEqual({ ...model, route: source });
    preset.runtimes['claude-code']!.requestPath = '/tenant/infer';
    expect(presetSupplementalModels(preset, 'claude-code', registry)).toEqual([]);
  });

  it('keeps direct dynamic discovery without treating a shared inventory as cross-protocol proof', () => {
    const preset: ProviderPreset = { id: 'test', name: 'Test', runtimes: {
      'claude-code': { baseUrl: 'https://tenant.example', models: [] },
    } };
    const model = { id: 'new-model', name: 'New' };
    const route = presetCandidateRoute(preset, 'claude-code');
    expect(presetModelCandidate(preset, 'claude-code', model, undefined, route)).toEqual(model);
    expect(presetModelCandidate(preset, 'claude-code', model, undefined, route, route, true)).toBeUndefined();
  });

  // Unit: a V6 registry without Mistral profiles is still legacy for that product.
  // Filtering its mixed inventory by Chat hides legal Conversations candidates offline.
  it('keeps Pi mixed-API supplements when V6 has no profiles for the product', () => {
    const preset = structuredClone(BUNDLED_CATALOG.presets!.find(p => p.id === 'mistral')!);
    const model = preset.runtimes.pi!.models.find(model => model.api === 'mistral-conversations')!;
    expect(model).toBeDefined();
    preset.runtimes.pi!.models = [];
    expect(presetSupplementalModels(preset, 'pi', BUNDLED_CATALOG.modelRegistry))
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: model.id, execution: { pi: { api: 'mistral-conversations' } } })]));
  });

  // A generic profile preferred for another engine is not the direct source's
  // default. Exercise the bundled proxy and final runtime projection, not mocks.
  it('keeps direct LiteLLM Pi discovery on Chat when only CC has a preferred profile', () => {
    const preset = BUNDLED_CATALOG.presets!.find(p => p.id === 'litellm')!;
    const model = { id: 'private-new-model', name: 'Private' };
    const candidate = presetModelCandidate(preset, 'pi', model, BUNDLED_CATALOG.modelRegistry,
      presetCandidateRoute(preset, 'pi'))!;
    expect(candidate).toEqual(model);
    const provider = buildUserProvider({ id: 'proxy', name: 'Proxy', runtimes: {
      pi: presetConnectionRuntime(preset, 'pi', [candidate]),
    } }, { presets: [preset], modelRegistry: BUNDLED_CATALOG.modelRegistry });
    expect(provider.models.pi![0]).not.toHaveProperty('interfaceId');
    expect(provider.models.pi![0]).not.toHaveProperty('route');
    expect(provider.routing.pi).toMatchObject({ upstream: 'http://127.0.0.1:4000/v1', wireProtocol: 'openai-chat' });
  });

  it('preserves the legacy Pi mixed-API inventory without a V6 registry', () => {
    const preset = structuredClone(BUNDLED_CATALOG.presets!.find(p => p.id === 'opencode-go')!);
    preset.runtimes.pi!.models = [];
    const models = presetSupplementalModels(preset, 'pi', undefined);
    expect(models.some(m => m.id === 'gpt-5.6-luna')).toBe(true);
    expect(models.some(m => m.id === 'grok-4.6')).toBe(true);
  });
});
