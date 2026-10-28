// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MobileUser } from '@/auth/AuthContext';
const h = vi.hoisted(() => ({
  disk: new Map<string, string>(), push: vi.fn(), replace: vi.fn(), dismissTo: vi.fn(), dismiss: vi.fn(), reset: vi.fn(), accountGeneration: 1,
  user: { id: 'account', passportId: 'passport', membershipKind: 'personal', orgId: null } as MobileUser,
  sessions: [] as import('@/session/types').RemoteSession[], upsert: vi.fn(), get: vi.fn(), set: vi.fn(), routes: [] as Array<{ name: string; params?: unknown }>,
}));
vi.mock('expo-router', () => ({ useRouter: () => ({ dismissTo: h.dismissTo, dismiss: h.dismiss, replace: h.replace }), useNavigation: () => ({ reset: h.reset, getState: () => ({ routes: h.routes, index: h.routes.length - 1 }) }) }));
vi.mock('react-native', () => ({ Keyboard: { dismiss() {} } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'en' } }) }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ user: h.user, accountGeneration: h.accountGeneration }) }));
vi.mock('@/utils/useGuardedPush', () => ({ useGuardedPush: () => h.push }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: h.get, setItem: h.set } }));
vi.mock('@/session/remoteSessionStore', () => ({ remoteSessionStore: { getSessions: () => h.sessions, getSessionDeviceId: () => undefined, upsertDeviceSession: h.upsert } }));
import { useTeammateNavigation } from '@/session/useTeammateNavigation';
import { homeNavigationOwner } from '@/session/useHomeMode';
import { readHomeNavigationPreferences, saveHomeNavigationPreferences } from '@/session/homeViewPreferenceStore';
import { teammateIdentity } from '@/session/teammateNavigation';
import { StackRouter, StackActions } from 'expo-router/build/react-navigation/routers/StackRouter';
const teammate = { key: 'mac:writer', host: { deviceId: 'mac', deviceName: 'My Mac' }, item: {
  ref: { collectionId: 'teammates', kind: 'bot', id: 'writer' }, revision: '1', display: { title: 'Writer' }, links: [],
} };
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
let result: ReturnType<typeof useTeammateNavigation>;
function Probe({ push }: { push?: ReturnType<typeof import('@/utils/useGuardedPush').useGuardedPush> }) { result = useTeammateNavigation(push); return null; }
async function render(push?: ReturnType<typeof import('@/utils/useGuardedPush').useGuardedPush>) { root ??= createRoot(document.createElement('div')); await act(async () => root!.render(createElement(Probe, { push }))); }
let serial = 0;
beforeEach(() => {
  vi.clearAllMocks(); h.sessions = []; h.routes = []; h.disk.clear(); h.accountGeneration = ++serial;
  h.user = { id: `account-${serial}`, passportId: 'passport', membershipKind: 'personal', orgId: null } as MobileUser;
  h.get.mockImplementation(async (key: string) => h.disk.get(key) ?? null);
  h.set.mockImplementation(async (key: string, value: string) => { h.disk.set(key, value); });
});
afterEach(() => { act(() => root?.unmount()); root = undefined; vi.useRealTimers(); });
describe('header/home shared navigation', () => {
  // PR #7079: the drawer must unmount before routing. Existing tests only covered immediate home
  // pushes; one teammate or creation receipt with a deferred host push reproduces the regression.
  // Unit tier, real navigation hook; the queued route must survive the source hook's unmount.
  it.each(['existing', 'created'] as const)('waits for the drawer to close before opening an %s teammate', async (kind) => {
    let routeAfterClose: (() => void) | undefined;
    await render(href => { routeAfterClose = () => h.push(href); });
    await act(async () => kind === 'existing' ? result.openTeammate(teammate) : result.openCreatedTeammate(teammate.host, teammate.item.ref));
    expect(h.push).not.toHaveBeenCalled();
    expect(result.lastTeammate).toEqual(teammateIdentity(teammate));
    await act(async () => root!.unmount()); root = undefined;
    routeAfterClose?.();
    expect(h.push).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ pathname: '/resources/[collectionId]/[resourceId]' }));
  });
  it('restores the remembered teammate and section fold, and returning home keeps them', async () => {
    const owner = homeNavigationOwner(h.user);
    await saveHomeNavigationPreferences(owner, { teammatesCollapsed: true, lastTeammate: teammateIdentity(teammate) });
    await render(); expect(result.teammatesCollapsed).toBe(true); expect(result.lastTeammate?.resourceId).toBe('writer');
    await act(async () => result.returnHome());
    expect(h.dismissTo).toHaveBeenCalledWith('/devices');
    expect(await readHomeNavigationPreferences(owner)).toEqual({ teammatesCollapsed: true, lastTeammate: teammateIdentity(teammate) });
  });
  it('only pushes a resource resolver and records identity; never replaces or resets the current composer', async () => {
    await render(); await act(async () => result.openTeammate(teammate));
    expect(h.push).toHaveBeenCalledExactlyOnceWith({ pathname: '/resources/[collectionId]/[resourceId]', params: {
      collectionId: 'teammates', resourceId: 'writer', resourceKind: 'bot', deviceId: 'mac', deviceName: 'My Mac', title: 'Writer',
    } });
    expect(result.lastTeammate).toEqual(teammateIdentity(teammate));
    expect(await readHomeNavigationPreferences(result.owner)).toEqual({ lastTeammate: teammateIdentity(teammate) });
    expect(h.set).toHaveBeenCalledTimes(1);
  });
  // Tier: behavior. After "continue on another computer" the cloud view replaced itself with the new chat, but the old
  // computer's chat it was opened from stayed underneath, so back showed it ("Computer not connected") before the list.
  it('handing over from the cloud view also drops the old computer\'s chat, so back goes to the list', async () => {
    const moved = { ...teammate, key: 'win:writer', host: { deviceId: 'win', deviceName: 'Studio' } };
    const old = { name: 'resources/[collectionId]/[resourceId]', key: 'old', params: { resourceId: 'writer', deviceId: 'mac' } };
    const list = { name: 'devices/index', key: 'list' }; const cloud = { name: 'companions/cloud/[actorId]', key: 'cloud' };
    h.routes = [list, old, cloud];
    await render(); await act(async () => result.openTeammate(moved, { replace: true, leaving: { botId: 'writer', deviceId: 'mac' } }));
    expect(h.reset).toHaveBeenCalledExactlyOnceWith({ index: 1, routes: [list, { name: 'resources/[collectionId]/[resourceId]', params: {
      collectionId: 'teammates', resourceId: 'writer', resourceKind: 'bot', deviceId: 'win', deviceName: 'Studio', title: 'Writer',
    } }] });
    expect(h.replace).not.toHaveBeenCalled();
    // Opened straight from the list: only the cloud view is replaced.
    h.reset.mockClear(); h.routes = [list, cloud];
    await act(async () => result.openTeammate(moved, { replace: true, leaving: { botId: 'writer', deviceId: 'mac' } }));
    expect(h.reset).not.toHaveBeenCalled(); expect(h.replace).toHaveBeenCalledTimes(1);
  });
  it('keeps the section fold when a teammate is opened from it', async () => {
    await render(); await act(async () => result.setTeammatesCollapsed(true));
    await act(async () => result.openTeammate(teammate));
    expect(h.push).toHaveBeenCalledTimes(1);
    expect(await readHomeNavigationPreferences(result.owner)).toEqual({ teammatesCollapsed: true, lastTeammate: teammateIdentity(teammate) });
  });
  it('opens a creation receipt through the canonical resolver with one atomic preference update', async () => {
    await render(); await act(async () => result.openCreatedTeammate(teammate.host, teammate.item.ref));
    expect(h.push).toHaveBeenCalledExactlyOnceWith({ pathname: '/resources/[collectionId]/[resourceId]', params: {
      collectionId: 'teammates', resourceId: 'writer', resourceKind: 'bot', deviceId: 'mac', deviceName: 'My Mac',
    } });
    expect(result.lastTeammate).toEqual(teammateIdentity(teammate));
    expect(h.set).toHaveBeenCalledTimes(1);
  });
  it('ignores a stale creation callback after switching accounts', async () => {
    await render(); const oldCreate = result.openCreatedTeammate;
    h.accountGeneration++; h.user = { ...h.user, id: 'new-create-owner' }; await render();
    await act(async () => oldCreate(teammate.host, teammate.item.ref));
    expect(h.set).not.toHaveBeenCalled(); expect(h.push).not.toHaveBeenCalled();
  });
  it('rejects invalid creation receipts without writing preferences or navigating', async () => {
    await render(); await act(async () => result.openCreatedTeammate(teammate.host, { ...teammate.item.ref, kind: 'session' }));
    expect(h.set).not.toHaveBeenCalled(); expect(h.push).not.toHaveBeenCalled();
  });
  it('does not block navigation on disk writes or carry a last teammate into a different membership', async () => {
    await render(); const previousOwner = result.owner;
    let finish!: () => void;
    h.set.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    let selection!: Promise<void>;
    await act(async () => { selection = result.openTeammate(teammate); });
    expect(h.push).toHaveBeenCalledTimes(1);
    h.accountGeneration += 1; h.user = { ...h.user, membershipKind: 'org', orgId: 'different-org' };
    await render();
    expect(result.owner).not.toBe(previousOwner); expect(result.lastTeammate).toBeNull();
    await act(async () => { finish(); await selection; });
    expect(h.push).toHaveBeenCalledTimes(1);
    expect(result.lastTeammate).toBeNull();
  });
  it('fences an old selection still waiting for hydration when the account changes', async () => {
    let finish!: (raw: string | null) => void;
    h.get.mockImplementationOnce(() => new Promise<string | null>((resolve) => { finish = resolve; }));
    await render();
    let selection!: Promise<void>;
    await act(async () => { selection = result.openTeammate(teammate); });
    h.accountGeneration += 1; h.user = { ...h.user, id: 'new-owner-during-read' };
    await render();
    await act(async () => { finish(null); await selection; });
    expect(h.push).not.toHaveBeenCalled(); expect(result.lastTeammate).toBeNull();
  });
  it('hydrates a prior identity before applying a fold chosen during the read', async () => {
    let finish!: (raw: string) => void;
    h.get.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; }));
    await render();
    let change!: Promise<void>;
    await act(async () => { change = result.setTeammatesCollapsed(true); });
    expect(result.hydrated).toBe(false);
    await act(async () => { finish(JSON.stringify({ teammatesCollapsed: false, lastTeammate: teammateIdentity(teammate) })); await change; });
    expect(result.teammatesCollapsed).toBe(true); expect(result.lastTeammate).toEqual(teammateIdentity(teammate));
  });
  it('does not let a hung preference read blank home forever, then fills in the late values', async () => {
    vi.useFakeTimers();
    let finish!: (raw: string) => void;
    h.get.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; }));
    await render(); expect(result.hydrated).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(result.hydrated).toBe(true); expect(result.teammatesCollapsed).toBe(false);
    await act(async () => finish(JSON.stringify({ teammatesCollapsed: true, lastTeammate: teammateIdentity(teammate) })));
    expect(result.teammatesCollapsed).toBe(true); expect(result.lastTeammate).toEqual(teammateIdentity(teammate));
    expect(h.set).not.toHaveBeenCalled(); expect(h.push).not.toHaveBeenCalled();
  });
  it('fences rapid selections before asynchronous storage so the remembered identity matches the opened route', async () => {
    await render();
    const second = { ...teammate, item: { ...teammate.item, ref: { ...teammate.item.ref, id: 'different' } } };
    await act(async () => Promise.all([result.openTeammate(teammate), result.openTeammate(second)]));
    expect(h.push).toHaveBeenCalledTimes(1); expect(result.lastTeammate?.resourceId).toBe('writer');
  });
  it('keeps the chosen fold for this run when it cannot be saved', async () => {
    await render(); h.set.mockRejectedValueOnce(new Error('storage full'));
    await act(async () => result.setTeammatesCollapsed(true));
    expect(result.teammatesCollapsed).toBe(true); expect(h.push).not.toHaveBeenCalled();
  });
});

it.each([
  { routes: [{ name: 'index' }, { name: 'sessions/[sessionId]' }], href: '/' },
  { routes: [{ name: 'devices/index' }, { name: 'sessions/[sessionId]' }], href: '/devices' },
])('returns to the mounted list at $href instead of replacing the chat with a new home', async ({ routes, href }) => {
  h.routes = routes;
  await render();
  await act(async () => result.returnHome());
  expect(h.dismiss).toHaveBeenCalledExactlyOnceWith(1);
  expect(h.dismissTo).not.toHaveBeenCalled();
  expect(h.reset).not.toHaveBeenCalled();
});
it('removes the retired teammate list from the stack before returning home', async () => {
  const router = StackRouter({ initialRouteName: 'resources/[collectionId]' });
  const options = { routeNames: ['resources/[collectionId]', 'sessions/[sessionId]', 'devices/index'],
    routeParamList: { 'resources/[collectionId]': { collectionId: 'teammates' } }, routeGetIdList: {}, routeKeyChanges: [] };
  let state = router.getInitialState(options);
  state = router.getStateForAction(state, StackActions.push('sessions/[sessionId]'), options)! as typeof state;
  h.routes = state.routes;
  h.reset.mockImplementationOnce(next => { state = router.getRehydratedState({ ...next, stale: true }, options) as typeof state; });
  await render();
  await act(async () => result.returnHome());
  expect(h.dismiss).not.toHaveBeenCalled();
  expect(h.dismissTo).not.toHaveBeenCalled();
  expect(state.routes.map(route => route.name)).toEqual(['devices/index']);
  expect(router.getStateForAction(state, StackActions.pop(), options)).toBeNull();
});
it('preserves earlier unrelated routes when removing multiple retired entries', async () => {
  const prior = { name: 'resources/[collectionId]', params: { collectionId: 'tools', targets: 'hosts' } };
  h.routes = [prior,
    { name: 'resources/[collectionId]', params: { collectionId: 'teammates' } },
    { name: 'sessions/[sessionId]' },
    { name: 'resources/[collectionId]', params: { collectionId: 'teammates' } },
    { name: 'sessions/[sessionId]' },
  ];
  await render();
  await act(async () => result.returnHome());
  expect(h.reset).toHaveBeenCalledExactlyOnceWith({ index: 1, routes: [prior, { name: 'devices/index' }] });
  expect(h.dismissTo).not.toHaveBeenCalled();
});
it('opens a known conversation directly and seeds its first-frame identity', async () => {
  const { readRemoteCollectionCache } = await import('@/device-link/remoteResourceAvailability');
  const linked = { ...teammate, item: { ...teammate.item, links: [{ rel: 'conversation', target: { kind: 'session' as const, sessionId: 'chat' } }] } };
  await render();
  await act(async () => result.openTeammate(linked));
  expect(h.push).toHaveBeenCalledExactlyOnceWith({ pathname: '/sessions/[sessionId]', params: {
    sessionId: 'chat', deviceId: 'mac', deviceName: 'My Mac', resourceCollectionId: 'teammates', resourceId: 'writer', resourceKind: 'bot',
  } });
  expect(readRemoteCollectionCache(`${h.user.id}:${h.accountGeneration}`, 'teammates')[0]).toBe(linked);
});

it('opens a disk-cached canonical chat without a task row, seeds presentation once, and preserves real metadata', async () => {
  const linked = { ...teammate, item: { ...teammate.item, links: [{ rel: 'conversation', target: { kind: 'session' as const, sessionId: 'canonical' } }] } };
  h.upsert.mockImplementation((_device, _name, session) => { h.sessions.push(session); });
  await render();
  await act(async () => Promise.all([result.openTeammate(linked), result.openTeammate(linked)]));
  expect(h.push).toHaveBeenCalledTimes(1);
  expect(h.upsert).toHaveBeenCalledExactlyOnceWith('mac', 'My Mac', expect.objectContaining({ id: 'canonical', source: 'bot', cacheSeeded: true, workingDir: null }));
  expect(h.push.mock.calls[0][0].pathname).toBe('/sessions/[sessionId]');
  h.sessions[0] = { ...h.sessions[0], cacheSeeded: undefined, model: 'real-model', workingDir: '/real' };
  await act(async () => result.openTeammate(linked));
  expect(h.upsert).toHaveBeenCalledTimes(1);
  expect(h.sessions[0].model).toBe('real-model');
});
