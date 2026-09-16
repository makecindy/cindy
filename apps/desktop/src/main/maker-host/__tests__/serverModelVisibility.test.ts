import { afterEach, describe, expect, it } from 'vitest';
import { isModelVisible, type Catalog } from '@cindy/model-providers';
import { BUNDLED_CATALOG } from '../../../../../../packages/model-providers/test/catalog-fixture.js';
import { getActiveCatalog, setActiveCatalog, setXdGatewayModels } from '../active-catalog.js';

afterEach(() => { setXdGatewayModels([]); setActiveCatalog(BUNDLED_CATALOG); });

describe('server-owned model visibility', () => {
  it.each(['claude-code', 'codex', 'pi'] as const)('preserves Gateway display flags for %s without ranking families, variants or discounts', agent => {
    const catalog = structuredClone(BUNDLED_CATALOG) as Catalog;
    catalog.modelRegistry = { schemaVersion: 5, updatedAt: '2026-09-15T00:00:00.000Z', models: [] };
    setActiveCatalog(catalog);
    const rows = [
      { id: 'openai/gpt-5.4', defaultEnabled: true },
      { id: 'codex/gpt-6-astra', defaultEnabled: true },
      { id: 'new/model-preview', defaultEnabled: true },
      { id: 'new/model[1m]', defaultEnabled: true },
      { id: 'new/model:auto', defaultEnabled: true },
      { id: 'new/hidden', defaultEnabled: false },
    ];
    const publish = () => setXdGatewayModels(rows.map(row => ({ ...row, agents: [agent], contextWindow: 128000,
      perAgent: { [agent]: { wireProtocol: agent === 'claude-code' ? 'anthropic-messages' : 'openai-responses' } },
    })), { authoritative: true });
    publish();
    const models = () => getActiveCatalog().providers.find(p => p.id === 'xd')!.models[agent]!;
    for (const row of rows) expect(models().find(m => m.id === row.id)?.defaultEnabled).toBe(row.defaultEnabled);
    rows[0].defaultEnabled = false;
    rows[5].defaultEnabled = true;
    publish();
    expect(models().find(m => m.id === rows[0].id)?.defaultEnabled).toBe(false);
    expect(models().find(m => m.id === rows[5].id)?.defaultEnabled).toBe(true);
    expect(isModelVisible(true, false)).toBe(true);
    expect(isModelVisible(false, true)).toBe(false);
    expect(isModelVisible(undefined, true)).toBe(true);
    expect(isModelVisible(undefined, false)).toBe(false);
  });

  it('keeps multiple server-enabled subscription generations and follows subsequent publications', () => {
    const catalog = structuredClone(BUNDLED_CATALOG) as Catalog;
    catalog.modelRegistry = { schemaVersion: 5, updatedAt: '2026-09-15T00:00:00.000Z', models: [] };
    const provider = catalog.providers.find(p => p.id === 'anthropic')!;
    provider.models['claude-code'] = ['claude-opus-4-8', 'claude-opus-5', 'claude-unlisted-preview'].map(id => ({
      id, name: id, contextWindow: 128000, efforts: [], defaultEffort: null, defaultEnabled: true,
    }));
    provider.newSessionDefaults = {};
    catalog.modelRegistry.models = provider.models['claude-code'].map(model => ({
      id: model.id, name: model.name, contextWindow: model.contextWindow, efforts: [], defaultEffort: null,
      defaultEnabled: model.defaultEnabled, status: 'active',
      routes: [{ providerId: 'anthropic', modelId: model.id, agents: ['claude-code'] }],
    }));
    setActiveCatalog(catalog);
    expect(getActiveCatalog().providers.find(p => p.id === 'anthropic')!.models['claude-code']!.map(m => m.defaultEnabled)).toEqual([true, true, true]);
    provider.models['claude-code'][0].defaultEnabled = false;
    catalog.modelRegistry.models[0].defaultEnabled = false;
    setActiveCatalog(structuredClone(catalog));
    expect(getActiveCatalog().providers.find(p => p.id === 'anthropic')!.models['claude-code']!.map(m => m.defaultEnabled)).toEqual([false, true, true]);
  });
});
