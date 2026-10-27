// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostedRemoteCollectionItem, RemoteResourceHostTarget } from '@/device-link/remoteResources';
import { REMOTE_RESOURCE_STARTUP_TIMEOUT_MS } from '@/device-link/remoteResourceAvailability';
const h = vi.hoisted(() => ({
  auth: { user: { id: 'owner' }, accountGeneration: 1 }, focused: true,
  link: { connectionEpoch: 1, status: 'online', presenceVersion: 1, getPresenceAvailability: vi.fn((_deviceId: string) => true as boolean | null),
    invoke: vi.fn(), openLink: vi.fn(), onRemoteResourceChanged: vi.fn((_listener: (deviceId: string, payload: { collectionId: string }) => void) => () => {}), subscribe: vi.fn(), unsubscribe: vi.fn() },
  app: { currentState: 'active', listener: null as null | ((state: string) => void) },
  translation: { t: (key: string) => key, i18n: { language: 'en' } },
  list: vi.fn(), cached: [] as HostedRemoteCollectionItem[], persist: vi.fn(), snapshot: vi.fn(),
}));
vi.mock('react-native', () => ({ AppState: { get currentState() { return h.app.currentState; }, addEventListener: (_event: string, listener: (state: string) => void) => { h.app.listener = listener; return { remove() { h.app.listener = null; } }; } } }));
vi.mock('expo-router', async () => { const { useEffect } = await import('react'); return { useFocusEffect: (effect: () => void | (() => void)) => useEffect(() => h.focused ? effect() : undefined, [effect, h.focused]) }; });
vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));
vi.mock('react-i18next', () => ({ useTranslation: () => h.translation }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => h.auth }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => h.link }));
vi.mock('@/device-link/remoteStatus', async () => ({ ...await vi.importActual<typeof import('@/device-link/remoteStatus')>('@/device-link/remoteStatus'), formatRemoteError: (error: unknown) => String(error) }));
vi.mock('@/device-link/focusedTopicSubscription', () => ({ startFocusedTopicSubscription: () => () => {} }));
vi.mock('@/device-link/remoteResourceCache', () => ({
  readRemoteResourceSnapshot: h.snapshot, cacheRemoteResourceItems: h.persist,
  peekRemoteResourceSnapshot: () => undefined,
  subscribeRemoteResourceCache: () => () => {}, remoteResourceCacheRevision: () => 0,
}));
vi.mock('@/device-link/remoteResourceAvailability', async (original) => ({
  ...await original<typeof import('@/device-link/remoteResourceAvailability')>(), readRemoteCollectionCache: () => [], writeRemoteCollectionCache: () => {},
}));
vi.mock('@/device-link/remoteResources', async (original) => ({
  ...await original<typeof import('@/device-link/remoteResources')>(), listRemoteCollection: h.list,
}));
import { useRemoteResourceList } from '@/session/useRemoteResourceList';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const targets = [{ deviceId: 'mac', deviceName: 'Mac' }, { deviceId: 'pc', deviceName: 'PC' }];
const item = (id: string) => ({ ref: { collectionId: 'teammates', kind: 'bot', id }, display: { title: id, preview: 'Last real reply', lastReplyAt: 200 }, revision: '1', links: [] });
const cached = (host: RemoteResourceHostTarget, id: string): HostedRemoteCollectionItem => ({ key: `${host.deviceId}:${id}`, host, item: item(id) });
let root: Root | undefined;
let result: ReturnType<typeof useRemoteResourceList>;
function Probe({ enabled = true }: { enabled?: boolean }) { result = useRemoteResourceList('teammates', targets, enabled); return null; }
async function render(enabled = true) { root ??= createRoot(document.createElement('div')); await act(async () => root!.render(createElement(Probe, { enabled }))); }
beforeEach(() => {
  vi.clearAllMocks(); h.app.currentState = 'active'; h.app.listener = null; h.auth.accountGeneration = 1; h.auth.user.id = 'owner'; h.cached = []; h.focused = true;
  h.link.status = 'online'; h.link.connectionEpoch = 1; h.link.getPresenceAvailability.mockReturnValue(true);
  h.list.mockResolvedValue({ items: [] }); h.link.openLink.mockResolvedValue(undefined);
  h.snapshot.mockImplementation(async () => ({ home: [], items: { teammates: h.cached }, read: {} }));
});
afterEach(() => { act(() => root?.unmount()); root = undefined; vi.useRealTimers(); });
describe('shared real resource list', () => {
  it('fills a slow disk shard after another computer replied, without reviving its deleted rows', async () => {
    vi.useFakeTimers();
    let finish!: (snapshot: unknown) => void;
    h.snapshot.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    h.list.mockImplementation(async (_invoke, host) => host.deviceId === 'mac'
      ? { items: [] } : new Promise(() => {}));
    await render();
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    await act(async () => finish({ home: [], items: { teammates: [cached(targets[0], 'deleted'), cached(targets[1], 'saved-pc')] }, read: {} }));
    expect(result.items.map(row => row.item.ref.id)).toEqual(['saved-pc']);
    expect(result.isOnline(targets[1])).toBe(false);
  });
  // Regression: one sleeping computer raised a section-wide warning on a healthy phone.
  // Unit: real roster hook, cached offline shard + a successful online shard.
  it('keeps known offline computers without reporting a failed refresh and reads them on return', async () => {
    h.cached = [cached(targets[1], 'sleeping')];
    h.link.getPresenceAvailability.mockImplementation(id => id !== 'pc');
    h.list.mockResolvedValue({ items: [item('fresh')] });
    await render();
    expect(result.items.map(row => row.item.ref.id)).toEqual(['fresh', 'sleeping']);
    expect(result.error).toBeNull();
    expect(result.isOnline(targets[1])).toBe(false);
    expect(h.link.openLink.mock.calls.map(([id]) => id)).toEqual(['mac']);
    h.link.getPresenceAvailability.mockReturnValue(true);
    h.link.presenceVersion++;
    await render();
    expect(result.items.map(row => row.item.ref.id)).toEqual(['fresh', 'fresh']);
    expect(result.isOnline(targets[1])).toBe(true);
  });
  it('reconciles deletion from a successful host, retains a failed host as offline, and reports partial failures', async () => {
    h.cached = [cached(targets[0], 'deleted'), cached(targets[1], 'offline')];
    h.list.mockImplementation(async (_invoke, host) => {
      if (host.deviceId === 'pc') throw new Error('host unavailable');
      return { items: [item('fresh')] };
    });
    await render();
    expect(result.items.map((row) => row.item.ref.id)).toEqual(['fresh', 'offline']);
    expect(result.isOnline(targets[0])).toBe(true);
    expect(result.isOnline(targets[1])).toBe(false);
    expect(result.error).toContain('host unavailable');
    expect(h.persist).toHaveBeenCalledWith('owner', 'teammates', result.items);
  });
  it('bounds cache hydration and never resurrects stale entries when a late cache arrives after live deletion', async () => {
    vi.useFakeTimers();
    let finish!: (snapshot: unknown) => void;
    h.snapshot.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await render(); expect(h.list).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(h.list).toHaveBeenCalledTimes(2); expect(result.items).toEqual([]);
    await act(async () => finish({ items: { teammates: [cached(targets[0], 'deleted')] } }));
    expect(result.items).toEqual([]);
  });
  it('preserves the roster offline without claiming it can open or issuing requests', async () => {
    h.cached = [cached(targets[0], 'cached')]; h.link.status = 'offline';
    await render();
    expect(result.items[0].item.ref.id).toBe('cached');
    expect(result.isOnline(targets[0])).toBe(false);
    expect(h.list).not.toHaveBeenCalled();
    expect(result.loading).toBe(false);
    expect(result.error).toContain('devices.resources.hostOffline');
  });
  it('does not treat a malformed response as authoritative deletion', async () => {
    h.cached = [cached(targets[0], 'keep')]; h.list.mockResolvedValue({ unexpected: true });
    await render();
    expect(result.items[0].item.ref.id).toBe('keep');
    expect(result.error).toContain('devices.resources.loadFailed');
  });
  it('fences late old-account replies and never paints the old profile for the new account', async () => {
    let settle!: (value: unknown) => void;
    h.list.mockReturnValue(new Promise((resolve) => { settle = resolve; }));
    h.cached = [cached(targets[0], 'private')];
    await render();
    h.cached = []; h.auth.accountGeneration = 2; h.auth.user.id = 'next-owner';
    h.list.mockResolvedValue({ items: [] });
    await render();
    expect(result.items).toEqual([]);
    await act(async () => settle({ items: [item('old-account-reply')] }));
    expect(result.items).toEqual([]);
    expect(h.persist.mock.calls.some(([owner, , rows]) => owner === 'next-owner' && rows.some((row: HostedRemoteCollectionItem) => row.item.ref.id === 'old-account-reply'))).toBe(false);
  });
  it('refreshes from an offline cache after reconnect and cancels requests while the picker is closed', async () => {
    h.cached = [cached(targets[0], 'old')];
    await render(false); expect(h.list).not.toHaveBeenCalled();
    h.list.mockResolvedValue({ items: [item('new')] });
    await render(true);
    expect(result.items[0].item.ref.id).toBe('new');
    h.link.status = 'offline'; h.link.connectionEpoch = 2;
    await render(); expect(result.isOnline(targets[0])).toBe(false);
    h.link.status = 'online'; await render();
    expect(result.isOnline(targets[0])).toBe(true);
  });
});

it('waits for each host link before reading and recovers a failed handshake without losing cached items', async () => {
  h.cached = [cached(targets[0], 'cached')];
  let connect!: () => void;
  h.link.openLink.mockImplementation((deviceId: string) => deviceId === 'mac'
    ? new Promise<void>(resolve => { connect = resolve; }) : Promise.reject(new Error('handshake failed')));
  await render(); expect(h.list).not.toHaveBeenCalled();
  h.list.mockResolvedValue({ items: [item('fresh')] });
  await act(async () => connect());
  expect(h.list).toHaveBeenCalledTimes(1);
  expect(result.items.map(row => row.item.ref.id)).toEqual(['fresh']);
  expect(result.isOnline(targets[1])).toBe(false);
  h.link.openLink.mockResolvedValue(undefined); h.link.connectionEpoch++;
  await render();
  expect(result.isOnline(targets[1])).toBe(true);
});


it.each([false, true])('coalesces generation invalidations while reading and drains the latest roster (failed=%s)', async (failed) => {
  let settle!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  h.list.mockReturnValue(new Promise((resolve, fail) => { settle = resolve; reject = fail; }));
  await render();
  const notify = h.link.onRemoteResourceChanged.mock.calls.at(-1)![0];
  await act(async () => { for (let n = 0; n < 20; n++) notify('mac', { collectionId: 'teammates' }); });
  // Each host has one request, with just one follow-up roster read queued.
  expect(h.list).toHaveBeenCalledTimes(2);
  h.list.mockResolvedValue({ items: [item('latest-final')] });
  await act(async () => failed ? reject(new Error('stale read failed')) : settle({ items: [item('old-phase')] }));
  expect(h.list).toHaveBeenCalledTimes(4);
  expect(result.items.map(row => row.item.ref.id)).toEqual(['latest-final', 'latest-final']);
  expect(result.loading).toBe(false);
});

it('drops queued invalidations when the picker closes', async () => {
  let settle!: (value: unknown) => void;
  h.list.mockReturnValue(new Promise(resolve => { settle = resolve; }));
  await render();
  const notify = h.link.onRemoteResourceChanged.mock.calls.at(-1)![0];
  await act(async () => notify('mac', { collectionId: 'teammates' }));
  await render(false);
  await act(async () => settle({ items: [item('late')] }));
  expect(h.list).toHaveBeenCalledTimes(2);
  expect(result.items).toEqual([]);
});

it('retains loaded rows and an empty result on return while refreshing in the background', async () => {
  h.list.mockResolvedValue({ items: [item('visible')] });
  await render();
  const previous = result.items;
  h.focused = false; await render();
  let finish!: (value: unknown) => void;
  h.list.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  h.focused = true; await render();
  expect(result.items).toBe(previous); expect(result.loading).toBe(false); expect(result.syncing).toBe(true);
  expect(result.refreshing).toBe(false);
  await act(async () => finish({ items: [] }));
  expect(result.items).toEqual([]); expect(result.loading).toBe(false);
  h.focused = false; await render();
  h.list.mockReturnValue(new Promise(() => {}));
  h.focused = true; await render();
  expect(result.items).toEqual([]); expect(result.loading).toBe(false); expect(result.syncing).toBe(true);
});
it('shows disk-cached rows during the first slow network read without claiming authority', async () => {
  h.cached = [cached(targets[0], 'cached-visible')];
  h.list.mockReturnValue(new Promise(() => {}));
  await render();
  expect(result.items[0].item.ref.id).toBe('cached-visible');
  expect(result.loading).toBe(true); expect(result.syncing).toBe(true);
  expect(result.isOnline(targets[0])).toBe(false);
});

it('ends a stalled cold relay wait with cached rows and retries after reconnect', async () => {
  vi.useFakeTimers();
  h.cached = [cached(targets[0], 'cached-startup')];
  h.link.status = 'connecting';
  await render();
  expect(h.list).not.toHaveBeenCalled();
  expect(result.loading).toBe(true);
  await act(async () => vi.advanceTimersByTimeAsync(REMOTE_RESOURCE_STARTUP_TIMEOUT_MS));
  expect(result.loading).toBe(false);
  expect(result.error).toContain('devices.resources.hostOffline');
  expect(result.items.map(row => row.item.ref.id)).toEqual(['cached-startup']);
  h.link.status = 'online'; h.link.connectionEpoch++;
  h.list.mockResolvedValue({ items: [item('fresh-after-reconnect')] });
  await render();
  expect(h.list).toHaveBeenCalled();
  expect(result.error).toBeNull();
});

it('commits and persists a successful host before a slow sibling settles', async () => {
  let finish!: (value: unknown) => void;
  h.list.mockImplementation(async (_invoke, host) => host.deviceId === 'mac' ? { items: [item('fresh-mac')] }
    : new Promise(resolve => { finish = resolve; }));
  await render();
  expect(result.items.map(row => row.item.ref.id)).toEqual(['fresh-mac']);
  expect(result.isOnline(targets[0])).toBe(true);
  expect(result.syncing).toBe(true);
  expect(result.loading).toBe(true);
  expect(h.persist).toHaveBeenCalledWith('owner', 'teammates', result.items);
  await act(async () => finish({ items: [] }));
  expect(result.syncing).toBe(false);
});

it('keeps current-epoch evidence through a failed refresh, retries only failures, then stops on success', async () => {
  vi.useFakeTimers();
  h.list.mockResolvedValue({ items: [item('previous')] }); await render();
  h.list.mockImplementation(async (_invoke, host) => {
    if (host.deviceId === 'mac') throw new Error('INVOKE_TIMEOUT');
    return { items: [item('fresh-pc')] };
  });
  await act(async () => { void result.refresh(); });
  await act(async () => vi.advanceTimersByTimeAsync(7750));
  expect(result.isOnline(targets[0])).toBe(true);
  expect(result.items.map(row => row.item.ref.id)).toEqual(['previous', 'fresh-pc']);
  const before = h.list.mock.calls.length;
  h.list.mockResolvedValue({ items: [item('recovered')] });
  await act(async () => vi.advanceTimersByTimeAsync(900));
  expect(h.list.mock.calls.slice(before).map(([, host]) => host.deviceId)).toEqual(['mac']);
  expect(result.items.map(row => row.item.ref.id)).toEqual(['recovered', 'fresh-pc']);
  await act(async () => vi.advanceTimersByTimeAsync(60000));
  expect(h.list).toHaveBeenCalledTimes(before + 1);
});

it('does not authorize an old epoch while a new read is pending and cancels retry when hidden', async () => {
  vi.useFakeTimers(); await render();
  h.link.connectionEpoch++;
  h.list.mockRejectedValue(new Error('INVOKE_TIMEOUT'));
  await render(); expect(result.isOnline(targets[0])).toBe(false);
  await act(async () => vi.advanceTimersByTimeAsync(7750));
  h.focused = false; await render();
  const before = h.list.mock.calls.length;
  await act(async () => vi.advanceTimersByTimeAsync(60000));
  expect(h.list).toHaveBeenCalledTimes(before);
});

it('cancels foreground retries and late replies in the background and resumes on return', async () => {
  vi.useFakeTimers();
  let finish!: (value: unknown) => void;
  h.list.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  await render();
  h.app.currentState = 'background';
  await act(async () => h.app.listener!('background'));
  await act(async () => finish({ items: [item('background-late')] }));
  expect(result.items).toEqual([]);
  const before = h.list.mock.calls.length;
  await act(async () => vi.advanceTimersByTimeAsync(60000));
  expect(h.list).toHaveBeenCalledTimes(before);
  h.list.mockResolvedValue({ items: [item('foreground-fresh')] });
  h.app.currentState = 'active';
  await act(async () => h.app.listener!('active'));
  expect(result.items.map(row => row.item.ref.id)).toEqual(['foreground-fresh', 'foreground-fresh']);
});
