import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostedRemoteCollectionItem } from '@/device-link/remoteResources';
const disk = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
  getItem: vi.fn(async (key: string) => disk.get(key) ?? null),
  setItem: vi.fn(async (key: string, value: string) => { disk.set(key, value); }),
  removeItem: vi.fn(async (key: string) => { disk.delete(key); }),
} }));
import AsyncStorage from '@react-native-async-storage/async-storage';
import { __testing, normalizeHomeNavigationPreferences, readHomeNavigationPreferences, saveHomeNavigationPreferences } from '@/session/homeViewPreferenceStore';
import { findLastTeammate, homeDismissCount, orderedTeammates, teammateIdentity, teammateResourceRoute } from '@/session/teammateNavigation';
import { StackRouter, StackActions } from 'expo-router/build/react-navigation/routers/StackRouter';
const row = (deviceId = 'mac', id = 'writer', title = 'Writer', timestamp = 100): HostedRemoteCollectionItem => ({
  key: `${deviceId}:${id}`, host: { deviceId, deviceName: deviceId },
  item: { ref: { collectionId: 'teammates', kind: 'bot', id }, revision: '1',
    display: { title, preview: 'Real reply', timestamp },
    links: [{ rel: 'conversation', target: { kind: 'session', sessionId: 'obsolete-session' } }] },
});
beforeEach(() => { disk.clear(); vi.clearAllMocks(); });

describe('account-scoped home navigation overrides', () => {
  it('does not migrate an unscoped identity or write defaults on read', async () => {
    disk.set(__testing.storageKey, JSON.stringify({ mode: 'teammates', lastTeammate: teammateIdentity(row()) }));
    expect(await readHomeNavigationPreferences('account-a')).toEqual({});
    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
  });
  it('serializes overlapping patches and isolates accounts even when resource ids match', async () => {
    await Promise.all([
      saveHomeNavigationPreferences('account-a', { lastTeammate: teammateIdentity(row()) }),
      saveHomeNavigationPreferences('account-a', { mode: 'teammates' }),
      saveHomeNavigationPreferences('account-b', { mode: 'tasks' }),
    ]);
    expect(await readHomeNavigationPreferences('account-a')).toEqual({ mode: 'teammates', lastTeammate: teammateIdentity(row()) });
    expect(await readHomeNavigationPreferences('account-b')).toEqual({ mode: 'tasks' });
    await saveHomeNavigationPreferences('account-a', { lastTeammate: null });
    expect(await readHomeNavigationPreferences('account-a')).toEqual({ mode: 'teammates' });
  });
  it('does not overwrite preferences after a failed read; a failed write does not poison later saves', async () => {
    await saveHomeNavigationPreferences('account-a', { mode: 'teammates' });
    vi.mocked(AsyncStorage.getItem).mockRejectedValueOnce(new Error('disk unavailable'));
    await expect(saveHomeNavigationPreferences('account-a', { lastTeammate: teammateIdentity(row()) })).rejects.toThrow('disk unavailable');
    expect(await readHomeNavigationPreferences('account-a')).toEqual({ mode: 'teammates' });
    vi.mocked(AsyncStorage.setItem).mockRejectedValueOnce(new Error('write failed'));
    await expect(saveHomeNavigationPreferences('account-b', { mode: 'tasks' })).rejects.toThrow('write failed');
    await saveHomeNavigationPreferences('account-a', { lastTeammate: teammateIdentity(row()) });
    expect((await readHomeNavigationPreferences('account-a')).lastTeammate).toEqual(teammateIdentity(row()));
  });
  it('rejects malformed identities and never saves extra Session/profile fields', () => {
    expect(normalizeHomeNavigationPreferences({ mode: 'unknown', lastTeammate: { resourceId: 'id' } })).toEqual({});
    expect(normalizeHomeNavigationPreferences({ mode: 'teammates', lastTeammate: { ...teammateIdentity(row()), sessionId: 'cached', name: 'Cindy' } }))
      .toEqual({ mode: 'teammates', lastTeammate: teammateIdentity(row()) });
  });
});
describe('teammate identity navigation', () => {
  it.each(['index', 'devices/index', 'resources/[collectionId]'])('preserves the actual %s stack entry and collection targets across repeated teammate opens', (name) => {
    const router = StackRouter({ initialRouteName: name });
    const options = { routeNames: [name, 'sessions/[sessionId]'], routeParamList: { [name]: { collectionId: 'teammates', targets: 'fixture-hosts', title: 'Teammates' } }, routeGetIdList: {}, routeKeyChanges: [] };
    let state = router.getInitialState(options);
    const home = state.routes[0];
    for (let turn = 0; turn < 3; turn++) {
      for (const sessionId of ['a', 'b']) state = router.getRehydratedState(router.getStateForAction(state, StackActions.push('sessions/[sessionId]', { sessionId }), options)!, options);
      const count = homeDismissCount(state.routes, 'teammates');
      expect(count).toBe(2);
      state = router.getRehydratedState(router.getStateForAction(state, StackActions.pop(count!), options)!, options);
      expect(state.routes).toEqual([home]);
      expect(state.routes[0]).toBe(home); // Same key and params: React retains the mounted list.
    }
  });
  it('uses the conversation as a navigation hint and retains the resource identity for revalidation', () => {
    expect(teammateResourceRoute(row(), 'en')).toEqual({ pathname: '/sessions/[sessionId]', params: {
      resourceCollectionId: 'teammates', resourceId: 'writer', resourceKind: 'bot', deviceId: 'mac', deviceName: 'mac', sessionId: 'obsolete-session',
    } });
  });
  it('never substitutes Cindy or another same-named host for a deleted or missing remembered teammate', () => {
    const last = teammateIdentity(row());
    expect(findLastTeammate(last, [row('other'), row('mac', 'cindy', 'Cindy')])).toBeNull();
    expect(findLastTeammate(null, [row('mac', 'cindy', 'Cindy')])).toBeNull();
    expect(findLastTeammate(last, [row()])).toEqual(row());
  });
  it('keeps equal names from separate hosts, filters names, and sorts by real activity', () => {
    const first = row('mac', 'writer', 'Writer', 100);
    const second = row('pc', 'writer', 'Writer', 200);
    expect(orderedTeammates([first, second, row('pc', 'other', 'Reader', 300), first], 'ｗｒｉｔｅｒ', 'en')).toEqual([second, first]);
  });
});
