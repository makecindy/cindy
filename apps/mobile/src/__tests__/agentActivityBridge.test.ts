// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SESSION_ACTIVITY_CHANNEL } from '@cindy/device-link';
import { AgentActivityBridge } from '@/widgets/AgentActivityBridge';
import { remoteSessionStore } from '@/session/remoteSessionStore';
import type { RemoteSession } from '@/session/types';
import type { AgentActivityNative, ActivityPushRegistration } from '@/widgets/agentActivityPush';
import { setMobileAuthOwner } from '@/auth/authOwnerGeneration';

const mock = vi.hoisted(() => ({
  auth: { initialized: true, isAuthenticated: true, user: { id: 'account-a' }, accountGeneration: 1, getAccessToken: async () => 'test-token' },
  native: { setState: vi.fn(), markStale: vi.fn() } as AgentActivityNative & { setState: ReturnType<typeof vi.fn>; markStale: ReturnType<typeof vi.fn> },
  link: {
    status: 'online', presenceVersion: 0,
    getConnectionState: vi.fn((_deviceId: string) => ({ status: 'online' })),
    getPresenceAvailability: vi.fn((_deviceId: string) => true),
    getSubscriptionIdentity: vi.fn((_deviceId: string): string | null => 'acknowledged'),
  },
  appState: { currentState: "active" },
  appStateListeners: new Set<(state: string) => void>(),
  t: (key: string) => key,
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  AppState: Object.assign(mock.appState, {
    addEventListener: (_event: string, listener: (state: string) => void) => {
      mock.appStateListeners.add(listener);
      return { remove: () => mock.appStateListeners.delete(listener) };
    },
  }),
}));
vi.mock('expo-modules-core', () => ({ requireOptionalNativeModule: (name: string) => name === 'ExpoApplication'
  ? { getPushNotificationServiceEnvironmentAsync: async () => 'development' } : mock.native }));
vi.mock('expo-linking', () => ({ createURL: (path: string, options?: { queryParams: { deviceId: string } }) =>
  `cindy://${path}${options ? `?deviceId=${options.queryParams.deviceId}` : ''}` }));
vi.mock('@/config/env', () => ({ AUTH_REGION: 'global', getActiveMobileSessionRealm: () => 'global',
  getMobileEndpointForRealm: () => 'https://example.test' }));
vi.mock('@/device-link/selfHostedRelayRouting', () => ({ getActiveSelfHostedRelay: () => null }));
vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: mock.t }),
}));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => mock.auth }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => mock.link }));

let root: Root;
let container: HTMLDivElement;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mock.appState.currentState = "active";
  mock.appStateListeners.clear();
  remoteSessionStore.clear();
  mock.auth = { initialized: true, isAuthenticated: true, user: { id: 'account-a' }, accountGeneration: 1, getAccessToken: async () => 'test-token' };
  delete mock.native.configureAccount; delete mock.native.getPushRegistration;
  mock.link.presenceVersion = 0;
  mock.link.getConnectionState.mockImplementation(() => ({ status: 'online' }));
  mock.link.getPresenceAvailability.mockImplementation(() => true);
  mock.link.getSubscriptionIdentity.mockImplementation(() => 'acknowledged');
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  remoteSessionStore.clear();
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// Unit: new native push branch. An empty Home during startup must not end an
// existing background activity while its native token/HTTP response is pending.
it('preserves a background activity while native discovery and registration settle', async () => {
  setMobileAuthOwner('account-a', 'global');
  vi.stubGlobal('__DEV__', true);
  let finish!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
  let reveal!: (value: Awaited<ReturnType<NonNullable<AgentActivityNative['getPushRegistration']>>>) => void;
  mock.native.configureAccount = vi.fn(async () => {});
  mock.native.getPushRegistration = vi.fn(() => new Promise<ActivityPushRegistration>(resolve => { reveal = resolve; }));
  await act(() => root.render(createElement(AgentActivityBridge)));
  expect(mock.native.setState).not.toHaveBeenCalled();
  await act(async () => reveal({ accountScope: JSON.stringify(['https://example.test', 'account-a']),
    enabled: true, startToken: 'start', updateToken: 'update', activityId: 'active', dismissed: false, supportsInputPushToken: true }));
  expect(mock.native.setState).not.toHaveBeenCalled();
  await act(async () => finish({ ok: true, status: 200 } as Response));
  expect(mock.native.setState).not.toHaveBeenCalled();
});

// Unit, discussion_r4514700790: failed HTTP registration must leave the real
// bridge subscribed to live host updates, including the final empty projection.
it('updates and ends the local activity when its update token cannot be registered', async () => {
  setMobileAuthOwner('account-a', 'global');
  vi.stubGlobal('__DEV__', true);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503 } as Response)));
  mock.native.configureAccount = vi.fn(async () => {});
  mock.native.getPushRegistration = vi.fn(async () => ({
    accountScope: JSON.stringify(['https://example.test', 'account-a']),
    enabled: true, startToken: 'start', updateToken: 'local', activityId: 'active',
    dismissed: false, supportsInputPushToken: true,
  }));
  const row: RemoteSession = {
    id: 'host-task', userId: '', title: 'Host task', workingDir: '/example', workspaceKind: 'project',
    model: 'claude', effort: 'medium', permissionMode: 'default', fastMode: false,
    status: 'active', agentKind: 'cc', userSendAt: null,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };
  remoteSessionStore.setDeviceSessions('desktop', 'Example Mac', [row]);
  remoteSessionStore.applyRemotePush('desktop', SESSION_ACTIVITY_CHANNEL, {
    sessionId: row.id, phase: 'running', attention: false,
  });
  await act(() => root.render(createElement(AgentActivityBridge)));
  expect(JSON.parse(mock.native.setState.mock.calls.at(-1)![0]).state.status).toBe('running');
  remoteSessionStore.applyRemotePush('desktop', SESSION_ACTIVITY_CHANNEL, {
    sessionId: row.id, phase: 'needs-interaction', attention: true,
  });
  await act(() => vi.advanceTimersByTime(1000));
  expect(JSON.parse(mock.native.setState.mock.calls.at(-1)![0]).state.status).toBe('attention');
  remoteSessionStore.applyRemotePush('desktop', SESSION_ACTIVITY_CHANNEL, {
    sessionId: row.id, phase: 'completed', attention: false,
  });
  await act(() => vi.advanceTimersByTime(1000));
  expect(mock.native.setState).toHaveBeenLastCalledWith(null);
});

// Unit, PR #9507 / discussion_r4511883168: the desktop mapper emits userId:''.
// Projection-only Home tests bypassed the bridge's erroneous ownership filter.
// This separate file mounts the real bridge in jsdom (Home tests are node-only),
// feeds the real store one host row, and observes the outgoing ActivityKit payload.
it('displays an account-scoped host row with empty userId and clears it across account transitions', async () => {
  const row: RemoteSession = {
    id: 'host-task', userId: '', title: 'Host task', workingDir: '/example', workspaceKind: 'project',
    model: 'claude', effort: 'medium', permissionMode: 'default', fastMode: false,
    status: 'active', agentKind: 'cc', userSendAt: null,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };
  remoteSessionStore.setDeviceSessions('desktop', 'Example Mac', [row]);
  remoteSessionStore.applyRemotePush('desktop', SESSION_ACTIVITY_CHANNEL, {
    sessionId: row.id, phase: 'running', compactDetail: 'private arguments', attention: false,
  });
  await act(() => root.render(createElement(AgentActivityBridge)));
  const payload = JSON.parse(mock.native.setState.mock.calls.at(-1)![0]);
  expect(payload).toMatchObject({ accountId: 'account-a', state: {
    title: 'Host task', status: 'running', runningCount: 1, url: 'cindy:///sessions/host-task?deviceId=desktop',
  } });
  expect(JSON.stringify(payload)).not.toContain('private arguments');

  // Queue an update, then perform DeviceLinkProvider's existing per-account clear.
  remoteSessionStore.applyRemotePush('desktop', SESSION_ACTIVITY_CHANNEL, {
    sessionId: row.id, phase: 'needs-interaction', compactDetail: '', attention: true,
  });
  remoteSessionStore.clear();
  mock.auth = { ...mock.auth, user: { id: 'account-b' }, accountGeneration: 2 };
  await act(() => root.render(createElement(AgentActivityBridge)));
  expect(mock.native.setState).toHaveBeenLastCalledWith(null);
  mock.native.setState.mockClear();
  await act(() => vi.advanceTimersByTime(60_000));
  expect(mock.native.setState).not.toHaveBeenCalled();
  mock.auth = { ...mock.auth, isAuthenticated: false, accountGeneration: 3 };
  await act(() => root.render(createElement(AgentActivityBridge)));
  expect(mock.native.setState).toHaveBeenLastCalledWith(null);
});

// Unit, PR #9507 / discussion_r4511994638: an idle online peer must not end
// another peer's unverified activity. Existing single-peer/projection tests
// bypassed reachability filtering; observe native retention, recovery and end.
it.each(['connection', 'presence', 'subscription'] as const)(
  'retains stale activity when one host loses %s while another stays idle', async unavailable => {
    const row: RemoteSession = {
      id: 'task-a', userId: '', title: 'Task A', workingDir: '/example', workspaceKind: 'project',
      model: 'claude', effort: 'medium', permissionMode: 'default', fastMode: false,
      status: 'active', agentKind: 'cc', userSendAt: null,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    };
    remoteSessionStore.setDeviceSessions('a', 'Mac A', [row]);
    remoteSessionStore.setDeviceSessions('b', 'Mac B', [{ ...row, id: 'task-b', title: 'Task B' }]);
    remoteSessionStore.applyRemotePush('a', SESSION_ACTIVITY_CHANNEL, {
      sessionId: 'task-a', phase: 'running', attention: false,
    });
    await act(() => root.render(createElement(AgentActivityBridge)));
    expect(JSON.parse(mock.native.setState.mock.calls.at(-1)![0]).state.title).toBe('Task A');
    mock.native.setState.mockClear();
    if (unavailable === 'connection') mock.link.getConnectionState.mockImplementation(id => ({ status: id === 'a' ? 'offline' : 'online' }));
    if (unavailable === 'presence') mock.link.getPresenceAvailability.mockImplementation(id => id !== 'a');
    if (unavailable === 'subscription') mock.link.getSubscriptionIdentity.mockImplementation(id => id === 'a' ? null : 'acknowledged');
    mock.link.presenceVersion++;
    await act(() => root.render(createElement(AgentActivityBridge)));
    await act(() => vi.advanceTimersByTime(60_000));
    expect(mock.native.markStale).toHaveBeenCalledTimes(1);
    expect(mock.native.setState).not.toHaveBeenCalled();

    // A displayable live peer still supersedes stale content from A.
    remoteSessionStore.applyRemotePush('b', SESSION_ACTIVITY_CHANNEL, {
      sessionId: 'task-b', phase: 'running', attention: false,
    });
    expect(JSON.parse(mock.native.setState.mock.calls.at(-1)![0]).state.title).toBe('Task B');

    // Both hosts now attest to no remaining activity: end immediately.
    mock.link.getConnectionState.mockImplementation(() => ({ status: 'online' }));
    mock.link.getPresenceAvailability.mockImplementation(() => true);
    mock.link.getSubscriptionIdentity.mockImplementation(() => 'acknowledged');
    for (const id of ['a', 'b']) remoteSessionStore.applyRemotePush(id, SESSION_ACTIVITY_CHANNEL, {
      sessionId: `task-${id}`, phase: 'completed', attention: false,
    });
    expect(mock.native.setState).toHaveBeenLastCalledWith(null);
  },
);

// Unit: lock-screen disconnects previously expired or ended the last confirmed
// activity immediately. Mount the production bridge: a queued write, background
// store events and foreground resume must all respect the same lifecycle gate.
it('retains the last confirmed activity through background disconnects and verifies it on resume', async () => {
  const row: RemoteSession = {
    id: 'background-task', userId: '', title: 'Long task', workingDir: '/example', workspaceKind: 'project',
    model: 'claude', effort: 'medium', permissionMode: 'default', fastMode: false,
    status: 'active', agentKind: 'cc', userSendAt: null,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };
  remoteSessionStore.setDeviceSessions('desktop', 'Example Mac', [row]);
  remoteSessionStore.applyRemotePush('desktop', SESSION_ACTIVITY_CHANNEL, {
    sessionId: row.id, phase: 'running', attention: false,
  });
  await act(() => root.render(createElement(AgentActivityBridge)));
  expect(JSON.parse(mock.native.setState.mock.calls.at(-1)![0]).state.status).toBe('running');
  mock.native.setState.mockClear();
  // Queue an update immediately before locking; it must not later renew stale data.
  remoteSessionStore.applyRemotePush('desktop', SESSION_ACTIVITY_CHANNEL, {
    sessionId: row.id, phase: 'needs-interaction', attention: true,
  });
  await act(() => {
    mock.appState.currentState = 'background';
    for (const listener of mock.appStateListeners) listener('background');
    vi.advanceTimersByTime(1_000);
  });
  expect(mock.native.setState).not.toHaveBeenCalled();
  mock.link.getConnectionState.mockImplementation(() => ({ status: 'offline' }));
  remoteSessionStore.applyRemotePush('desktop', SESSION_ACTIVITY_CHANNEL, {
    sessionId: row.id, phase: 'completed', attention: false,
  });
  await act(() => vi.advanceTimersByTime(60_000));
  expect(mock.native.markStale).not.toHaveBeenCalled();
  expect(mock.native.setState).not.toHaveBeenCalled();
  await act(() => {
    mock.appState.currentState = 'active';
    for (const listener of mock.appStateListeners) listener('active');
  });
  expect(mock.native.markStale).toHaveBeenCalledTimes(1);
  expect(mock.native.setState).not.toHaveBeenCalled();
  // Once the foreground connection attests that the task is read, end it.
  mock.link.getConnectionState.mockImplementation(() => ({ status: 'online' }));
  mock.link.presenceVersion++;
  await act(() => root.render(createElement(AgentActivityBridge)));
  expect(mock.native.setState).toHaveBeenLastCalledWith(null);
});
