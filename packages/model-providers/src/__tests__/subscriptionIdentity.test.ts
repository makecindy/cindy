import { describe, expect, it } from 'vitest';
import type { ProviderView } from '../registry.js';
import type { CatalogModel } from '../types.js';
import { sameRunLocationProvider, duplicateSubscriptionProviders, sameSubscriptionAccounts, listedSourceFolds } from '../subscriptionIdentity.js';
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

// One rule for Settings, the desktop picker and the phone picker: an equal source is listed once.
describe('listedSourceFolds', () => {
  const hidden = (folds: ReturnType<typeof listedSourceFolds>) => [
    ...[...folds.hiddenBase].map(id => `base:${id}`),
    ...[...folds.hiddenOther].flatMap(([device, ids]) => [...ids].map(id => `${device}:${id}`)),
  ].sort();
  it('lists an equal source on another computer once, under the base computer', () => {
    expect(hidden(listedSourceFolds({ base: [source('openai')], others: [{ deviceId: 'rog', providers: [source('openai')] }] })))
      .toEqual(['rog:openai']);
  });
  it('keeps groups, different accounts and sources with more models', () => {
    const others = [{ deviceId: 'rog', providers: [
      { ...source('group'), group: { members: [] } } as ProviderView,
      source('other', { subscriptionAccountKeys: ['other-workspace'] }),
      source('more', { models: { codex: [model, { ...model, id: 'extra', name: 'Extra' }] } }),
    ] }];
    expect(hidden(listedSourceFolds({ base: [source('openai')], others }))).toEqual([]);
  });
  it('folds equal sources offered by two other computers when the base computer has none', () => {
    const others = [{ deviceId: 'rog', providers: [source('openai')] }, { deviceId: 'mini', providers: [source('openai-2')] }];
    expect(hidden(listedSourceFolds({ base: [], others }))).toEqual(['mini:openai-2']);
  });
  // Review #11044: entries not covered by this computer's source still fold with each other.
  it('folds two other computers offering more than this computer, keeping one of them', () => {
    const more = (id: string) => source(id, { models: { codex: [model, { ...model, id: 'extra', name: 'Extra' }] } });
    const others = [{ deviceId: 'rog', providers: [more('openai')] }, { deviceId: 'mini', providers: [more('openai')] }];
    expect(hidden(listedSourceFolds({ base: [source('openai')], others }))).toEqual(['mini:openai']);
  });
  it('keeps the current source listed and lets its equal step aside', () => {
    const others = [{ deviceId: 'rog', providers: [source('openai')] }];
    expect(hidden(listedSourceFolds({ base: [source('openai')], others, current: { deviceId: 'rog', providerId: 'openai' } })))
      .toEqual(['base:openai']);
    expect(hidden(listedSourceFolds({ base: [source('a'), source('b')], current: { deviceId: null, providerId: 'b' } })))
      .toEqual(['base:a']);
  });
  it('honors the run location only where asked', () => {
    const base = [{ ...source('openai'), runLocation: 'rog' } as ProviderView];
    const others = [{ deviceId: 'rog', providers: [source('openai')] }];
    expect(hidden(listedSourceFolds({ base, others, honorRunLocation: true }))).toEqual(['base:openai']);
    expect(hidden(listedSourceFolds({ base, others }))).toEqual(['rog:openai']);
    // The task still on this computer keeps its entry next to the chosen computer's.
    expect(hidden(listedSourceFolds({ base, others, honorRunLocation: true, current: { deviceId: null, providerId: 'openai' } }))).toEqual([]);
  });
  it('never folds exempt base sources such as provider groups or own shares', () => {
    const others = [{ deviceId: 'rog', providers: [source('openai')] }];
    expect(hidden(listedSourceFolds({ base: [source('openai')], others, baseExempt: id => id === 'openai' }))).toEqual([]);
  });
});
