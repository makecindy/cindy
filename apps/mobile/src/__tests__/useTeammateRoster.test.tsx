// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  auth: { user: { id: 'owner' }, accountGeneration: 1 }, revoked: new Set<string>(),
  translation: { t: (key: string) => key, i18n: { language: 'en' } },
  link: { status: 'online', connectionEpoch: 1, presenceVersion: 1, invoke: vi.fn(), openLink: vi.fn(), readDeviceList: vi.fn() },
  list: { items: [] as import('@/device-link/remoteResources').HostedRemoteCollectionItem[], loading: false, refreshing: false, error: null, isOnline: vi.fn(() => true), refresh: vi.fn() },
}));
vi.mock('react-native', () => ({ AppState: { addEventListener: () => ({ remove() {} }) } }));
vi.mock('expo-router', async () => { const { useEffect } = await import('react'); return { useFocusEffect: (effect: any) => useEffect(effect, [effect]) }; });
vi.mock('react-i18next', () => ({ useTranslation: () => h.translation }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => h.auth }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => h.link }));
vi.mock('@/device-link/devices', () => ({ toDeviceListItems: (devices: unknown) => devices }));
vi.mock('@/device-link/revokedDevicesStore', () => ({ useRevokedDevices: () => h.revoked }));
vi.mock('@/device-link/remoteStatus', () => ({ formatRemoteError: String }));
vi.mock('@/device-link/remoteResourceCache', () => ({ cacheRemoteResourceHome: vi.fn(), readRemoteResourceSnapshot: async () => ({ home: [], items: {}, read: {} }) }));
vi.mock('@/session/useRemoteResourceList', () => ({ useRemoteResourceList: () => h.list }));
import { useTeammateRoster } from '@/session/useTeammateRoster';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
let result: ReturnType<typeof useTeammateRoster>;
function Probe() { result = useTeammateRoster(); return null; }
async function render() { root ??= createRoot(document.createElement('div')); await act(async () => root!.render(createElement(Probe))); }
beforeEach(() => {
  vi.clearAllMocks(); h.list.items = []; h.revoked.clear(); h.link.openLink.mockResolvedValue(undefined); h.link.status = 'online'; h.link.connectionEpoch = 1; h.auth.accountGeneration = 1;
  h.list.isOnline.mockReturnValue(true);
  h.link.readDeviceList.mockResolvedValue({ devices: ['old', 'new'].map(deviceId => ({ device: { deviceId, name: deviceId }, canOpen: true, state: 'online' })) });
  h.link.invoke.mockImplementation(async (deviceId) => ({ protocolVersion: 1, collections: [{ id: 'teammates', title: 'Teammates', resourceKind: 'bot', placement: 'home-scope', ...(deviceId === 'new' ? { actions: [{ id: 'open-create', label: 'Create' }] } : {}) }] }));
});
afterEach(() => { act(() => root?.unmount()); root = undefined; });
it('offers only real online hosts advertising create, including a host with an empty roster', async () => {
  await render();
  expect(result.targets.map(host => host.deviceId)).toEqual(['old', 'new']);
  expect(result.createTargets).toEqual([{ deviceId: 'new', deviceName: 'new' }]);
  expect(h.link.invoke).toHaveBeenCalledTimes(2); // No extra capability probe or mutation.
  expect(result.authoritative).toBe(true);
  h.list.isOnline.mockReturnValue(false); await render(); expect(result.createTargets).toEqual([]);
});
it('does not treat initial offline discovery as authoritative; recovers on connection', async () => {
  h.link.status = 'offline'; await render(); expect(result.authoritative).toBe(false); expect(result.createTargets).toEqual([]);
  h.link.status = 'online'; h.link.connectionEpoch++; await render();
  expect(result.authoritative).toBe(true); expect(result.createTargets[0].deviceId).toBe('new');
});
it('drops old account discovery replies', async () => {
  let finish!: (value: unknown) => void;
  h.link.readDeviceList.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await render(); h.auth.accountGeneration++; h.link.readDeviceList.mockResolvedValue({ devices: [] }); await render();
  await act(async () => finish({ devices: [{ device: { deviceId: 'old-owner', name: 'Private' }, canOpen: true, state: 'online' }] }));
  expect(result.targets).toEqual([]); expect(result.createTargets).toEqual([]);
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
  await render();
  expect(result.items).toHaveLength(1); expect(result.loading).toBe(false);
  expect(result.authoritative).toBe(false); expect(result.isOnline(h.list.items[0].host)).toBe(false);
  h.revoked = new Set(['old']); await render();
  expect(result.items).toEqual([]);
});
