import { describe, expect, it } from 'vitest';
import { effectiveSourceIdForModel, type ProviderView } from '@cindy/model-providers';
import { defaultBotModelChain } from '../botDefaultModelChain';

const selected = { harness: 'codex' as const, providerId: 'my-connection', model: 'user-chosen-model', effort: 'high', fastMode: false };
const providers = [{ id: 'my-connection', source: 'user', connected: true, agents: ['codex'], routing: { codex: { upstream: 'https://example.invalid', authStrategy: 'oauth-passthrough' } },
  models: { codex: ['gpt-5.6-sol', selected.model].map(id => ({ id, mode: 'chat', status: 'active' })) },
}] as unknown as ProviderView[];
const args = { providers, providersLoading: false, availableAgents: new Set(['codex'] as const), availableAgentsLoaded: true };

describe('Bot strictly follows the available Cindy default', () => {
  it('uses the exact selected route and tuning without adding catalog recommendations', () => {
    expect(defaultBotModelChain({ ...args, preferredRoute: selected })).toEqual([selected]);
  });
  it('resolves a legacy implicit source exactly like ordinary new tasks, without changing the model', () => {
    const preferredRoute = { ...selected, providerId: null };
    const providerId = effectiveSourceIdForModel(providers, null, selected.model, 'codex');
    expect(defaultBotModelChain({ ...args, preferredRoute })).toEqual([{ ...selected, providerId }]);
    expect(defaultBotModelChain({ ...args, preferredRoute, isModelEnabled: () => false })).toEqual([]);
    expect(defaultBotModelChain({ ...args, preferredRoute: { ...preferredRoute, model: 'removed' } })).toEqual([]);
  });
  it('resolves implicit sources only among enabled connections offering the selected model', () => {
    const sameModel = [
      { ...providers[0], id: 'openai' },
      { ...providers[0], id: 'other-connection' },
    ] as ProviderView[];
    expect(defaultBotModelChain({ ...args, providers: sameModel, preferredRoute: { ...selected, providerId: null },
      isModelEnabled: (_agent, providerId) => providerId !== 'openai' }))
      .toEqual([{ ...selected, providerId: 'other-connection' }]);
    expect(defaultBotModelChain({ ...args, providers: sameModel, preferredRoute: { ...selected, providerId: 'openai' },
      isModelEnabled: (_agent, providerId) => providerId !== 'openai' })).toEqual([]);
  });
  it('returns empty before preferences or catalog/runtime readiness arrive', () => {
    expect(defaultBotModelChain(args)).toEqual([]);
    expect(defaultBotModelChain({ ...args, preferredRoute: selected, providersLoading: true })).toEqual([]);
    expect(defaultBotModelChain({ ...args, preferredRoute: selected, availableAgentsLoaded: false })).toEqual([]);
  });
  it('never substitutes another enabled model when the selected model is disabled or removed', () => {
    expect(defaultBotModelChain({ ...args, preferredRoute: selected, isModelEnabled: (_a, _p, m) => m.id !== selected.model })).toEqual([]);
    expect(defaultBotModelChain({ ...args, preferredRoute: { ...selected, model: 'removed-model' } })).toEqual([]);
  });
  it('requires the selected connection and engine to remain available', () => {
    for (const patch of [{ connected: false }, { suspended: true }, { modelDiscoveryFailure: 'offline' }]) {
      expect(defaultBotModelChain({ ...args, preferredRoute: selected, providers: [{ ...providers[0]!, ...patch } as ProviderView] })).toEqual([]);
    }
    expect(defaultBotModelChain({ ...args, preferredRoute: selected, availableAgents: new Set() })).toEqual([]);
    expect(defaultBotModelChain({ ...args, preferredRoute: { ...selected, providerId: 'other-account' } })).toEqual([]);
  });
});
