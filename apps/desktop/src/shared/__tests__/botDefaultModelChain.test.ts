import { describe, expect, it } from 'vitest';
import { type AgentKind, type CatalogModel, type ProviderView } from '@cindy/model-providers';
import { defaultBotModelChain } from '../botDefaultModelChain';
import { resolveNewMakerDefaultTuple } from '../newMakerDefaultTuple';
import { nextBotModelRoute } from '../botModelChain';

function provider(id: string, agent: AgentKind, ids: string[], subscription = false): ProviderView {
  return {
    id, name: id, source: 'builtin', connected: true, agents: [agent],
    auth: { method: subscription ? 'oauth' : 'managed' },
    access: subscription ? { kind: 'subscription', product: id } : { kind: 'managed' },
    routing: { [agent]: {
      upstream: 'https://example.invalid',
      authStrategy: subscription ? 'oauth-passthrough' : 'gateway-key',
    } },
    models: { [agent]: ids.map((model, index) => ({
      id: model, name: model, mode: 'chat', group: 'openai', status: 'active',
      contextWindow: 200_000, efforts: ['low', 'medium'], defaultEffort: 'medium',
      supportsFastMode: false, sortOrder: index,
    } as CatalogModel)) },
  } as ProviderView;
}

const availableAgents = new Set(['cc', 'codex', 'pi'] as const);
function resolve(providers: ProviderView[], agents = availableAgents) {
  return defaultBotModelChain({ providers, providersLoading: false, availableAgents: agents,
    availableAgentsLoaded: true });
}

describe('Bot reuses the client default model policy', () => {
  it('selects Codex and the same default as a normal new task without Gateway', () => {
    const providers = [provider('openai', 'codex', ['gpt-5.6-sol'], true)];
    const first = resolveNewMakerDefaultTuple({ providers, providersLoading: false,
      availableAgents, availableAgentsLoaded: true });
    expect(resolve(providers)[0]).toEqual({ harness: first!.vendor, providerId: first!.providerId,
      model: first!.model, effort: first!.effort, fastMode: false });
    expect(resolve(providers)[0]?.harness).toBe('codex');
  });

  it('uses the exact client Gateway → OpenAI → Anthropic order for fallback', () => {
    const gateway = provider('xd', 'pi', ['z-ai/glm-5.3-flash']);
    gateway.models.pi![0]!.newSessionDefault = ['pi'];
    gateway.models.pi![0]!.supportsImageInput = true;
    const openai = provider('openai', 'codex', ['gpt-5.6-sol'], true);
    const anthropic = provider('anthropic', 'claude-code', ['claude-opus-5'], true);
    const chain = resolve([anthropic, openai, gateway]);
    expect(chain.map((route) => route.providerId)).toEqual(['xd', 'openai', 'anthropic']);
    expect(nextBotModelRoute(chain, chain[0]!)).toEqual(chain[1]);
  });

  it('does not invent GLM when there is no configured source or recommended model', () => {
    expect(resolve([])).toEqual([]);
    expect(resolve([provider('openai', 'codex', ['unconfigured-model'], true)])).toEqual([]);
    expect(resolve([{ ...provider('openai', 'codex', ['gpt-5.6-sol'], true), connected: false }])).toEqual([]);
  });

  it('uses the same installed-runtime gate and alternative harness as the client', () => {
    const openai = provider('openai', 'codex', ['gpt-5.6-sol'], true);
    expect(resolve([openai], new Set())).toEqual([]);
    openai.agents.push('pi');
    openai.models.pi = openai.models.codex;
    expect(resolve([openai], new Set(['pi']))[0]?.harness).toBe('pi');
    expect(resolve([openai])).toHaveLength(1);
  });
});
