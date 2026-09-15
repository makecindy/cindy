import { BUNDLED_CATALOG } from '../../test/catalog-fixture.js';
import { describe, expect, it } from 'vitest';
import { installServerCatalog, EMPTY_CATALOG } from '../builtin.js';
import { parseCatalog } from '../catalog.js';
import { loadCatalogWithSource } from '../source.js';
import { providerCatalogForPi, providerModelRecord, PROVIDER_MODEL_CATALOG } from '../providerModelCatalog.js';

describe('server-owned transport metadata', () => {
  it('replaces indexes and Pi transport values on each publication, including removal', () => {
    const next = structuredClone(BUNDLED_CATALOG);
    const row = next.providerModelCatalog!.providers.openai.find(model => model.id === 'gpt-6-astra')!;
    const original = providerModelRecord(row.id, row.upstream, row.execution.pi.api as 'openai-responses');
    expect(original).toBeDefined();
    row.contextWindow = 654321;
    row.execution.pi.compat = { supportsStore: false };
    installServerCatalog(parseCatalog(next));
    expect(providerModelRecord(row.id, row.upstream, row.execution.pi.api as 'openai-responses')).toMatchObject({ contextWindow: 654321 });
    expect(providerCatalogForPi().providers.openai.find(model => model.id === row.id)).toMatchObject({ contextWindow: 654321, compat: { supportsStore: false } });
    const deleted = structuredClone(next);
    deleted.providerModelCatalog!.providers.openai = [];
    installServerCatalog(parseCatalog(deleted));
    expect(PROVIDER_MODEL_CATALOG.providers.openai).toEqual([]);
    expect(providerCatalogForPi().providers.openai).toEqual([]);
    installServerCatalog(EMPTY_CATALOG);
    expect(providerModelRecord(row.id, row.upstream)).toBeUndefined();
    expect(providerCatalogForPi().providers).toEqual({});
  });
  it('uses the last complete server publication offline without bundling or resynchronizing Pi data', async () => {
    const text = JSON.stringify(BUNDLED_CATALOG);
    const result = await loadCatalogWithSource({ baseUrl: 'https://catalog.example.test' }, {
      fetchText: async () => { throw new Error('offline'); }, readCache: async () => text,
    });
    installServerCatalog(result.catalog);
    expect(result.source).toBe('cache');
    expect(PROVIDER_MODEL_CATALOG.providers).toEqual(BUNDLED_CATALOG.providerModelCatalog!.providers);
  });
  it('rejects invalid model transport metadata before installation', () => {
    const next = structuredClone(BUNDLED_CATALOG);
    next.providerModelCatalog!.providers.openai[0].execution.pi.api = 'unsupported';
    expect(() => parseCatalog(next)).toThrow('execution.pi.api');
  });
});
