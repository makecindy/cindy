// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SESSION_ACTIVITY_CHANNEL } from '@cindy/device-link';
import { AgentActivityBridge } from '@/widgets/AgentActivityBridge';
import { remoteSessionStore } from '@/session/remoteSessionStore';
import type { RemoteSession } from '@/session/types';

const mock = vi.hoisted(() => ({
  auth: { initialized: true, isAuthenticated: true, user: { id: 'account-a' }, accountGeneration: 1 },
  native: { setState: vi.fn(), markStale: vi.fn() },
  link: {
    status: 'online', presenceVersion: 0,
    getConnectionState: () => ({ status: 'online' }),
    getPresenceAvailability: () => true,
    getSubscriptionIdentity: () => 'acknowledged',
  },
  t: (key: string) => key,
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
}));
vi.mock('expo-modules-core', () => ({ requireOptionalNativeModule: () => mock.native }));
vi.mock('expo-linking', () => ({ createURL: (path: string, { queryParams }: { queryParams: { deviceId: string } }) =>
  `cindy://${path}?deviceId=${queryParams.deviceId}` }));
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
  remoteSessionStore.clear();
  mock.auth = { initialized: true, isAuthenticated: true, user: { id: 'account-a' }, accountGeneration: 1 };
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  remoteSessionStore.clear();
  container.remove();
  vi.useRealTimers();
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
