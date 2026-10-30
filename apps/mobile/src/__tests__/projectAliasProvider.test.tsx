// @vitest-environment jsdom
// Unit regression: use the real DeviceLinkProvider, registry and mirror so metadata stays current across owner release/background.
// Generic mirror tests cannot detect Provider wiring errors. Minimal failure: home owns sessions while another
// page releases session:task, or the last owner leaves/returns before the first alias response.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Envelope, InvokePayload, InvokeResultPayload, LinkAcceptPayload } from '@cindy/device-link';
import { PROJECT_ALIASES_GET_CHANNEL, PROJECT_ALIASES_CHANGED_CHANNEL } from '@cindy/maker-shared/project-alias-sync';
import { DeviceLinkProvider, useDeviceLink, type DeviceLinkContextValue } from '@/device-link/DeviceLinkContext';
import { remoteProjectAliasesSnapshot, useRemoteProjectAliases } from '@/session/remoteProjectAliases';
import { buildMobileHomePresentation } from '@/session/mobileHome';

const auth = vi.hoisted(() => ({
  isAuthenticated: true,
  accountGeneration: 0,
  user: { id: 'test-account' },
  getAccessToken: vi.fn(async () => 'test-token'),
  apiFetch: vi.fn(async () => ({ devices: [] })),
}));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => auth }));
const appState = vi.hoisted(() => ({ state: 'active', change: (_next: string) => {} }));
vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  AppState: {
    get currentState() { return appState.state; },
    addEventListener: (_event: string, listener: typeof appState.change) => {
      appState.change = listener;
      return { remove() {} };
    },
  },
}));
vi.mock('expo-network', () => ({ getNetworkStateAsync: vi.fn(async () => ({ isConnected: true })), addNetworkStateListener: () => ({ remove() {} }) }));
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async () => null), setItemAsync: vi.fn(async () => {}), deleteItemAsync: vi.fn(async () => {}),
}));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
  getItem: vi.fn(async () => null), setItem: vi.fn(async () => {}), removeItem: vi.fn(async () => {}),
  getAllKeys: vi.fn(async () => []), multiRemove: vi.fn(async () => {}),
} }));
// Native WebView lifecycle has separate coverage; this suite exercises Provider subscriptions.
vi.mock('@/device-link/DirectLinkTransport', () => ({ DirectLinkTransport: () => null }));
vi.mock('expo-updates', () => ({ updateId: null, runtimeVersion: null, isEmbeddedLaunch: true }));
vi.mock('expo-crypto', () => ({ getRandomBytes: (size: number) => new Uint8Array(size) }));
vi.mock('@/device-link/rnWebSocket', () => ({ createRnWebSocket: vi.fn() }));
vi.mock('@/debug/mobileDebugLog', () => ({ mobileDebugLog: vi.fn() }));
vi.mock('@/debug/visualMock', () => ({ prepareVisualMockDeviceLinkContext: vi.fn() }));

// Keep the actual Provider, registry, ACK table and alias mirror. Only the wire is fake.
const transport = vi.hoisted(() => {
  class Client {
    invoke = vi.fn<(_device: string, request: InvokePayload) => Promise<InvokeResultPayload>>();
    openLink = vi.fn(async (): Promise<LinkAcceptPayload> => ({ appVersion: 'test', allowlistHash: 'test' }));
    start = vi.fn();
    stop = vi.fn();
    connectNow = vi.fn();
    notifyNetworkChanged = vi.fn();
    getStatus = () => 'online';
    hasServerCapability = () => false;
    isOutboundExplicitlyClosed = () => false;
    hasPendingRequestsTo = () => false;
    onStatusChange = () => () => {};
    onPresenceChanged = () => () => {};
    onPeerTransportReset = () => () => {};
    onConnectionIssue = () => () => {};
    frame: (envelope: Envelope) => void = () => {};
    onFrame(listener: Client['frame']) { this.frame = listener; return () => {}; }
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
let root: Root;
let context: DeviceLinkContextValue;
let aliasReads: Array<(alias: string | null) => void>;
let container: HTMLDivElement;
const sessions = [{ id: 'one', title: 'unchanged task', workingDir: '/repo/app', deviceLinkDeviceId: 'host',
  workspaceKind: 'project' as const, status: 'active' as const, agentKind: 'cc' as const, model: 'model',
  createdAt: '2026-10-23T00:00:00.000Z', updatedAt: '2026-10-23T00:00:00.000Z' }];
function Probe() {
  context = useDeviceLink();
  const projectAliases = useRemoteProjectAliases();
  return createElement('div', null, buildMobileHomePresentation({ sessions, projectAliases }).projects[0]?.title);
}
const currentAlias = () => remoteProjectAliasesSnapshot().get('host')?.aliases[0]?.alias;

beforeEach(async () => {
  auth.accountGeneration += 1;
  appState.state = 'active';
  transport.clients.length = 0;
  aliasReads = [];
  container = document.createElement('div');
  root = createRoot(container);
  await act(async () => root.render(createElement(DeviceLinkProvider, null, createElement(Probe))));
  transport.clients[0].invoke.mockImplementation(async (_deviceId, request) => {
    if (request.channel !== PROJECT_ALIASES_GET_CHANNEL) return { ok: true, result: [] };
    return new Promise<InvokeResultPayload>((resolve) => {
      aliasReads.push((alias) => resolve({ ok: true, result: {
        aliases: alias === null ? [] : [{ projectKey: 'local:/repo/app', alias }],
        platform: 'darwin',
        ownerStamp: { dataOwnerId: 'test-account', ownerGeneration: 1 },
      } }));
    });
  });
});
afterEach(async () => {
  await act(async () => {
    root.unmount();
    for (const resolve of aliasReads) resolve('finished after unmount');
  });
});

describe('project aliases follow the Provider sessions subscription lifetime', () => {
  // The real React mirror subscription must update a mounted presentation without any session mutation.
  it('updates a mounted project heading on host rename and removal notifications', async () => {
    await act(async () => context.subscribe('home', 'host', ['sessions']));
    expect(container.textContent).toBe('app');
    await act(async () => aliasReads[0]('电脑改后的项目名'));
    expect(container.textContent).toBe('电脑改后的项目名');
    await act(async () => transport.clients[0].frame({
      kind: 'push', src: 'host', dst: 'controller',
      payload: { channel: PROJECT_ALIASES_CHANGED_CHANNEL, payload: {},
        ownerStamp: { dataOwnerId: 'test-account', ownerGeneration: 1 } },
    } as Envelope));
    expect(aliasReads).toHaveLength(2);
    await act(async () => aliasReads[1](null));
    expect(container.textContent).toBe('app');
    expect(sessions[0].title).toBe('unchanged task');
  });

  it('keeps the home alias read alive when another owner releases its individual session stream', async () => {
    await act(async () => {
      await context.subscribe('home', 'host', ['sessions']);
      await context.subscribe('conversation', 'host', ['sessions', 'session:task']);
    });
    expect(aliasReads).toHaveLength(1);
    await act(async () => context.unsubscribe('conversation', 'host', ['sessions', 'session:task']));
    await act(async () => aliasReads[0]('仍属于首页的项目名'));
    expect(currentAlias()).toBe('仍属于首页的项目名');
  });

  it('starts a new read after the last owner leaves and immediately returns, fencing the old response', async () => {
    await act(async () => context.subscribe('home', 'host', ['sessions']));
    expect(aliasReads).toHaveLength(1);
    await act(async () => {
      await context.unsubscribe('home', 'host', ['sessions']);
      await context.subscribe('home', 'host', ['sessions']);
    });
    expect(aliasReads).toHaveLength(2);
    await act(async () => aliasReads[1]('重新进入后的项目名'));
    expect(currentAlias()).toBe('重新进入后的项目名');
    await act(async () => aliasReads[0]('离开前的旧项目名'));
    expect(currentAlias()).toBe('重新进入后的项目名');
  });

  it('refreshes a sessions-only page after a short background stay without waiting for its old read', async () => {
    await act(async () => context.subscribe('home', 'host', ['sessions']));
    expect(aliasReads).toHaveLength(1);
    await act(async () => {
      appState.state = 'background'; appState.change('background');
      appState.state = 'active'; appState.change('active');
    });
    await vi.waitFor(() => expect(aliasReads).toHaveLength(2));
    await act(async () => aliasReads[1]('回到前台后的项目名'));
    expect(currentAlias()).toBe('回到前台后的项目名');
    await act(async () => aliasReads[0]('后台迟到项目名'));
    expect(currentAlias()).toBe('回到前台后的项目名');
    expect(transport.clients[0].stop).not.toHaveBeenCalled();
  });
});
