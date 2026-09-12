// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEVICE_LINK_CAPABILITY_HISTORY_VIEW_V1,
  type DeviceLinkClient,
  type DeviceLinkStatus,
  type DeviceView,
  type LinkAcceptPayload,
  type PresenceSnapshot,
} from '@cindy/device-link';
import { isHistoryViewUnavailable } from '@cindy/maker-shared/message-window';
import { DeviceLinkProvider, useDeviceLink, type DeviceLinkContextValue } from '../device-link/DeviceLinkContext';

const auth = vi.hoisted(() => ({
  isAuthenticated: true,
  accountGeneration: 1,
  user: { id: 'test-account' },
  getAccessToken: vi.fn(async () => 'test-token'),
  apiFetch: vi.fn(async (..._args: unknown[]): Promise<{ devices: DeviceView[] }> => ({ devices: [] })),
}));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => auth }));
const networkEvents = vi.hoisted(() => ({
  state: 'active',
  app: (_next: string) => {},
  network: (_next: { type: string; isConnected: boolean; isInternetReachable: boolean }) => {},
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  AppState: {
    get currentState() { return networkEvents.state; },
    addEventListener: (_event: string, listener: typeof networkEvents.app) => {
      networkEvents.app = listener; return { remove() {} };
    },
  },
}));
vi.mock('expo-network', () => ({ addNetworkStateListener: (listener: typeof networkEvents.network) => {
  networkEvents.network = listener; return { remove() {} };
} }));
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async () => null), setItemAsync: vi.fn(async () => {}), deleteItemAsync: vi.fn(async () => {}),
}));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
  getItem: vi.fn(async () => null), setItem: vi.fn(async () => {}), removeItem: vi.fn(async () => {}),
  getAllKeys: vi.fn(async () => []), multiRemove: vi.fn(async () => {}),
} }));
vi.mock('@/device-link/rnWebSocket', () => ({ createRnWebSocket: vi.fn() }));
vi.mock('@/debug/mobileDebugLog', () => ({ mobileDebugLog: vi.fn() }));
vi.mock('@/debug/visualMock', () => ({ createVisualMockDeviceLinkContext: vi.fn(), seedVisualMockStore: vi.fn() }));

// Only the transport boundary is fake. Mount the real Provider, including its
// handshake single-flight cache, invalidation callbacks and invoke send path.
const transport = vi.hoisted(() => {
  class Client {
    status: DeviceLinkStatus = 'online';
    statusChanged: (status: DeviceLinkStatus) => void = () => {};
    presenceChanged: (snapshot: PresenceSnapshot) => void = () => {};
    peerReset: Parameters<DeviceLinkClient['onPeerTransportReset']>[0] = () => {};
    openLink = vi.fn<(deviceId: string) => Promise<LinkAcceptPayload>>();
    invoke = vi.fn(async () => ({ ok: true, result: 'history page' }));
    start = vi.fn();
    stop = vi.fn();
    connectNow = vi.fn();
    notifyNetworkChanged = vi.fn();
    getStatus = () => this.status;
    isOutboundExplicitlyClosed = () => false;
    // No background recovery owner; each test explicitly starts the fresh read.
    hasPendingRequestsTo = () => false;
    onStatusChange(listener: Client['statusChanged']) { this.statusChanged = listener; return () => {}; }
    onPresenceChanged(listener: Client['presenceChanged']) { this.presenceChanged = listener; return () => {}; }
    onPeerTransportReset(listener: Client['peerReset']) { this.peerReset = listener; return () => {}; }
    onConnectionIssue = () => () => {};
    onFrame = () => () => {};
    onReliableFrameBeforeLink = () => () => {};
  }
  return { Client, clients: [] as Client[] };
});
vi.mock('@cindy/device-link', async (importOriginal) => ({
  ...await importOriginal<typeof import('@cindy/device-link')>(),
  DeviceLinkClient: class extends transport.Client {
    constructor() { super(); transport.clients.push(this); }
  },
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const supported = [DEVICE_LINK_CAPABILITY_HISTORY_VIEW_V1];
const accepted = (capabilities?: string[]): LinkAcceptPayload => ({ appVersion: 'test', allowlistHash: 'test', capabilities });
const historyChannel = 'local-db:messages:view';
let root: Root;
let context: DeviceLinkContextValue;
function Probe() { context = useDeviceLink(); return null; }
function render() { root.render(createElement(DeviceLinkProvider, null, createElement(Probe))); }
function deferredAccept() {
  let resolve!: (value: LinkAcceptPayload) => void;
  const promise = new Promise<LinkAcceptPayload>(done => { resolve = done; });
  return { promise, resolve };
}
function deferredRoster() {
  let resolve!: (value: { devices: DeviceView[] }) => void;
  const promise = new Promise<{ devices: DeviceView[] }>(done => { resolve = done; });
  return { promise, resolve };
}
async function readHistory() {
  // Attach rejection handling immediately: lifecycle tests intentionally reject.
  let result!: Promise<unknown>;
  await act(async () => { result = context.invoke('host', historyChannel).catch(error => error); });
  return { result };
}

beforeEach(async () => {
  networkEvents.state = 'active';
  auth.accountGeneration = 1;
  auth.apiFetch.mockReset();
  auth.apiFetch.mockResolvedValue({ devices: [] });
  transport.clients.length = 0;
  root = createRoot(document.createElement('div'));
  await act(async () => render());
});
afterEach(async () => { await act(async () => root.unmount()); });

describe('Provider device roster reads', () => {
  it('starts a fresh snapshot when Home joins a recovery read that predates its presence fence', async () => {
    const stale = deferredRoster();
    const current = deferredRoster();
    auth.apiFetch.mockReturnValueOnce(stale.promise).mockReturnValueOnce(current.promise);
    const client = transport.clients[0];

    await act(async () => {
      client.status = 'online';
      client.statusChanged('online');
    });
    expect(auth.apiFetch).toHaveBeenCalledTimes(1);

    await act(async () => client.presenceChanged({
      deviceId: 'desktop', deviceName: 'Desktop', platform: 'darwin', appVersion: 'test',
      online: true, remoteControlEnabled: true, busy: false, lastSeenAt: 1,
    }));
    const joined = context.readDeviceList();
    expect(auth.apiFetch).toHaveBeenCalledTimes(1);
    const fresh = context.readDeviceList({ fresh: true });
    expect(auth.apiFetch).toHaveBeenCalledTimes(2);

    const desktop: DeviceView = {
      deviceId: 'desktop', name: 'Desktop', platform: 'darwin', appVersion: 'test',
      online: true, remoteControlEnabled: true, busy: false, lastSeenAt: new Date(1).toISOString(),
      isSelf: false,
    };
    await act(async () => {
      stale.resolve({ devices: [] });
      current.resolve({ devices: [desktop] });
    });

    expect(await joined).toEqual({ devices: [] });
    expect(await fresh).toEqual({ devices: [desktop] });
  });
});

describe('Provider network recovery priority', () => {
  const wifi = { type: 'WIFI', isConnected: true, isInternetReachable: true };
  it('coalesces equal hints but expedites transport changes and offline recovery', async () => {
    const client = transport.clients[0];
    await act(async () => {
      networkEvents.network(wifi);
      networkEvents.network(wifi);
      networkEvents.network({ ...wifi, type: 'CELLULAR' });
      networkEvents.network({ type: 'NONE', isConnected: false, isInternetReachable: false });
      networkEvents.network(wifi);
    });
    expect(client.notifyNetworkChanged.mock.calls).toEqual([
      [{ urgent: false }], [{ urgent: false }], [{ urgent: true }], [{ urgent: true }],
    ]);
  });

  it.each(['online', 'stopped', 'connecting'] as const)('recovers immediately from background with a %s connection', async (status) => {
    const client = transport.clients[0];
    client.status = status;
    await act(async () => {
      networkEvents.state = 'background'; networkEvents.app('background');
      networkEvents.network(wifi);
    });
    expect(client.notifyNetworkChanged).not.toHaveBeenCalled();
    await act(async () => {
      networkEvents.state = 'active'; networkEvents.app('active');
    });
    expect(client.connectNow).toHaveBeenCalledWith('appstate-active', { overrideCongestionCooldown: true });
    if (status === 'online') expect(client.notifyNetworkChanged).toHaveBeenCalledWith({ urgent: true });
    else expect(client.notifyNetworkChanged).not.toHaveBeenCalled();
    expect(client.stop).not.toHaveBeenCalled();
  });
});

describe('Provider history handshake lifetime', () => {
  it.each(['presence', 'reconnect', 'peer reset', 'account switch'] as const)(
    'rejects a late accept after %s and lets the current handshake read history', async (event) => {
      const client = transport.clients[0];
      const old = deferredAccept();
      const current = deferredAccept();
      client.openLink.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
      const pending = await readHistory();
      expect(client.openLink).toHaveBeenCalledTimes(1);
      expect(client.invoke).not.toHaveBeenCalled();

      await act(async () => {
        if (event === 'presence') {
          client.presenceChanged({ deviceId: 'host', deviceName: 'Host', platform: 'win32',
            appVersion: 'test', online: true, remoteControlEnabled: true, busy: false, lastSeenAt: 0 });
        } else if (event === 'reconnect') {
          client.status = 'stopped'; client.statusChanged('stopped');
          client.status = 'online'; client.statusChanged('online');
        } else if (event === 'peer reset') {
          client.peerReset({ deviceId: 'host', reason: 'ack-timeout', connectionEpoch: 1, linkGeneration: 1, seq: 1 });
        } else {
          auth.accountGeneration++;
          render();
        }
      });
      const currentClient = transport.clients.at(-1)!;
      if (currentClient !== client) currentClient.openLink.mockReturnValueOnce(current.promise);
      const fresh = await readHistory();

      // An obsolete legacy accept must not permanently downgrade the controller.
      await act(async () => old.resolve(accepted()));
      const error = await pending.result;
      expect(error).toMatchObject({ code: 'NOT_CONNECTED' });
      expect(isHistoryViewUnavailable(error)).toBe(false);
      expect(client.invoke).not.toHaveBeenCalled();
      expect(currentClient.invoke).not.toHaveBeenCalled();

      await act(async () => current.resolve(accepted(supported)));
      expect(await fresh.result).toBe('history page');
      expect(currentClient.invoke).toHaveBeenCalledTimes(1);
      expect(currentClient.invoke).toHaveBeenCalledWith('host', { channel: historyChannel, args: [] }, undefined);
      // A late old completion must not evict the new successful single-flight.
      await act(async () => { expect(await context.invoke('host', historyChannel)).toBe('history page'); });
      expect(currentClient.openLink).toHaveBeenCalledTimes(currentClient === client ? 2 : 1);
    },
  );

  it('does not send a stale supported invocation or invalidate another peer', async () => {
    const client = transport.clients[0];
    const old = deferredAccept();
    client.openLink.mockReturnValueOnce(old.promise).mockResolvedValue(accepted(supported));
    const pending = await readHistory();
    await act(async () => { await context.invoke('other-host', historyChannel); });
    await act(async () => client.peerReset({ deviceId: 'host', reason: 'ack-timeout', connectionEpoch: 1, linkGeneration: 1, seq: 1 }));
    await act(async () => old.resolve(accepted(supported)));
    expect(await pending.result).toMatchObject({ code: 'NOT_CONNECTED' });
    expect(client.invoke).toHaveBeenCalledTimes(1);
    await act(async () => { await context.invoke('other-host', historyChannel); });
    expect(client.openLink.mock.calls.map(([deviceId]) => deviceId)).toEqual(['host', 'other-host']);
  });

  it('shares the current handshake across all projection channels without blocking legacy reads', async () => {
    const client = transport.clients[0];
    const open = deferredAccept();
    client.openLink.mockReturnValue(open.promise);
    const channels = [historyChannel, 'local-db:messages:work-details', 'local-db:messages:view-intent'];
    let pending!: Promise<unknown>[];
    await act(async () => { pending = channels.map(channel => context.invoke('host', channel)); });
    expect(client.openLink).toHaveBeenCalledTimes(1);
    expect(client.invoke).not.toHaveBeenCalled();
    await act(async () => { await context.invoke('host', 'local-db:messages:list'); });
    expect(client.invoke).toHaveBeenCalledTimes(1);
    await act(async () => { open.resolve(accepted(supported)); await Promise.all(pending); });
    expect(client.invoke).toHaveBeenCalledTimes(4);
    expect(client.openLink).toHaveBeenCalledTimes(1);
  });
});
