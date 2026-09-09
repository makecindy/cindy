import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BUNDLED_CATALOG, type AgentKind, type Catalog } from '@cindy/model-providers';

const state = vi.hoisted(() => ({
  claudeOAuth: false, codexOAuth: false, gateway: true,
  limits: new Map<string, number>(),
}));
vi.mock('../auth-adapters.js', () => ({
  readClaudeApiKey: () => state.gateway ? 'fixture-key' : null,
  desktopCodexAuthAdapter: { hasCodexOAuthLoginReadOnly: () => state.codexOAuth },
}));
vi.mock('../claude-credentials-store.js', () => ({ hasClaudeAiOAuth: () => state.claudeOAuth }));
vi.mock('../provider-route.js', () => ({
  gatewayDefaultRouteDecision: () => state.gateway ? { upstreamOverride: 'https://example.invalid' } : null,
}));
vi.mock('../model-context-limit-store.js', () => ({
  readModelContextLimit: (agent: string, provider: string, model: string) =>
    state.limits.get(`${agent}:${provider}:${model}`) ?? null,
}));

import { resolveConfiguredContextWindow, resolveDesktopModelContextProviderId } from '../model-context-settings.js';
import { shouldRebuildForModelWindowSwitch } from '../../maker-ipc/contextOverflowRollover.js';

function dualCatalog(agent: AgentKind): Catalog {
  const catalog = structuredClone(BUNDLED_CATALOG) as Catalog;
  for (const provider of catalog.providers) {
    provider.models[agent] = ['xd', agent === 'claude-code' ? 'anthropic' : 'openai'].includes(provider.id)
      ? [{ id: 'shared-model', name: 'Shared', contextWindow: provider.id === 'xd' ? 128_000 : 272_000,
        contextWindowVerified: true, efforts: [], defaultEffort: null }]
      : [];
  }
  return catalog;
}

beforeEach(() => {
  state.claudeOAuth = false;
  state.codexOAuth = false;
  state.gateway = true;
  state.limits.clear();
});

describe('implicit context settings use the startup source in history protection', () => {
  it.each(['claude-code', 'codex'] as const)('%s resolves a smaller XD budget before history switching', (agent) => {
    const catalog = dualCatalog(agent);
    state.limits.set(`${agent}:xd:shared-model`, 100_000);
    // Claude login does not override the existing gateway default.
    state.claudeOAuth = true;
    expect(resolveDesktopModelContextProviderId(catalog, agent, null, 'shared-model')).toBe('xd');
    const target = resolveConfiguredContextWindow(catalog, agent, null, 'shared-model');
    expect(target).toBe(100_000);
    expect(shouldRebuildForModelWindowSwitch({
      contextTokens: 180_000, currentContextWindow: 272_000, targetContextWindow: target!,
    })).toBe(true);
    state.limits.delete(`${agent}:xd:shared-model`);
    expect(resolveConfiguredContextWindow(catalog, agent, null, 'shared-model')).toBe(128_000);
  });

  it.each(['claude-code', 'codex'] as const)('%s selects its implicit subscription when applicable', (agent) => {
    const catalog = dualCatalog(agent);
    const provider = agent === 'claude-code' ? 'anthropic' : 'openai';
    state.gateway = agent === 'codex'; // Codex subscription wins even with an available gateway.
    state.claudeOAuth = true;
    state.codexOAuth = true;
    state.limits.set(`${agent}:${provider}:shared-model`, 80_000);
    state.limits.set(`${agent}:xd:shared-model`, 120_000);
    expect(resolveDesktopModelContextProviderId(catalog, agent, null, 'shared-model')).toBe(provider);
    expect(resolveConfiguredContextWindow(catalog, agent, null, 'shared-model')).toBe(80_000);
    expect(resolveConfiguredContextWindow(catalog, agent, 'xd', 'shared-model')).toBe(120_000);
  });

  it.each(['claude-code', 'codex', 'pi'] as const)('%s keeps the physical ceiling below a larger working override', (agent) => {
    const catalog = dualCatalog(agent);
    state.limits.set(`${agent}:xd:shared-model`, 1_000_000);
    expect(resolveConfiguredContextWindow(catalog, agent, null, 'shared-model')).toBe(128_000);
    // Stored/native budget stays untouched by the history ceiling.
    expect(state.limits.get(`${agent}:xd:shared-model`)).toBe(1_000_000);
  });

  it.each(['claude-code', 'codex', 'pi'] as const)('%s implicit history uses the saved budget up to the route maximum', (agent) => {
    const catalog = dualCatalog(agent);
    const row = catalog.providers.find(provider => provider.id === 'xd')!.models[agent]![0]!;
    row.contextWindow = 272_000;
    row.contextWindowMax = 1_000_000;
    state.limits.set(`${agent}:xd:shared-model`, 1_000_000);
    expect(resolveConfiguredContextWindow(catalog, agent, null, 'shared-model')).toBe(1_000_000);
    state.limits.delete(`${agent}:xd:shared-model`);
    expect(resolveConfiguredContextWindow(catalog, agent, null, 'shared-model')).toBe(272_000);
  });

  it.each(['claude-code', 'codex', 'pi'] as const)('%s protects history with an explicit budget on an unverified route', (agent) => {
    const catalog = dualCatalog(agent);
    const row = catalog.providers.find(provider => provider.id === 'xd')!.models[agent]![0]!;
    row.contextWindowVerified = false;
    expect(resolveConfiguredContextWindow(catalog, agent, 'xd', 'shared-model')).toBeNull();
    state.limits.set(`${agent}:xd:shared-model`, 100_000);
    const target = resolveConfiguredContextWindow(catalog, agent, 'xd', 'shared-model');
    expect(target).toBe(100_000);
    expect(shouldRebuildForModelWindowSwitch({ contextTokens: 180_000, currentContextWindow: 272_000,
      targetContextWindow: target! })).toBe(true);
    expect(resolveConfiguredContextWindow(catalog, agent, 'xd', 'missing-model')).toBeNull();
    const provider = catalog.providers.find(provider => provider.id === 'xd')!;
    provider.routing[agent] = { ...provider.routing[agent]!, disabled: true };
    expect(resolveConfiguredContextWindow(catalog, agent, 'xd', 'shared-model')).toBeNull();
  });

  it('keeps unknown Claude sources unknown without borrowing another provider', () => {
    state.gateway = false;
    expect(resolveConfiguredContextWindow(dualCatalog('claude-code'), 'claude-code', null, 'shared-model')).toBeNull();
  });

  it('keeps discounted Codex models on XD when the subscription is available', () => {
    state.codexOAuth = true;
    const catalog = dualCatalog('codex');
    for (const provider of catalog.providers) {
      for (const model of provider.models.codex ?? []) model.id = 'codex/shared-model';
    }
    state.limits.set('codex:xd:codex/shared-model', 100_000);
    expect(resolveConfiguredContextWindow(catalog, 'codex', null, 'codex/shared-model')).toBe(100_000);
  });
});
