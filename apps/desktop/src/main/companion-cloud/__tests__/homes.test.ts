import { describe, expect, it, vi } from 'vitest';
import { companionSnapshot, createCompanionHomeRegistry, registerCompanionHomes } from '../homes.js';
import { fakeApi, rejection } from './fakes.js';

const bot = (id: string, externalId: string, homeDeviceId: string | null) =>
  ({ id, kind: 'bot', externalId, name: externalId, homeDeviceId });

describe('companion home registry', () => {
  it('treats disabled, unhomed and own companions as home here', () => {
    const homes = createCompanionHomeRegistry();
    expect(homes.isHomeHere('a')).toBe(true);
    const listener = vi.fn();
    homes.onChange(listener);
    homes.update(companionSnapshot({ enabled: true, selfDeviceId: 'me', humanActorId: 'human', actors: [
      bot('actor-a', 'a', 'me'), bot('actor-b', 'b', 'other'), bot('actor-c', 'c', null),
    ] }));
    expect(listener).toHaveBeenCalledOnce();
    expect([homes.isHomeHere('a'), homes.isHomeHere('b'), homes.isHomeHere('c'), homes.isHomeHere('unknown')])
      .toEqual([true, false, true, true]);
    expect(homes.homeOf('b')).toBe('other');
    expect(homes.homeOf('unknown')).toBeUndefined();
    expect(homes.actorIdFor('c')).toBe('actor-c');
    // Same content does not notify again; disabling makes everything local again.
    homes.update(homes.snapshot());
    expect(listener).toHaveBeenCalledOnce();
    homes.reset();
    expect(homes.isEnabled()).toBe(false);
    expect(homes.isHomeHere('b')).toBe(true);
  });
});

describe('registerCompanionHomes', () => {
  it('claims only empty homes with compare-and-set against null', async () => {
    const { api, calls } = fakeApi(() => ({ homeDeviceId: 'me' }));
    const actors = [bot('actor-a', 'a', null), bot('actor-b', 'b', 'other'), bot('actor-c', 'c', null)];
    await registerCompanionHomes({ api, selfDeviceId: 'me', actors, botIds: ['a', 'b', 'c', 'missing'], isDemoted: id => id === 'c' });
    expect(calls).toEqual([{ route: '/actors/actor-a', method: 'PATCH', data: { homeDeviceId: 'me', expectedHomeDeviceId: null }, actorId: undefined }]);
    expect(actors.map(a => a.homeDeviceId)).toEqual(['me', 'other', null]);
  });

  it('adopts the winner of a concurrent registration', async () => {
    const { api } = fakeApi(() => { throw rejection(409, 'HOME_DEVICE_CONFLICT', { homeDeviceId: 'laptop' }); });
    const actors = [bot('actor-a', 'a', null)];
    await registerCompanionHomes({ api, selfDeviceId: 'me', actors, botIds: ['a'], isDemoted: () => false });
    expect(actors[0]!.homeDeviceId).toBe('laptop');
  });

  it('keeps the home empty and logs when the request fails for another reason', async () => {
    const { api } = fakeApi(() => { throw rejection(500, 'UPSTREAM_FAILED'); });
    const log = { warn: vi.fn() };
    const actors = [bot('actor-a', 'a', null)];
    await registerCompanionHomes({ api, selfDeviceId: 'me', actors, botIds: ['a'], isDemoted: () => false, log });
    expect(actors[0]!.homeDeviceId).toBeNull();
    expect(log.warn).toHaveBeenCalledWith('Companion home registration will retry', { actorId: 'actor-a', code: 'UPSTREAM_FAILED' });
  });
});

describe('retired actors', () => {
  it('drops disabled actors from the snapshot and never registers them', async () => {
    const snapshot = companionSnapshot({ enabled: true, selfDeviceId: 'me', humanActorId: 'human', actors: [
      { ...bot('actor-a', 'a', null), disabled: true }, bot('actor-b', 'b', 'me')] });
    expect(snapshot.actors.map(actor => actor.externalId)).toEqual(['b']);
    const { api, calls } = fakeApi(() => ({}));
    await registerCompanionHomes({ api, selfDeviceId: 'me', actors: [{ ...bot('actor-a', 'a', null), disabled: true }], botIds: ['a'], isDemoted: () => false });
    expect(calls).toEqual([]);
  });
});

describe('owner scoping', () => {
  it('drops the previous owner\'s homes and loads the new owner\'s persisted shadows on first read', () => {
    const homes = createCompanionHomeRegistry();
    let owner = 'a';
    const persisted: Record<string, string[]> = { a: [], b: ['mia'] };
    homes.bindOwner(() => owner, () => persisted[owner]!);
    homes.update(companionSnapshot({ enabled: true, selfDeviceId: 'me', humanActorId: 'human', actors: [bot('actor-a', 'mia', 'me')] }));
    expect(homes.isShadowed('mia')).toBe(false);
    expect(homes.snapshot().actors).toHaveLength(1);
    owner = 'b';
    expect(homes.isShadowed('mia')).toBe(true);
    expect(homes.snapshot()).toMatchObject({ enabled: false, actors: [], demotedBotIds: ['mia'] });
  });
});

describe('persisted shadows', () => {
  it('keep a demoted copy shadowed while the server is unknown or the feature is off', () => {
    const homes = createCompanionHomeRegistry();
    const listener = vi.fn();
    homes.onChange(listener);
    homes.setPersistedShadows(['mia']);
    expect(homes.isShadowed('mia')).toBe(true);
    expect(homes.snapshot()).toMatchObject({ enabled: false, demotedBotIds: ['mia'] });
    expect(listener).toHaveBeenCalledOnce();
    homes.update(companionSnapshot({ enabled: false, selfDeviceId: null, humanActorId: null, actors: [] }));
    expect(homes.isShadowed('mia')).toBe(true);
    homes.reset();
    expect(homes.isShadowed('mia')).toBe(false);
  });
});
