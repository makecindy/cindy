import { describe, expect, it } from 'vitest';
import { BUNDLED_CATALOG, parseCatalog } from '../catalog.js';
import { connectedProvidersForAgent, resolveRoute } from '../registry.js';
import { unifiedModelEntries } from '../unifiedSelection.js';
import { modelProtocolComparison } from '../modelProtocol.js';
import type { CatalogModel, Provider } from '../types.js';

const cursor = BUNDLED_CATALOG.providers.find((provider) => provider.id === 'cursor')!;
const model: CatalogModel = {
  id: 'account-model', name: 'Account model', contextWindow: 100_000,
  efforts: [], defaultEffort: null,
};

describe('native Cursor provider', () => {
  it('ships no invented model or HTTP route', () => {
    expect(cursor).toMatchObject({ agents: ['cursor'], models: { cursor: [] }, routing: {} });
    expect(() => parseCatalog(BUNDLED_CATALOG)).not.toThrow();
  });
  it('selects only live native membership without reusing HTTP bridges', () => {
    const provider = { ...cursor, connected: true, models: { cursor: [model] } };
    expect(connectedProvidersForAgent([provider], 'cursor')).toEqual([provider]);
    expect(connectedProvidersForAgent([{ ...provider, connected: false }], 'cursor')).toEqual([]);
    expect(unifiedModelEntries({ providers: [provider] })).toMatchObject([{ candidates: ['cursor'], recommended: 'cursor' }]);
    expect(resolveRoute([provider], 'cursor', model.id, 'cursor')).toBeNull();
    expect(modelProtocolComparison(provider, { cursor: model }).forAgent('cursor')).toEqual({
      harness: null, outbound: null, localConversion: false, mode: 'unknown',
    });
  });
  it('rejects Cursor compatibility routes and third-party native impersonation', () => {
    const parse = (provider: Provider) => parseCatalog({ ...BUNDLED_CATALOG, providers: [provider] });
    expect(() => parse({ ...cursor, id: 'custom-cursor' })).toThrow();
    expect(() => parse({ ...cursor, routing: { cursor: {
      upstream: 'https://example.com', authStrategy: 'none',
    } } })).toThrow();
  });
});
