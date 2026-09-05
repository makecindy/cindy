import { describe, expect, it } from 'vitest';
import type { Catalog, CatalogModel, Provider } from '@cindy/model-providers';
import { projectSessionContextWindow, resolveSessionContextWindow } from '../sessionContextWindow';

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
  agentKind: 'codex',
  model: model.id,
  providerId: 'openai',
  contextTokens: 140_500,
  contextWindow: 1_050_000,
};
const catalog: Pick<Catalog, 'providers'> = { providers: [provider('openai')] };

describe('session context read projection', () => {
  it.each(['cc', 'codex'])(
    'corrects %s history without mutating its stored snapshot',
    (agentKind) => {
      const saved = { ...session, agentKind };
      const result = projectSessionContextWindow(saved, (row) =>
        resolveSessionContextWindow(catalog, row),
      );
      expect(result).toEqual({ ...saved, contextWindow: 272_000 });
      expect(saved.contextWindow).toBe(1_050_000);
      expect(Math.round((result.contextTokens / result.contextWindow) * 100)).toBe(52);
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

  it('preserves Pi runtime snapshots and unknown or unverified routes', () => {
    for (const saved of [
      { ...session, agentKind: 'pi' },
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
