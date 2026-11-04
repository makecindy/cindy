// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  auth: { user: { id: 'owner' }, accountGeneration: 1 }, revoked: new Set<string>(),
  snapshot: vi.fn(),
  translation: { t: (key: string) => key, i18n: { language: 'en' } },
  link: { status: 'online', connectionEpoch: 1, presenceVersion: 1, invoke: vi.fn(), openLink: vi.fn(), readDeviceList: vi.fn() },
  list: { items: [] as import('@/device-link/remoteResources').HostedRemoteCollectionItem[], loading: false, refreshing: false, error: null, isOnline: vi.fn(() => true), refresh: vi.fn() },
}));
vi.mock('react-native', () => ({ AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) } }));
vi.mock('expo-router', async () => { const { useEffect } = await import('react'); return { useFocusEffect: (effect: any) => useEffect(effect, [effect]) }; });
vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));
vi.mock('react-i18next', () => ({ useTranslation: () => h.translation }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => h.auth }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => h.link }));
vi.mock('@/device-link/devices', () => ({ toDeviceListItems: (devices: unknown) => devices }));
vi.mock('@/device-link/revokedDevicesStore', () => ({ useRevokedDevices: () => h.revoked }));
vi.mock('@/device-link/remoteStatus', async () => ({ ...await vi.importActual<typeof import('@/device-link/remoteStatus')>('@/device-link/remoteStatus'), formatRemoteError: String }));
vi.mock('@/device-link/remoteResourceCache', () => ({ cacheRemoteResourceHome: vi.fn(), readRemoteResourceSnapshot: h.snapshot }));
vi.mock('@/session/useRemoteResourceList', () => ({ useRemoteResourceList: () => h.list }));
import { REMOTE_RESOURCE_STARTUP_TIMEOUT_MS } from '@/device-link/remoteResourceAvailability';
import { useTeammateRoster } from '@/session/useTeammateRoster';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
let result: ReturnType<typeof useTeammateRoster>;
function Probe() { result = useTeammateRoster(); return null; }
async function render() { root ??= createRoot(document.createElement('div')); await act(async () => root!.render(createElement(Probe))); }

// Unit regression: account-only roster bindings used to retain the previous relay's
// hosts after a route switch, including when the new route could not answer.
it('drops the previous relay hosts when the same account switches to an unreachable route', async () => {
  const { setActiveSelfHostedRelay, __testing } = await import('@/device-link/selfHostedRelayRouting');
  await render();
  expect(result.targets.map(host => host.deviceId)).toEqual(['old', 'new']);
  h.link.status = 'offline';
  try {
    await act(async () => setActiveSelfHostedRelay({ relayId: 'test-relay', name: 'Test',
      baseUrl: 'https://relay.unit.invalid', credential: 'fake-test-credential', signing: null }));
    await render();
    expect(result.targets).toEqual([]);
    expect(result.items).toEqual([]);
    expect(h.auth.accountGeneration).toBe(1);
  } finally {
    await act(async () => __testing.reset());
  }
});
beforeEach(() => {
  vi.clearAllMocks(); h.list.items = []; h.revoked.clear(); h.link.openLink.mockResolvedValue(undefined); h.link.status = 'online'; h.link.connectionEpoch = 1; h.auth.accountGeneration = 1;
  h.list.isOnline.mockReturnValue(true);
  h.snapshot.mockResolvedValue({ home: [], items: {}, read: {} });
  h.link.readDeviceList.mockResolvedValue({ devices: ['old', 'new'].map(deviceId => ({ device: { deviceId, name: deviceId }, canOpen: true, state: 'online' })) });
  h.link.invoke.mockImplementation(async (deviceId) => ({ protocolVersion: 1, collections: [{ id: 'teammates', title: 'Teammates', resourceKind: 'bot', placement: 'home-scope', ...(deviceId === 'new' ? { actions: [{ id: 'open-create', label: 'Create' }] } : {}) }] }));
});
afterEach(() => { act(() => root?.unmount()); root = undefined; vi.useRealTimers(); });
it('offers only real online hosts advertising create, including a host with an empty roster', async () => {
  await render();
  expect(result.targets.map(host => host.deviceId)).toEqual(['old', 'new']);
  expect(result.createTargets).toEqual([{ deviceId: 'new', deviceName: 'another computer (1)' }]);
  expect(h.link.invoke).toHaveBeenCalledTimes(2); // No extra capability probe or mutation.
  expect(result.authoritative).toBe(true);
  h.list.isOnline.mockReturnValue(false); await render(); expect(result.createTargets).toEqual([]);
  // Offline cached shards no longer raise refresh errors, but are still not authoritative.
  expect(result.authoritative).toBe(false);
});
it('does not treat initial offline discovery as authoritative; recovers on connection', async () => {
  h.link.status = 'offline'; await render(); expect(result.authoritative).toBe(false); expect(result.createTargets).toEqual([]);
  h.link.status = 'online'; h.link.connectionEpoch++; await render();
  expect(result.authoritative).toBe(true); expect(result.createTargets[0].deviceId).toBe('new');
});

it('keeps a cold launch loading while the relay is starting, without reporting cached hosts offline', async () => {
  const cached = { key: 'old:bot', host: { deviceId: 'old', deviceName: 'Old' }, item: {
    ref: { collectionId: 'teammates', kind: 'bot', id: 'bot' }, revision: '1', display: { title: 'Cached' }, links: [],
  } };
  h.link.status = 'stopped';
  h.list.items = [cached];
  h.snapshot.mockResolvedValue({ home: [], items: { teammates: [cached] }, read: {} });
  h.link.readDeviceList.mockRejectedValue(new Error('should wait for relay'));
  await render();
  expect(result.items).toEqual([cached]);
  expect(result.loading).toBe(true);
  expect(result.error).toBeNull();
  expect(h.link.readDeviceList).not.toHaveBeenCalled();
});
it('falls back to the cached roster after a stalled relay startup and recovers on reconnect', async () => {
  vi.useFakeTimers();
  const cached = { key: 'old:bot', host: { deviceId: 'old', deviceName: 'Old' }, item: {
    ref: { collectionId: 'teammates', kind: 'bot', id: 'bot' }, revision: '1', display: { title: 'Cached' }, links: [],
  } };
  h.link.status = 'connecting';
  h.list.items = [cached];
  h.snapshot.mockResolvedValue({ home: [], items: { teammates: [cached] }, read: {} });
  await render();
  expect(result.loading).toBe(true);
  await act(async () => vi.advanceTimersByTimeAsync(REMOTE_RESOURCE_STARTUP_TIMEOUT_MS));
  expect(result.loading).toBe(false);
  expect(result.items).toEqual([cached]);
  expect(result.error).toContain('devices.resources.hostOffline');
  h.link.status = 'online'; h.link.connectionEpoch++;
  await render();
  expect(h.link.readDeviceList).toHaveBeenCalled();
});
it('drops old account discovery replies', async () => {
  let finish!: (value: unknown) => void;
  h.link.readDeviceList.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await render(); h.auth.accountGeneration++; h.link.readDeviceList.mockResolvedValue({ devices: [] }); await render();
  await act(async () => finish({ devices: [{ device: { deviceId: 'old-owner', name: 'Private' }, canOpen: true, state: 'online' }] }));
  expect(result.targets).toEqual([]); expect(result.createTargets).toEqual([]);
});

it('clears prior-account create and group capabilities before the new directory answers', async () => {
  h.link.invoke.mockResolvedValue({ protocolVersion: 1, collections: [
    { id: 'teammates', title: 'Teammates', resourceKind: 'bot', placement: 'home-scope', actions: [{ id: 'open-create', label: 'Create' }] },
    { id: 'bot-groups', title: 'Groups', resourceKind: 'bot-group' },
  ] });
  await render();
  expect(result.createTargets).not.toEqual([]);
  expect(result.groupTargets).not.toEqual([]);
  h.auth.accountGeneration++;
  h.link.readDeviceList.mockReturnValue(new Promise(() => {}));
  await render();
  expect(result.createTargets).toEqual([]);
  expect(result.groupTargets).toEqual([]);
  expect(result.targets).toEqual([]);
});

it('does not request the manifest until the host link is established', async () => {
  const release: Array<() => void> = [];
  h.link.openLink.mockImplementation(() => new Promise<void>(resolve => release.push(resolve)));
  await render(); expect(h.link.invoke).not.toHaveBeenCalled();
  await act(async () => release.forEach(resolve => resolve()));
  expect(result.targets.map(host => host.deviceId)).toEqual(['old', 'new']);
  expect(result.createTargets.map(host => host.deviceId)).toEqual(['new']);
});

it('shows cached teammates while host discovery is pending, then removes revoked hosts', async () => {
  h.list.items = [{ key: 'old:bot', host: { deviceId: 'old', deviceName: 'Old' }, item: {
    ref: { collectionId: 'teammates', kind: 'bot', id: 'bot' }, revision: '1', display: { title: 'Cached' }, links: [],
  } }];
  h.link.readDeviceList.mockReturnValue(new Promise(() => {}));
  h.snapshot.mockResolvedValue({ home: [], items: { teammates: h.list.items }, read: {} });
  h.list.isOnline.mockReturnValue(false);
  await render();
  expect(result.items).toHaveLength(1); expect(result.loading).toBe(true);
  expect(result.authoritative).toBe(false); expect(result.isOnline(h.list.items[0].host)).toBe(false);
  h.revoked = new Set(['old']); await render();
  expect(result.items).toEqual([]);
});

it('exposes only computers whose manifest advertises group chats, keeping them through a failed read', async () => {
  const manifest = (groups: boolean) => ({ protocolVersion: 1, collections: [
    { id: 'teammates', title: 'Teammates', resourceKind: 'bot', placement: 'home-scope' },
    ...(groups ? [{ id: 'bot-groups', title: 'Group Chats', resourceKind: 'bot-group' }] : []),
  ] });
  h.link.invoke.mockImplementation(async (deviceId) => manifest(deviceId === 'new'));
  await render();
  expect(result.groupTargets).toEqual([{ deviceId: 'new', deviceName: 'another computer (1)' }]);
  // A transient manifest failure keeps the computer's groups; an older desktop never gains them.
  h.link.invoke.mockImplementation(async (deviceId) => { if (deviceId === 'new') throw new Error('timeout'); return manifest(false); });
  h.link.connectionEpoch++; await render();
  expect(result.groupTargets.map((host) => host.deviceId)).toEqual(['new']);
  // A computer that answers without the collection drops it.
  h.link.invoke.mockImplementation(async () => manifest(false));
  h.link.connectionEpoch++; await render();
  expect(result.groupTargets).toEqual([]);
});

it('publishes a discovered teammate host without waiting for an unrelated manifest', async () => {
  let finish!: (value: unknown) => void;
  h.link.invoke.mockImplementation(async device => device === 'old'
    ? { protocolVersion: 1, collections: [{ id: 'teammates', resourceKind: 'bot', title: 'Teammates', placement: 'home-scope' }] }
    : new Promise(resolve => { finish = resolve; }));
  await render();
  expect(result.targets.map(host => host.deviceId)).toEqual(['old']);
  expect(result.authoritative).toBe(false);
  await act(async () => finish({ protocolVersion: 1, collections: [] }));
  expect(result.targets.map(host => host.deviceId)).toEqual(['old']);
  expect(result.authoritative).toBe(true);
});

it('retries only failed manifests while preserving healthy capabilities and stable list targets', async () => {
  vi.useFakeTimers();
  h.link.invoke.mockImplementation(async device => {
    if (device === 'new') throw new Error('INVOKE_TIMEOUT');
    return { protocolVersion: 1, collections: [
      { id: 'teammates', title: 'Teammates', resourceKind: 'bot', placement: 'home-scope', actions: [{ id: 'open-create', label: 'Create' }] },
      { id: 'bot-groups', title: 'Groups', resourceKind: 'bot-group' },
    ] };
  });
  await render();
  await act(async () => vi.advanceTimersByTimeAsync(7750));
  const stableTargets = result.targets;
  expect(h.link.openLink.mock.calls.filter(([device]) => device === 'old')).toHaveLength(1);
  const before = h.link.openLink.mock.calls.length;
  h.link.invoke.mockImplementation(async device => device === 'new'
    ? { protocolVersion: 1, collections: [] }
    : { protocolVersion: 1, collections: [
      { id: 'teammates', title: 'Teammates', resourceKind: 'bot', placement: 'home-scope', actions: [{ id: 'open-create', label: 'Create' }] },
      { id: 'bot-groups', title: 'Groups', resourceKind: 'bot-group' },
    ] });
  await act(async () => vi.advanceTimersByTimeAsync(900));
  expect(h.link.openLink.mock.calls.slice(before)).toEqual([['new']]);
  expect(result.targets).toBe(stableTargets);
  expect(h.link.openLink.mock.calls.filter(([device]) => device === 'old')).toHaveLength(1);
  expect(result.createTargets.map(host => host.deviceId)).toEqual(['old']);
  expect(result.groupTargets.map(host => host.deviceId)).toEqual(['old']);
  const recovered = h.link.openLink.mock.calls.length;
  await act(async () => vi.advanceTimersByTimeAsync(60000));
  expect(h.link.openLink).toHaveBeenCalledTimes(recovered);
});

it('does not restore a removed capability from cached rows on a sibling retry', async () => {
  vi.useFakeTimers();
  const cached = { key: 'old:bot', host: { deviceId: 'old', deviceName: 'Old' }, item: {
    ref: { collectionId: 'teammates', kind: 'bot', id: 'bot' }, revision: '1', display: { title: 'Cached' }, links: [],
  } };
  h.snapshot.mockResolvedValue({ home: [], items: { teammates: [cached] }, read: {} });
  h.list.items = [cached];
  h.link.invoke.mockImplementation(async device => {
    if (device === 'new') throw new Error('INVOKE_TIMEOUT');
    return { protocolVersion: 1, collections: [] };
  });
  await render();
  await act(async () => vi.advanceTimersByTimeAsync(7750));
  expect(result.targets).toEqual([]); expect(result.items).toEqual([]);
  const before = h.link.openLink.mock.calls.length;
  h.link.invoke.mockResolvedValue({ protocolVersion: 1, collections: [] });
  await act(async () => vi.advanceTimersByTimeAsync(900));
  expect(h.link.openLink.mock.calls.slice(before)).toEqual([['new']]);
  expect(result.targets).toEqual([]); expect(result.items).toEqual([]);
});

it('retains in-memory teammates if the disk capability read stalls', async () => {
  vi.useFakeTimers();
  const { readRemoteCollectionCache, writeRemoteCollectionCache } = await import('@/device-link/remoteResourceAvailability');
  const cached = { key: 'old:bot', host: { deviceId: 'old', deviceName: 'Old' }, item: {
    ref: { collectionId: 'teammates', kind: 'bot', id: 'bot' }, revision: '1', display: { title: 'Cached' }, links: [],
  } };
  readRemoteCollectionCache(JSON.stringify(['owner', 1, 'official']), 'teammates');
  writeRemoteCollectionCache(JSON.stringify(['owner', 1, 'official']), 'teammates', [cached]);
  h.list.items = [cached];
  h.snapshot.mockReturnValue(new Promise(() => {}));
  h.link.readDeviceList.mockReturnValue(new Promise(() => {}));
  await render();
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(result.targets.map(host => host.deviceId)).toEqual(['old']);
  expect(result.items).toEqual([cached]);
  expect(result.loading).toBe(true);
});

it('keeps every cached roster host in the list targets while a partial home manifest catches up', async () => {
  const hosts = ['old', 'new'].map(deviceId => ({ deviceId, deviceName: deviceId }));
  const rows = hosts.map(host => ({ key: host.deviceId, host, item: {
    ref: { collectionId: 'teammates', kind: 'bot', id: host.deviceId }, revision: '1', display: { title: host.deviceId }, links: [],
  } }));
  h.snapshot.mockResolvedValue({ home: [{ id: 'teammates', title: 'Teammates', resourceKind: 'bot', placement: 'home-scope', targets: [hosts[0]] }],
    items: { teammates: rows }, read: {} });
  h.list.items = rows;
  let finish!: (value: unknown) => void;
  h.link.invoke.mockImplementation(async device => device === 'old'
    ? { protocolVersion: 1, collections: [{ id: 'teammates', title: 'Teammates', resourceKind: 'bot', placement: 'home-scope' }] }
    : new Promise(resolve => { finish = resolve; }));
  await render();
  // The real list reader may persist a successful old-host shard now. It must
  // still receive the new host as a target so it cannot prune its cached rows.
  expect(result.targets.map(host => host.deviceId)).toEqual(['old', 'new']);
  expect(result.items).toEqual(rows);
  await act(async () => finish({ protocolVersion: 1, collections: [] }));
  expect(result.targets.map(host => host.deviceId)).toEqual(['old']);
  expect(result.items).toEqual([rows[0]]);
});
