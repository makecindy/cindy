// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEVICE_LINK_CAPABILITY_HISTORY_VIEW_V1,
  SHARED_TASK_CAPABILITY,
  type DeviceLinkClient,
  type DeviceLinkStatus,
  type LinkAcceptPayload,
  type PresenceSnapshot,
} from '@cindy/device-link';
import { isHistoryViewUnavailable } from '@cindy/maker-shared/message-window';
import { DeviceLinkProvider, useDeviceLink, type DeviceLinkContextValue } from '../device-link/DeviceLinkContext';
import { acquireDeviceSendSlot, resetDeviceResponsivenessTracking, settleDeviceSend, unresponsiveDevicesStore } from '../device-link/unresponsiveDevicesStore';
import { revokedDevicesStore } from '../device-link/revokedDevicesStore';

const auth = vi.hoisted(() => ({
  isAuthenticated: true,
  accountGeneration: 1,
  user: { id: 'test-account' },
  getAccessToken: vi.fn(async () => 'test-token'),
  apiFetch: vi.fn(async () => ({ devices: [] })),
}));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => auth }));
const networkEvents = vi.hoisted(() => ({
  state: 'active',
  app: (_next: string) => {},
  network: (_next: { type?: string; isConnected?: boolean; isInternetReachable?: boolean }) => {},
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
vi.mock('@cindy/maker-shared/device-responsiveness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cindy/maker-shared/device-responsiveness')>();
  return { ...actual, createDeviceResponsivenessBreaker: (options: Parameters<typeof actual.createDeviceResponsivenessBreaker>[0]) =>
    actual.createDeviceResponsivenessBreaker({ ...options, now: () => Date.now() }) };
});

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
    restartConnection = vi.fn();
    notifyNetworkChanged = vi.fn();
    getStatus = () => this.status;
    serverCapabilities: string[] = [];
    hasServerCapability = (capability: string) => this.serverCapabilities.includes(capability);
    isOutboundExplicitlyClosed = vi.fn((_deviceId: string) => false);
    // No background recovery owner; each test explicitly starts the fresh read.
    hasPendingRequestsTo = vi.fn((_deviceId: string) => false);
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
async function readHistory() {
  // Attach rejection handling immediately: lifecycle tests intentionally reject.
  let result!: Promise<unknown>;
  await act(async () => { result = context.invoke('host', historyChannel).catch(error => error); });
  return { result };
}

beforeEach(async () => {
  networkEvents.state = 'active';
  auth.accountGeneration = 1;
  transport.clients.length = 0;
  root = createRoot(document.createElement('div'));
  await act(async () => render());
});
afterEach(async () => { await act(async () => root.unmount()); });

describe('pending probe reply recovery', () => {
  afterEach(() => {
    resetDeviceResponsivenessTracking();
    revokedDevicesStore.clearAll();
  });
  it.each(['relay reconnect', 'short background'] as const)('reopens the reply link after %s while the old business probe still owns its slot', async recovery => {
    vi.useFakeTimers();
    const client = transport.clients[0];
    client.openLink.mockResolvedValue(accepted(supported));
    let resolveProbe!: (value: { ok: true; result: string }) => void;
    const probe = new Promise<{ ok: true; result: string }>(resolve => { resolveProbe = resolve; });
    client.invoke.mockImplementation(() => probe);
    try {
      await act(async () => { await context.openLink('host'); });
      await act(async () => {
        for (let i = 0; i < 3; i++) settleDeviceSend('host', acquireDeviceSendSlot('host'), 'timeout');
        await vi.advanceTimersByTimeAsync(14_000);
      });
      expect(client.invoke).toHaveBeenCalledExactlyOnceWith('host', expect.objectContaining({ channel: 'local-db:sessions:list' }), expect.any(Number));
      expect(unresponsiveDevicesStore.has('host')).toBe(true);
      client.hasPendingRequestsTo.mockImplementation(device => device === 'host');
      const freshAccept = deferredAccept();
      client.openLink.mockReturnValue(freshAccept.promise);
      if (recovery === 'relay reconnect') {
        await act(async () => { client.status = 'connecting'; client.statusChanged('connecting'); });
        await act(async () => { client.status = 'online'; client.statusChanged('online'); });
      } else {
        // The relay stays online, so the successful pre-background handshake is still cached.
        await act(async () => { networkEvents.state = 'background'; networkEvents.app('background'); });
        await act(async () => { networkEvents.state = 'active'; networkEvents.app('active'); });
        expect(client.stop).not.toHaveBeenCalled();
        expect(client.restartConnection).not.toHaveBeenCalled();
      }
      // The serial recovery scheduler is still awaiting probe; only its reply link may reopen.
      expect(client.openLink).toHaveBeenCalledTimes(2);
      expect(client.invoke).toHaveBeenCalledTimes(1);
      expect(unresponsiveDevicesStore.has('host')).toBe(true);
      // Repeated foreground hints share both pending and accepted handshakes.
      await act(async () => networkEvents.app('active'));
      expect(client.openLink).toHaveBeenCalledTimes(2);
      await act(async () => freshAccept.resolve(accepted(supported)));
      await act(async () => networkEvents.app('active'));
      expect(client.openLink).toHaveBeenCalledTimes(2);
      expect(client.invoke).toHaveBeenCalledTimes(1);
      await act(async () => {
        client.hasPendingRequestsTo.mockReturnValue(false);
        resolveProbe({ ok: true, result: 'probe response' });
      });
      expect(unresponsiveDevicesStore.has('host')).toBe(false);
    } finally {
      await act(async () => { resolveProbe({ ok: true, result: 'cleanup' }); });
      vi.useRealTimers();
    }
  });

  it.each(['no pending request', 'revoked', 'explicitly closed', 'background', 'settled before send', 'offline before send'] as const)(
    'does not bypass lifecycle guards: %s', async reason => {
      vi.useFakeTimers();
      const client = transport.clients[0];
      client.openLink.mockResolvedValue(accepted(supported));
      let resolveProbe!: (value: { ok: true; result: string }) => void;
      client.invoke.mockImplementation(() => new Promise(resolve => { resolveProbe = resolve; }));
      try {
        await act(async () => { await context.openLink('host'); });
        await act(async () => {
          for (let i = 0; i < 3; i++) settleDeviceSend('host', acquireDeviceSendSlot('host'), 'timeout');
          await vi.advanceTimersByTimeAsync(14_000);
        });
        expect(client.invoke).toHaveBeenCalledTimes(1);
        client.hasPendingRequestsTo.mockReturnValue(reason !== 'no pending request');
        await act(async () => {
          client.status = 'connecting'; client.statusChanged('connecting');
          if (reason === 'revoked') revokedDevicesStore.markRevoked('host');
          if (reason === 'explicitly closed') client.isOutboundExplicitlyClosed.mockReturnValue(true);
          if (reason === 'background') { networkEvents.state = 'background'; networkEvents.app('background'); }
          client.status = 'online'; client.statusChanged('online');
          // Mutate after the initial guard but before the async send continuation.
          if (reason === 'settled before send') client.hasPendingRequestsTo.mockReturnValue(false);
          if (reason === 'offline before send') { client.status = 'connecting'; client.statusChanged('connecting'); }
        });
        expect(client.openLink).toHaveBeenCalledTimes(1);
        expect(client.invoke).toHaveBeenCalledTimes(1);
        if (reason === 'background') {
          await act(async () => { networkEvents.state = 'active'; networkEvents.app('active'); });
          expect(client.openLink).toHaveBeenCalledTimes(2);
          expect(client.invoke).toHaveBeenCalledTimes(1);
          expect(unresponsiveDevicesStore.has('host')).toBe(true);
        }
      } finally {
        client.hasPendingRequestsTo.mockReturnValue(false);
        await act(async () => resolveProbe?.({ ok: true, result: 'cleanup' }));
        vi.useRealTimers();
      }
    },
  );
});

describe('Provider shared-task relay compatibility', () => {
  it('distinguishes an old online relay from disconnection and re-negotiates after upgrade', async () => {
    const client = transport.clients[0];
    expect(context.sharedTaskAvailable).toBeUndefined();
    await act(async () => client.statusChanged('online'));
    expect(context.sharedTaskAvailable).toBe(false);
    await act(async () => client.statusChanged('connecting'));
    expect(context.sharedTaskAvailable).toBeUndefined();
    client.serverCapabilities = [SHARED_TASK_CAPABILITY];
    await act(async () => client.statusChanged('online'));
    expect(context.sharedTaskAvailable).toBe(true);
    await act(async () => client.statusChanged('stopped'));
    expect(context.sharedTaskAvailable).toBeUndefined();
  });
});

describe('Provider network recovery priority', () => {
  const wifi = { type: 'WIFI', isConnected: true, isInternetReachable: true };
  it('replaces an online socket on physical route changes and retains probes for equal hints', async () => {
    const client = transport.clients[0];
    await act(async () => {
      networkEvents.network(wifi);
      networkEvents.network(wifi);
      networkEvents.network({ ...wifi, type: 'CELLULAR' });
      networkEvents.network({ type: 'NONE', isConnected: false, isInternetReachable: false });
      networkEvents.network(wifi);
    });
    expect(client.notifyNetworkChanged.mock.calls).toEqual([
      [{ urgent: false }], [{ urgent: false }],
    ]);
    expect(client.restartConnection.mock.calls).toEqual([
      ['network-path-changed'], ['network-path-changed'],
    ]);
  });

  it('does not replace a slow socket for reachability changes or repeated network capabilities', async () => {
    const client = transport.clients[0];
    await act(async () => {
      networkEvents.network(wifi);
      networkEvents.network({ ...wifi, isInternetReachable: false });
      networkEvents.network(wifi);
      networkEvents.network(wifi);
    });
    expect(client.restartConnection).not.toHaveBeenCalled();
    expect(client.notifyNetworkChanged.mock.calls).toEqual([
      [{ urgent: false }], [{ urgent: true }], [{ urgent: true }], [{ urgent: false }],
    ]);
  });

  it.each(['UNKNOWN', undefined])('probes an unknown network (%s) without treating it as route loss', async type => {
    const client = transport.clients[0];
    await act(async () => {
      networkEvents.network(wifi);
      networkEvents.network({ type, isConnected: false, isInternetReachable: false });
      networkEvents.network(wifi);
    });
    expect(client.restartConnection).not.toHaveBeenCalled();
    expect(client.notifyNetworkChanged.mock.calls).toEqual([
      [{ urgent: false }], [{ urgent: true }], [{ urgent: true }],
    ]);
  });

  it.each([false, true])('keeps confirmed route loss pending across UNKNOWN (connected=%s)', async isConnected => {
    const client = transport.clients[0];
    await act(async () => {
      networkEvents.network(wifi);
      networkEvents.network({ type: 'NONE', isConnected: false, isInternetReachable: false });
      networkEvents.network({ type: 'UNKNOWN', isConnected, isInternetReachable: false });
    });
    expect(client.restartConnection).not.toHaveBeenCalled();
    await act(async () => networkEvents.network(wifi));
    expect(client.restartConnection).toHaveBeenCalledExactlyOnceWith('network-path-changed');
  });

  it('does not retain unknown background notifications as a lost route', async () => {
    const client = transport.clients[0];
    await act(async () => {
      networkEvents.network(wifi);
      client.notifyNetworkChanged.mockClear();
      networkEvents.state = 'background'; networkEvents.app('background');
      networkEvents.network({ type: 'UNKNOWN', isConnected: false, isInternetReachable: false });
    });
    expect(client.notifyNetworkChanged).not.toHaveBeenCalled();
    await act(async () => {
      networkEvents.state = 'active'; networkEvents.app('active');
      networkEvents.network(wifi);
    });
    expect(client.restartConnection).not.toHaveBeenCalled();
    expect(client.notifyNetworkChanged).toHaveBeenCalledWith({ urgent: true });
  });

  it('remembers a lost route even when the replacement has the same network type', async () => {
    const client = transport.clients[0];
    await act(async () => {
      networkEvents.network(wifi);
      networkEvents.network({ type: 'NONE', isConnected: false, isInternetReachable: false });
      networkEvents.network(wifi);
      networkEvents.network(wifi);
    });
    expect(client.restartConnection).toHaveBeenCalledTimes(1);
  });

  it.each(['connecting', 'stopped'] as const)('does not bypass handshakes or congestion backoff while %s', async status => {
    const client = transport.clients[0];
    client.status = status;
    await act(async () => {
      networkEvents.network(wifi);
      networkEvents.network({ ...wifi, type: 'CELLULAR' });
    });
    expect(client.restartConnection).not.toHaveBeenCalled();
    expect(client.notifyNetworkChanged).toHaveBeenLastCalledWith({ urgent: true });
  });

  it.each([false, true])('defers a background route change unless a new connection supersedes it (connected=%s)', async connected => {
    const client = transport.clients[0];
    await act(async () => {
      networkEvents.network(wifi);
      networkEvents.state = 'background'; networkEvents.app('background');
      networkEvents.network({ ...wifi, type: 'CELLULAR' });
      if (connected) client.statusChanged('online');
    });
    expect(client.restartConnection).not.toHaveBeenCalled();
    await act(async () => {
      networkEvents.state = 'active'; networkEvents.app('active');
    });
    expect(client.restartConnection).toHaveBeenCalledTimes(connected ? 0 : 1);
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
