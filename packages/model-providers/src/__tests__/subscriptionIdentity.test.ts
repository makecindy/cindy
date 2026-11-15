import { describe, expect, it } from 'vitest';
import type { ProviderView } from '../registry.js';
import type { CatalogModel } from '../types.js';
import { sameRunLocationProvider, duplicateSubscriptionProviders, sameSubscriptionAccounts } from '../subscriptionIdentity.js';
const model: CatalogModel = { id: 'sol', name: 'Sol', contextWindow: 200_000, efforts: ['high'], defaultEffort: 'high' };
const source = (id: string, extra: Partial<ProviderView> = {}) => ({
  id, connected: true, agents: ['codex'], models: { codex: [model] },
  subscriptionAccountKeys: ['person-workspace'], ...extra,
} as ProviderView);
describe('subscription presentation identity', () => {
  it('folds verified logins even with different connection ids, without changing routes', () => {
    const local = source('openai'); const remote = source('independent');
    expect(sameRunLocationProvider(local, remote)).toBe(true);
    expect([...duplicateSubscriptionProviders([local, remote])]).toEqual([['independent', 'openai']]);
    expect(remote.id).toBe('independent');
  });
  it('keeps different workspaces, unknown old peers, additional models and paused sources separate', () => {
    const local = source('openai');
    for (const other of [
      source('independent', { subscriptionAccountKeys: ['other-workspace'] }),
      source('independent', { subscriptionAccountKeys: undefined }),
      source('independent', { suspended: true }),
      source('independent', { models: { codex: [{ ...model, id: 'extra', name: 'Extra' }] } }),
      source('independent', { subscriptionAccountKeys: ['person-workspace', 'second-person'] }),
    ]) expect(duplicateSubscriptionProviders([local, other]).size).toBe(0);
    expect(sameRunLocationProvider(local, source('openai', { subscriptionAccountKeys: undefined }))).toBe(false);
  });
  it('retains different visible models and rejects malformed duplicate identity sets', () => {
    const a = source('a'); const b = source('b');
    expect(duplicateSubscriptionProviders([a, b], id => id === 'b').size).toBe(0);
    expect(sameSubscriptionAccounts(source('a', { subscriptionAccountKeys: ['a', 'a'] }), source('b', { subscriptionAccountKeys: ['a', 'b'] }))).toBe(false);
    const withImages = source('a', { imageModels: [{ id: 'image', name: 'Image' }] });
    expect(duplicateSubscriptionProviders([withImages, b]).get('b')).toBe('a');
    expect(duplicateSubscriptionProviders([b, withImages]).size).toBe(0);
  });
  it('never folds groups; a logged-out built-in can still borrow a matching route', () => {
    const group = { ...source('group'), group: { members: [] } };
    expect(duplicateSubscriptionProviders([group, source('openai')]).size).toBe(0);
    expect(sameRunLocationProvider(source('openai', { connected: false, subscriptionAccountKeys: undefined }), source('openai'))).toBe(true);
  });
  // Review #10637: the same GPT account and model can have different controls per connection.
  it.each([
    { efforts: ['ultra'] },
    { reasoningEfforts: ['xhigh'] },
    { effortsUnknown: true },
    { thinkingToggle: true },
    { supportsFastMode: true },
    { supportsUltrafastMode: true },
    { fastModelId: 'sol-fast' },
  ])('keeps the connection offering extra selectable capabilities: %j', capabilities => {
    const ordinary = source('openai');
    const additional = source('independent', {
      models: { codex: [{ ...ordinary.models.codex![0], ...capabilities }] } as ProviderView['models'],
    });
    expect(duplicateSubscriptionProviders([ordinary, additional]).size).toBe(0);
    expect(duplicateSubscriptionProviders([additional, { ...additional, id: 'same' }]).get('same')).toBe('independent');
  });
});
