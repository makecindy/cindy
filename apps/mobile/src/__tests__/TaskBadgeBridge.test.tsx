// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

// Unit/React: Android has no ActivityKit. Exercise the actual mounted bridge,
// projection and writer; pure projection tests cannot catch a platform guard or
// a preference/store subscription omission. Minimum: waiting + unread + running.
const h = vi.hoisted(() => ({
  badge: vi.fn(async (_count: number) => true),
  storeListeners: new Set<() => void>(),
  preferenceListeners: new Set<() => void>(),
  stateListeners: new Set<(state: string) => void>(),
  enabled: true,
  phases: new Map([['waiting', 'needs-interaction'], ['done', 'completed'], ['running', 'running']]),
}));
vi.mock('react-native', () => ({ Platform: { OS: 'android' }, AppState: {
  currentState: 'active', addEventListener: (_: string, fn: (state: string) => void) => {
    h.stateListeners.add(fn); return { remove: () => h.stateListeners.delete(fn) };
  },
} }));
vi.mock('@/notifications/nativeNotifications', () => ({ default: { setBadgeCountAsync: h.badge } }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ initialized: true, isAuthenticated: true,
  user: { id: 'owner' }, accountGeneration: 1 }) }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => ({ status: 'online',
  getPresenceAvailability: () => true, getSubscriptionIdentity: () => 1, presenceVersion: 0 }) }));
vi.mock('@/notifications/pushNotifications', () => ({
  isPushSupported: () => true,
  readPushEnabled: async () => h.enabled,
  subscribePushPreferences: (fn: () => void) => { h.preferenceListeners.add(fn); return () => h.preferenceListeners.delete(fn); },
}));
vi.mock('@/session/remoteSessionStore', () => ({ remoteSessionStore: {
  // Real desktop mapper emits an empty compatibility userId; the connection
  // and store lifecycle already scope these rows to the authenticated account.
  getHomeSessions: () => [...h.phases.keys()].map(id => ({ id, userId: '', title: id,
    status: 'active', deviceLinkDeviceId: 'computer' })),
  getSessionSnapshotDeviceIds: () => ['computer'],
  getSessionLiveActivity: (id: string) => ({ phase: h.phases.get(id), attention: true }),
  subscribeHomeStatus: (fn: () => void) => { h.storeListeners.add(fn); return () => h.storeListeners.delete(fn); },
} }));
import { TaskBadgeBridge } from '@/notifications/TaskBadgeBridge';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
it('updates Android with the shared count and reacts to read, preferences and foreground without ActivityKit', async () => {
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(createElement(TaskBadgeBridge)));
    expect(h.badge).toHaveBeenLastCalledWith(2);
    await act(async () => { h.phases.delete('done'); h.storeListeners.forEach(fn => fn()); });
    expect(h.badge).toHaveBeenLastCalledWith(1);
    await act(async () => { h.enabled = false; h.preferenceListeners.forEach(fn => fn()); });
    expect(h.badge).toHaveBeenLastCalledWith(0);
    h.enabled = true;
    // A launcher may decline badge support; the bridge still runs and cleans up.
    h.badge.mockResolvedValueOnce(false);
    await act(async () => h.stateListeners.forEach(fn => fn('active')));
    expect(h.badge).toHaveBeenLastCalledWith(1);
  } finally { await act(async () => root.unmount()); }
  expect(h.storeListeners.size + h.preferenceListeners.size + h.stateListeners.size).toBe(0);
});
