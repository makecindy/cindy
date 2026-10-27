import { describe, expect, it } from 'vitest';
import type { ProviderView } from '@cindy/model-providers';
import { defaultBotModelChain } from '../botDefaultModelChain';

const providers = [{ id: 'openai', source: 'builtin', connected: true, agents: ['codex'],
  auth: { method: 'oauth' },
  access: { kind: 'subscription', product: 'ChatGPT' },
  routing: { codex: { upstream: 'https://example.invalid', authStrategy: 'oauth-passthrough' } },
  models: { codex: ['gpt-6.1-sol', 'enabled-model'].map(id => ({ id, mode: 'chat', status: 'active', efforts: ['medium', 'high'], defaultEffort: 'high' })) },
}] as unknown as ProviderView[];
const args = { providers, providersLoading: false, availableAgents: new Set(['codex'] as const), availableAgentsLoaded: true };

// unit: defaults must resolve without a new-task draft. The old contract
// required the draft and copied its model and tuning into teammate defaults.
describe('independent teammate defaults', () => {
  it('uses one product recommendation with catalog tuning and no fallback chain', () => {
    expect(defaultBotModelChain(args)).toEqual([{
      harness: 'codex', providerId: 'openai', model: 'gpt-6.1-sol', effort: 'high', fastMode: false,
    }]);
  });
  it('respects enabled models and does not manufacture a choice when none remain', () => {
    expect(defaultBotModelChain({ ...args, isModelEnabled: (_a, _p, m) => m.id === 'enabled-model' })[0]?.model).toBe('enabled-model');
    expect(defaultBotModelChain({ ...args, isModelEnabled: () => false })).toEqual([]);
  });
  it('waits for catalog and engine readiness', () => {
    expect(defaultBotModelChain({ ...args, providersLoading: true })).toEqual([]);
    expect(defaultBotModelChain({ ...args, availableAgentsLoaded: false })).toEqual([]);
  });
  it('requires an available connection and engine', () => {
    for (const patch of [{ connected: false }, { suspended: true }, { modelDiscoveryFailure: 'offline' }]) {
      expect(defaultBotModelChain({ ...args, providers: [{ ...providers[0]!, ...patch } as ProviderView] })).toEqual([]);
    }
    expect(defaultBotModelChain({ ...args, availableAgents: new Set() })).toEqual([]);
  });
});
