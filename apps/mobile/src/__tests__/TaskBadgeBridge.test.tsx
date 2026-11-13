// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, expect, it, vi } from 'vitest';

// Unit/React: Android has no ActivityKit. Exercise the actual mounted bridge,
// REST/push writer; minimum failure is a filtered Home overwriting account totals.
const h = vi.hoisted(() => ({
  badge: vi.fn(async (_count: number) => true),
  native: {} as { setTaskBadgeIdentity?: (...args: string[]) => Promise<void>; applyTaskBadge?: (summary: string) => Promise<boolean> },
  received: new Set<(notification: unknown) => void>(),
  fetch: vi.fn(),
  preferenceListeners: new Set<() => void>(),
  stateListeners: new Set<(state: string) => void>(),
  enabled: true,
  account: 'owner',
  relay: null as object | null,
}));
vi.mock('react-native', () => ({ Platform: { OS: 'android' }, AppState: {
  currentState: 'active', addEventListener: (_: string, fn: (state: string) => void) => {
    h.stateListeners.add(fn); return { remove: () => h.stateListeners.delete(fn) };
  },
} }));
vi.mock('expo-modules-core', () => ({ requireOptionalNativeModule: () => h.native }));
vi.mock('@/notifications/nativeNotifications', () => ({ default: { setBadgeCountAsync: h.badge,
  addNotificationReceivedListener: (fn: (notification: unknown) => void) => {
    h.received.add(fn); return { remove: () => h.received.delete(fn) };
  },
} }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ initialized: true, isAuthenticated: true,
  user: { id: h.account }, accountGeneration: 1, apiFetch: h.fetch }) }));
vi.mock('@/device-link/selfHostedRelay', () => ({ useSelfHostedRelay: () => h.relay }));
vi.mock('@/config/env', () => ({ getActiveMobileSessionRealm: () => 'global',
  loadMobileEndpointsForRealm: async () => undefined,
  getMobileEndpointForRealm: () => 'https://relay.example',
}));
vi.mock('@/notifications/pushNotifications', () => ({
  isPushSupported: () => true,
  readPushEnabled: async () => h.enabled,
  subscribePushPreferences: (fn: () => void) => { h.preferenceListeners.add(fn); return () => h.preferenceListeners.delete(fn); },
}));
import { TaskBadgeBridge } from '@/notifications/TaskBadgeBridge';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const summary = (version = '1', badgeCount = 6) => ({ schemaVersion: 1, accountId: 'owner', version,
  waitingCount: badgeCount, unreadCount: 0, runningCount: 3, badgeCount, complete: true });
beforeEach(() => { vi.clearAllMocks(); delete h.native.setTaskBadgeIdentity; delete h.native.applyTaskBadge;
  h.enabled = true; h.relay = null; h.account = 'owner'; h.fetch.mockResolvedValue(summary()); });
it('updates Android from global REST/push totals and refreshes on foreground without ActivityKit', async () => {
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(createElement(TaskBadgeBridge)));
    expect(h.badge).toHaveBeenLastCalledWith(6);
    expect(h.fetch).toHaveBeenCalledWith('/api/device-link/task-activity', expect.objectContaining({ baseUrl: 'https://relay.example', cache: 'no-store' }));
    await act(async () => h.received.forEach(fn => fn({ request: { content: { data: { taskActivity: summary('2', 9) } } } })));
    expect(h.badge).toHaveBeenLastCalledWith(9);
    await act(async () => { h.enabled = false; h.preferenceListeners.forEach(fn => fn()); });
    expect(h.fetch).toHaveBeenCalledTimes(1);
    h.enabled = true;
    h.fetch.mockResolvedValue(summary('3', 0));
    // A launcher may decline badge support; the bridge still runs and cleans up.
    h.badge.mockResolvedValueOnce(false);
    await act(async () => h.stateListeners.forEach(fn => fn('active')));
    expect(h.badge).toHaveBeenLastCalledWith(0);
  } finally { await act(async () => root.unmount()); }
  expect(h.received.size + h.preferenceListeners.size + h.stateListeners.size).toBe(0);
});

it('preserves native values and stops requesting an unsupported server, and skips self-hosted relay', async () => {
  h.fetch.mockRejectedValue({ status: 404 });
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(createElement(TaskBadgeBridge)));
    await act(async () => h.stateListeners.forEach(fn => fn('active')));
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.badge).not.toHaveBeenCalled();
    h.relay = {};
    await act(async () => root.render(createElement(TaskBadgeBridge)));
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.received.size).toBe(0);
  } finally { await act(async () => root.unmount()); }
});

it('discards delayed data after switching account', async () => {
  let resolve!: (data: unknown) => void;
  h.fetch.mockImplementationOnce(() => new Promise(done => { resolve = done; })).mockResolvedValue(undefined);
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(createElement(TaskBadgeBridge)));
    h.account = 'other';
    await act(async () => root.render(createElement(TaskBadgeBridge)));
    await act(async () => resolve(summary()));
    expect(h.badge).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); }
});

it('passes complete versions and incomplete watermarks to native Android, including APNs-shaped fields', async () => {
  h.native.setTaskBadgeIdentity = vi.fn(async () => undefined);
  h.native.applyTaskBadge = vi.fn(async () => true);
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(createElement(TaskBadgeBridge)));
    expect(h.native.setTaskBadgeIdentity).toHaveBeenCalledWith('global:owner', 'owner');
    expect(h.native.applyTaskBadge).toHaveBeenLastCalledWith(JSON.stringify(summary()));
    const partial = { ...summary('2', 0), complete: false };
    await act(async () => h.received.forEach(fn => fn({ request: { trigger: { payload: { taskActivity: partial } } } })));
    expect(h.native.applyTaskBadge).toHaveBeenLastCalledWith(JSON.stringify(partial));
    expect(h.badge).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); }
  expect(h.native.setTaskBadgeIdentity).toHaveBeenLastCalledWith('', '');
});
