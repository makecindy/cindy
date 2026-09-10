import { describe, expect, it } from 'vitest';
import type { Catalog, CatalogModel, Provider } from '@cindy/model-providers';
import { projectSessionContextWindow, resolveSessionContextWindow, resolveVerifiedContextWindow } from '../sessionContextWindow';
import { shouldRebuildForModelWindowSwitch } from '../../main/maker-ipc/contextOverflowRollover';

const model: CatalogModel = {
  id: 'gpt-6-astra',
  name: 'Astra',
  contextWindow: 272_000,
  contextWindowVerified: true,
  efforts: ['medium'],
  defaultEffort: 'medium',
};
function provider(id: string, row: CatalogModel = model): Provider {
  return {
    id,
    name: id,
    source: 'builtin',
    agents: ['codex', 'claude-code', 'pi'],
    auth: { method: 'oauth' },
    routing: {},
    models: { codex: [row], 'claude-code': [row], pi: [row] },
  };
}
const session = {
  agentKind: 'cc',
  model: model.id,
  providerId: 'openai',
  contextTokens: 140_500,
  contextWindow: 1_050_000,
};
const catalog: Pick<Catalog, 'providers'> = { providers: [provider('openai')] };

describe('session context read projection', () => {
  it.each(['claude-code', 'codex', 'pi'] as const)('keeps %s history protection bounded when the budget exceeds capacity', (agent) => {
    const routes = { providers: [provider('local', { ...model, contextWindow: 128_000 })] };
    const target = resolveVerifiedContextWindow(routes, agent, 'local', model.id, 1_000_000);
    expect(target).toBe(128_000);
    expect(shouldRebuildForModelWindowSwitch({
      contextTokens: 200_000, currentContextWindow: 272_000, targetContextWindow: target!,
    })).toBe(true);
    expect(resolveVerifiedContextWindow(routes, agent, 'local', model.id, 100_000)).toBe(100_000);
    expect(resolveVerifiedContextWindow(routes, agent, 'local', model.id)).toBe(128_000);
    expect(routes.providers[0].models[agent]?.[0].contextWindow).toBe(128_000);
    expect(resolveVerifiedContextWindow(routes, agent, 'missing', model.id, 1_000_000)).toBeNull();
    const unverified = { providers: [provider('local', { ...model, contextWindowVerified: false })] };
    expect(resolveVerifiedContextWindow(unverified, agent, 'local', model.id, 1_000_000)).toBeNull();
  });

  it.each(['claude-code', 'codex', 'pi'] as const)('allows %s explicit budgets above the default up to the verified maximum', (agent) => {
    const routes = { providers: [provider('xd', { ...model, contextWindow: 272_000, contextWindowMax: 1_000_000 })] };
    for (const budget of [100_000, 800_000, 1_000_000]) {
      expect(resolveVerifiedContextWindow(routes, agent, 'xd', model.id, budget)).toBe(budget);
    }
    expect(resolveVerifiedContextWindow(routes, agent, 'xd', model.id, 2_000_000)).toBe(1_000_000);
    const raised = resolveVerifiedContextWindow(routes, agent, 'xd', model.id, 1_000_000)!;
    expect(shouldRebuildForModelWindowSwitch({
      contextTokens: 700_000, currentContextWindow: 800_000, targetContextWindow: raised,
    })).toBe(false);
    const reset = resolveVerifiedContextWindow(routes, agent, 'xd', model.id, null)!;
    expect(reset).toBe(272_000);
    expect(shouldRebuildForModelWindowSwitch({
      contextTokens: 700_000, currentContextWindow: raised, targetContextWindow: reset,
    })).toBe(true);
    const unverified = { providers: [provider('xd', { ...model, contextWindowMax: 1_000_000, contextWindowVerified: false })] };
    expect(resolveVerifiedContextWindow(unverified, agent, 'xd', model.id, 1_000_000)).toBeNull();
  });

  it.each([undefined, 0, -1, NaN, Infinity])('falls back to the verified window for invalid maximum %s', (contextWindowMax) => {
    const routes = { providers: [provider('xd', { ...model, contextWindowMax })] };
    expect(resolveVerifiedContextWindow(routes, 'codex', 'xd', model.id, 1_000_000)).toBe(272_000);
  });

  it.each(['cc', 'claude-code', 'pi', 'codex'])(
    'preserves the applied %s history budget when catalog or settings change',
    (agentKind) => {
      for (const contextWindow of [1_000, 32_000, 500_000, 1_050_000]) {
        const saved = { ...session, agentKind, contextWindow };
        expect(projectSessionContextWindow(saved, () => 272_000)).toBe(saved);
      }
      const unknown = { ...session, agentKind, contextWindow: 0 };
      expect(projectSessionContextWindow(unknown, () => 32_000))
        .toEqual({ ...unknown, contextWindow: 32_000 });
    },
  );

  it('uses the actual provider, preserving explicit long-window overrides', () => {
    const routes = {
      providers: [provider('openai'), provider('custom', { ...model, contextWindow: 872_000 })],
    };
    expect(resolveSessionContextWindow(routes, { ...session, providerId: 'custom' })).toBe(872_000);
    expect(resolveSessionContextWindow(routes, session)).toBe(272_000);
    expect(resolveSessionContextWindow(routes, { ...session, providerId: null })).toBeNull();
    expect(resolveSessionContextWindow(routes, { ...session, providerId: 'missing' })).toBeNull();
  });

  it('preserves Codex and Pi runtime snapshots and unknown or unverified routes', () => {
    for (const saved of [
      { ...session, agentKind: 'pi' },
      { ...session, agentKind: 'codex', contextWindow: 258_400 },
      { ...session, agentKind: 'codex', contextWindow: 828_400 },
      { ...session, model: '' },
    ]) {
      expect(
        projectSessionContextWindow(saved, (row) => resolveSessionContextWindow(catalog, row)),
      ).toBe(saved);
    }
    const unknown = { providers: [provider('openai', { ...model, contextWindowVerified: false })] };
    expect(resolveSessionContextWindow(unknown, session)).toBeNull();
    expect(resolveSessionContextWindow({ providers: [] }, session)).toBeNull();
  });

  it('follows catalog refresh without retaining an earlier result', () => {
    const before = { providers: [provider('openai', { ...model, contextWindow: 1_050_000 })] };
    expect(resolveSessionContextWindow(before, session)).toBe(1_050_000);
    expect(resolveSessionContextWindow(catalog, session)).toBe(272_000);
  });
});
