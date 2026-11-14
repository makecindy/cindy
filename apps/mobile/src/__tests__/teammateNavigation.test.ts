import { stackState, reduceStack } from './navigationFixture';
import { existingDrawerConversationState } from '@/session/taskListNavigationPolicy';
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
import { homeDismissCount, orderedTeammates, teammateIdentity, teammateResourceRoute } from '@/session/teammateNavigation';
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
  // Unit: old collapsed records do not acquire an explicit avatar override; explicit false survives account switches.
  // No prior test covered an independently persisted avatar setting.
  it('keeps explicit avatar choices per account without inferring them from an old collapsed state', async () => {
    await saveHomeNavigationPreferences('account-a', { teammatesCollapsed: true });
    expect((await readHomeNavigationPreferences('account-a')).showCollapsedTeammateAvatars).toBeUndefined();
    await Promise.all([
      saveHomeNavigationPreferences('account-a', { showCollapsedTeammateAvatars: true }),
      saveHomeNavigationPreferences('account-b', { showCollapsedTeammateAvatars: false }),
    ]);
    expect(await readHomeNavigationPreferences('account-a')).toEqual({ teammatesCollapsed: true, showCollapsedTeammateAvatars: true });
    expect(await readHomeNavigationPreferences('account-b')).toEqual({ showCollapsedTeammateAvatars: false });
    expect(await readHomeNavigationPreferences('account-c')).toEqual({});
  });
  it('serializes overlapping patches and isolates accounts even when resource ids match', async () => {
    await Promise.all([
      saveHomeNavigationPreferences('account-a', { lastTeammate: teammateIdentity(row()) }),
      saveHomeNavigationPreferences('account-a', { teammatesCollapsed: true }),
      saveHomeNavigationPreferences('account-b', { teammatesCollapsed: false }),
    ]);
    expect(await readHomeNavigationPreferences('account-a')).toEqual({ teammatesCollapsed: true, lastTeammate: teammateIdentity(row()) });
    expect(await readHomeNavigationPreferences('account-b')).toEqual({ teammatesCollapsed: false });
    await saveHomeNavigationPreferences('account-a', { lastTeammate: null });
    expect(await readHomeNavigationPreferences('account-a')).toEqual({ teammatesCollapsed: true });
  });
  it('does not overwrite preferences after a failed read; a failed write does not poison later saves', async () => {
    await saveHomeNavigationPreferences('account-a', { teammatesCollapsed: true });
    vi.mocked(AsyncStorage.getItem).mockRejectedValueOnce(new Error('disk unavailable'));
    await expect(saveHomeNavigationPreferences('account-a', { lastTeammate: teammateIdentity(row()) })).rejects.toThrow('disk unavailable');
    expect(await readHomeNavigationPreferences('account-a')).toEqual({ teammatesCollapsed: true });
    vi.mocked(AsyncStorage.setItem).mockRejectedValueOnce(new Error('write failed'));
    await expect(saveHomeNavigationPreferences('account-b', { teammatesCollapsed: true })).rejects.toThrow('write failed');
    await saveHomeNavigationPreferences('account-a', { lastTeammate: teammateIdentity(row()) });
    expect((await readHomeNavigationPreferences('account-a')).lastTeammate).toEqual(teammateIdentity(row()));
  });
  it('rejects malformed identities and never saves extra Session/profile fields', () => {
    expect(normalizeHomeNavigationPreferences({ teammatesCollapsed: 'yes', lastTeammate: { resourceId: 'id' } })).toEqual({});
    expect(normalizeHomeNavigationPreferences({ lastTeammate: { ...teammateIdentity(row()), sessionId: 'cached', name: 'Cindy' } }))
      .toEqual({ lastTeammate: teammateIdentity(row()) });
  });
  it('drops the retired tasks/teammates mode from stored data on the next write, keeping the rest', async () => {
    disk.set(__testing.navigationPrefix + 'account-a', JSON.stringify({ mode: 'teammates', lastTeammate: teammateIdentity(row()) }));
    expect(await readHomeNavigationPreferences('account-a')).toEqual({ lastTeammate: teammateIdentity(row()) });
    await saveHomeNavigationPreferences('account-a', { teammatesCollapsed: true });
    expect(JSON.parse(disk.get(__testing.navigationPrefix + 'account-a')!)).toEqual({ teammatesCollapsed: true, lastTeammate: teammateIdentity(row()) });
  });
});
describe('teammate identity navigation', () => {
  it.each(['index', 'devices/index'])('preserves the actual %s stack entry across repeated teammate opens', (name) => {
    const router = StackRouter({ initialRouteName: name });
    const options = { routeNames: [name, 'sessions/[sessionId]'], routeParamList: { [name]: { collectionId: 'teammates', targets: 'fixture-hosts', title: "Buddies" } }, routeGetIdList: {}, routeKeyChanges: [] };
    let state = stackState(options, name);
    const home = state.routes[0];
    for (let turn = 0; turn < 3; turn++) {
      for (const sessionId of ['a', 'b']) state = reduceStack(router, state, StackActions.push('sessions/[sessionId]', { sessionId }), options);
      const count = homeDismissCount(state.routes);
      expect(count).toBe(2);
      state = reduceStack(router, state, StackActions.pop(count!), options);
      expect(state.routes).toEqual([home]);
      expect(state.routes[0]).toBe(home); // Same key and params: React retains the mounted list.
    }
  });
  it('replaces a legacy teammate collection entry instead of preserving the retired route', () => {
    const routes = [
      { name: 'resources/[collectionId]', params: { collectionId: 'teammates' } },
      { name: 'sessions/[sessionId]' },
    ];
    expect(homeDismissCount(routes)).toBeNull();
  });
  it('uses the conversation as a navigation hint and retains the resource identity for revalidation', () => {
    expect(teammateResourceRoute(row(), 'en')).toEqual({ pathname: '/sessions/[sessionId]', params: {
      resourceCollectionId: 'teammates', resourceId: 'writer', resourceKind: 'bot', deviceId: 'mac', deviceName: 'mac', sessionId: 'obsolete-session',
    } });
  });
  it('keeps equal names from separate hosts, filters names, and sorts by real activity', () => {
    const first = row('mac', 'writer', 'Writer', 100);
    const second = row('pc', 'writer', 'Writer', 200);
    expect(orderedTeammates([first, second, row('pc', 'other', 'Reader', 300), first], 'ｗｒｉｔｅｒ', 'en')).toEqual([second, first]);
  });
});

// Unit regression: task → group → task → same group used a fresh native route,
// rebuilding the timeline despite a warm data cache. Existing tests only covered private chats.
it('returns to the same live group without moving its native screen or conflating authorities', () => {
  const name = 'companions/groups/[groupId]';
  const router = StackRouter({ initialRouteName: 'index' });
  const options = { routeNames: ['index', 'sessions/[sessionId]', name], routeParamList: {}, routeGetIdList: {}, routeKeyChanges: [] };
  let state = stackState(options);
  const push = (route: string, params: object) => {
    state = reduceStack(router, state, StackActions.push(route, params), options);
    return state.routes.at(-1)!;
  };
  const first = push(name, { groupId: 'group', deviceId: 'mac', messageId: 'old-target' });
  const firstIndex = state.index;
  push('sessions/[sessionId]', { sessionId: 'task', deviceId: 'mac' });
  const destination = (params: { groupId: string; deviceId?: string; threadRootId?: string }) => ({ pathname: '/companions/groups/[groupId]' as const, params });
  const next = existingDrawerConversationState(state, destination({ groupId: 'group', deviceId: 'mac' }))!;
  const returned = reduceStack(router, state, { type: 'RESET', payload: next }, options);
  expect(returned.routes.at(-1)?.key).toBe(first.key);
  expect(returned.index).toBe(firstIndex);
  expect(returned.routes.at(-1)?.params).not.toHaveProperty('messageId');
  expect(returned.routes[0].key).toBe(state.routes[0].key);
  // Reuse the native shell; the route's account/device/group keyed child is new.
  for (const params of [{ groupId: 'group', deviceId: 'other-mac' }, { groupId: 'different-group' }]) {
    const changed = existingDrawerConversationState(state, destination(params))!;
    expect(changed.routes.at(-1)?.key).toBe(first.key);
    expect(changed.routes.at(-1)?.params).toEqual(params);
  }
  expect(existingDrawerConversationState(state, destination({ groupId: 'group', deviceId: 'mac', threadRootId: 'topic' }))).toBeNull();
});

it('opens a fresh task shell above a group without moving either retained screen', () => {
  const router = StackRouter({ initialRouteName: 'index' });
  const options = { routeNames: ['index', 'sessions/[sessionId]', 'companions/groups/[groupId]'], routeParamList: {}, routeGetIdList: {}, routeKeyChanges: [] };
  const initial = stackState(options);
  const task = reduceStack(router, initial, StackActions.push('sessions/[sessionId]', { sessionId: 'task', deviceId: 'mac' }), options);
  const group = reduceStack(router, task, StackActions.push('companions/groups/[groupId]', { groupId: 'group', deviceId: 'mac' }), options);
  const next = existingDrawerConversationState(group, { pathname: '/sessions/[sessionId]', params: { sessionId: 'task', deviceId: 'mac', focusClientId: 'message' } })!;
  const returned = reduceStack(router, group, { type: 'RESET', payload: next }, options);
  expect(returned.routes.at(-1)?.key).not.toBe(task.routes.at(-1)?.key);
  expect(returned.routes.slice(0, -1)).toEqual(group.routes);
  expect(returned.routes.at(-1)?.params).toMatchObject({ focusClientId: 'message' });
  const back = existingDrawerConversationState(returned, { pathname: '/companions/groups/[groupId]', params: { groupId: 'group', deviceId: 'mac' } })!;
  expect(back.routes.at(-1)?.key).toBe(group.routes.at(-1)?.key);
  expect(back.routes).toHaveLength(group.routes.length);
  let current = back;
  for (let turn = 0; turn < 20; turn++) {
    const taskState = existingDrawerConversationState(current, { pathname: '/sessions/[sessionId]', params: { sessionId: 'task', deviceId: 'mac' } })!;
    expect(taskState.routes).toHaveLength(group.routes.length + 1);
    expect(taskState.routes.slice(0, -1)).toEqual(group.routes);
    current = existingDrawerConversationState(taskState, { pathname: '/companions/groups/[groupId]', params: { groupId: 'group', deviceId: 'mac' } })!;
    expect(current.routes).toEqual(group.routes);
  }
});

it('bounds peer shells while selecting different partners and groups repeatedly', () => {
  const router = StackRouter({ initialRouteName: 'index' });
  const groupName = 'companions/groups/[groupId]';
  const options = { routeNames: ['index', 'sessions/[sessionId]', groupName, 'companions/cloud/[actorId]'], routeParamList: {}, routeGetIdList: {}, routeKeyChanges: [] };
  let state = stackState(options);
  const home = state.routes[0];
  const select = (href: Parameters<typeof existingDrawerConversationState>[1]) => {
    const next = existingDrawerConversationState(state, href);
    const target = href as { pathname: string; params: object };
    state = reduceStack(router, state, next
      ? { type: 'RESET', payload: next }
      : StackActions.push(target.pathname.slice(1), target.params), options);
  };
  select({ pathname: '/sessions/[sessionId]', params: { deviceId: 'mac', sessionId: 'first' } });
  select({ pathname: '/companions/groups/[groupId]', params: { groupId: 'first' } });
  const groupKey = state.routes.at(-1)!.key;
  for (let i = 0; i < 30; i++) {
    select({ pathname: '/sessions/[sessionId]', params: { deviceId: 'mac', sessionId: `partner-${i}` } });
    expect(state.routes.length).toBeLessThanOrEqual(4);
    select({ pathname: '/companions/groups/[groupId]', params: { groupId: `group-${i}`, deviceId: i % 2 ? 'mac' : '' } });
    expect(state.routes).toHaveLength(3);
    expect(state.routes.at(-1)!.key).toBe(groupKey);
    expect(state.routes.at(-1)!.params).toEqual({ groupId: `group-${i}`, deviceId: i % 2 ? 'mac' : '' });
    expect(state.routes[0]).toBe(home);
  }
  select({ pathname: '/companions/cloud/[actorId]', params: { actorId: 'first', botId: 'old', deviceId: 'mac' } });
  const cloudKey = state.routes.at(-1)!.key;
  select({ pathname: '/companions/cloud/[actorId]', params: { actorId: 'second' } });
  expect(state.routes.at(-1)!).toMatchObject({ key: cloudKey, params: { actorId: 'second' } });
  expect(state.routes.at(-1)!.params).not.toHaveProperty('botId');
});

// Unit: one shared classifier must exclude nested threads from sidebar shell
// reuse even when the exact thread already exists (previous coverage: new thread).
it('does not reuse an existing nested thread as a top-level sidebar conversation', () => {
  const name = 'companions/groups/[groupId]';
  const params = { groupId: 'group', deviceId: 'mac', threadRootId: 'topic' };
  const state = stackState({ routeNames: [name], routeParamList: { [name]: params }, routeGetIdList: {} }, name);
  expect(existingDrawerConversationState(state, { pathname: '/companions/groups/[groupId]', params })).toBeNull();
});
