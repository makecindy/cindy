import { BUNDLED_CATALOG } from '../../test/catalog-fixture.js';
import { describe, expect, it } from 'vitest';
import { parseCatalog } from '../catalog.js';

import { applySubscriptionDefaults, subscriptionModelKey } from '../subscriptionDefaults.js';
import type { CatalogModel, Provider } from '../types.js';

const model = (id: string): CatalogModel => ({ id, name: id, contextWindow: 100000, efforts: [], defaultEffort: null });
describe('subscription defaults contract', () => {
  it.each([null, [], 'pi', { unknown: 'chat' }, { pi: '' }, { pi: 1 }, { pi: ' chat ' }])('rejects malformed configuration %j', defaults => {
    const catalog = structuredClone(BUNDLED_CATALOG);
    Object.assign(catalog.providers.find(p => p.id === 'openai')!, { newSessionDefaults: defaults });
    expect(() => parseCatalog(catalog)).toThrow('newSessionDefaults');
  });
  it('preserves omitted and explicitly empty policies and all three Harnesses', () => {
    const catalog = structuredClone(BUNDLED_CATALOG);
    const provider = catalog.providers.find(p => p.id === 'openai')!;
    for (const defaults of [undefined, {}, { 'claude-code': 'chatgpt/chat', codex: 'chat', pi: 'chatgpt/chat' }]) {
      provider.newSessionDefaults = defaults;
      expect(parseCatalog(structuredClone(catalog)).providers.find(p => p.id === 'openai')?.newSessionDefaults).toEqual(defaults);
    }
    provider.access = { kind: 'api' };
    expect(() => parseCatalog(catalog)).toThrow('newSessionDefaults');
  });
  it('marks only existing members of each Harness and removes stale marks on refresh', () => {
    const provider: Provider = { ...BUNDLED_CATALOG.providers.find(p => p.id === 'openai')!,
      newSessionDefaults: { codex: 'chat', pi: 'chatgpt/chat' },
      models: { codex: [model('chat'), model('chat[1m]')], pi: [{ ...model('chatgpt/chat'), defaultEnabled: false }],
        'claude-code': [model('chatgpt/chat')] },
    };
    const projected = applySubscriptionDefaults(provider);
    expect(projected.models.codex?.map(m => m.newSessionDefault)).toEqual([['codex'], undefined]);
    expect(projected.models.pi?.[0]).toMatchObject({ newSessionDefault: ['pi'], defaultEnabled: false });
    expect(projected.models['claude-code']?.[0].newSessionDefault).toBeUndefined();
    expect(provider.models.codex?.[0].newSessionDefault).toBeUndefined();
    expect(applySubscriptionDefaults({ ...projected, newSessionDefaults: {} }).models.codex?.[0].newSessionDefault).toBeUndefined();
    expect(applySubscriptionDefaults({ ...provider, models: { pi: [] } }).models.pi).toEqual([]);
    expect(applySubscriptionDefaults({ ...provider, newSessionDefaults: undefined }).models).toBe(provider.models);
    expect(subscriptionModelKey('openai', 'codex/chat')).toBe('codex/chat');
    expect(subscriptionModelKey('other', 'chatgpt/chat')).toBe('chatgpt/chat');
  });
});
