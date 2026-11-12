import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUNDLED_CATALOG, type AgentKind, type Catalog, type CustomProviderConfig } from '@cindy/model-providers';

const state = vi.hoisted(() => ({
  claudeOAuth: false, codexOAuth: false, gateway: true,
  limits: new Map<string, number>(),
}));
vi.mock('../auth-adapters.js', () => ({
  readClaudeApiKey: () => state.gateway ? 'fixture-key' : null,
  desktopCodexAuthAdapter: { hasCodexOAuthLoginReadOnly: () => state.codexOAuth },
}));
vi.mock('../claude-native-auth.js', () => ({ hasClaudeNativeLogin: () => state.claudeOAuth }));
vi.mock('../provider-route.js', () => ({
  gatewayDefaultRouteDecision: () => state.gateway ? { upstreamOverride: 'https://example.invalid' } : null,
}));
vi.mock('../model-context-limit-store.js', () => ({
  readModelContextLimit: (agent: string, provider: string, model: string) =>
    state.limits.get(`${agent}:${provider}:${model}`) ?? null,
}));

import { resolveConfiguredContextWindow, resolveDesktopModelContextProviderId, resolveDesktopModelEfforts } from '../model-context-settings.js';
import { getActiveCatalog, setActiveCatalog, setCustomProviderConfigs, setCustomProviders } from '../active-catalog.js';
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

describe('route efforts follow the session source', () => {
  it('reads the selected provider instead of another same-ID route (#5402)', () => {
    const catalog = dualCatalog('claude-code');
    for (const provider of catalog.providers) {
      for (const model of provider.models['claude-code'] ?? []) {
        model.efforts = provider.id === 'xd' ? ['low', 'medium', 'high', 'max'] : ['low', 'high', 'xhigh', 'max'];
      }
    }
    expect(resolveDesktopModelEfforts(catalog, 'claude-code', 'anthropic', 'shared-model'))
      .toEqual(['low', 'high', 'xhigh', 'max']);
    expect(resolveDesktopModelEfforts(catalog, 'claude-code', 'xd', 'shared-model'))
      .toEqual(['low', 'medium', 'high', 'max']);
    // Implicit sessions use the same startup source as the context settings (gateway here).
    expect(resolveDesktopModelEfforts(catalog, 'claude-code', null, 'shared-model'))
      .toEqual(['low', 'medium', 'high', 'max']);
    expect(resolveDesktopModelEfforts(catalog, 'claude-code', 'missing', 'shared-model')).toBeNull();
  });
});

// Exercise the real catalog projection before applying task budgets; no network or credentials.
describe('custom fallback capacity provenance through the active catalog', () => {
  afterEach(() => {
    setCustomProviders([]);
    setActiveCatalog(BUNDLED_CATALOG);
  });

  it.each(['claude-code', 'codex', 'pi'] as const)('%s does not turn an unknown working fallback into a physical cap', (agent) => {
    const models = [
      { id: 'gpt-private-next', name: 'Unknown' },
      { id: 'gpt-declared-window', name: 'Reported window', discoveredMetadata: { contextWindow: 800_000 } },
      { id: 'gpt-declared-max', name: 'Reported maximum', discoveredMetadata: { contextWindowMax: 600_000 } },
    ];
    const config: CustomProviderConfig = {
      id: 'custom:capacity-fixture', name: 'Capacity fixture',
      runtimes: Object.fromEntries(['claude-code', 'codex', 'pi'].map(kind => [kind, {
        baseUrl: 'https://relay.example/v1', wireProtocol: 'openai-responses', models,
      }])),
    };
    setActiveCatalog(BUNDLED_CATALOG);
    setCustomProviderConfigs([config]);
    const catalog = getActiveCatalog();
    const rows = catalog.providers.find(provider => provider.id === config.id)!.models[agent]!;
    const unknown = rows.find(model => model.id === 'gpt-private-next')!;
    expect(unknown.contextWindow).toBe(272_000);
    expect(unknown.contextWindowVerified).not.toBe(true);
    for (const budget of [800_000, 1_000_000]) {
      expect(resolveConfiguredContextWindow(catalog, agent, config.id, unknown.id, budget)).toBe(budget);
    }
    expect(unknown.contextWindowMax).toBeUndefined();
    const reported = rows.find(model => model.id === 'gpt-declared-window')!;
    expect(reported.contextWindow).toBe(272_000);
    expect(reported.contextWindowVerified).toBe(true);
    expect(reported.contextWindowMax).toBe(800_000);
    expect(resolveConfiguredContextWindow(catalog, agent, config.id, reported.id, 1_000_000)).toBe(800_000);
    const maximumOnly = rows.find(model => model.id === 'gpt-declared-max')!;
    expect(maximumOnly.contextWindowVerified).toBe(false);
    expect(maximumOnly.contextWindowMax).toBe(600_000);
    expect(resolveConfiguredContextWindow(catalog, agent, config.id, maximumOnly.id, 1_000_000)).toBe(600_000);
  });
});
