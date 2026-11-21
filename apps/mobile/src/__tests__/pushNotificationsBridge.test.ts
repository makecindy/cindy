// @vitest-environment jsdom
// Unit regression: iOS reports the current token on every token read. Mounting
// the real bridge must settle, and a real rotation must still upload its token.
// Realm tests cover HTTP/signing; this fixture covers the missing event wiring.
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { PushNotificationsBridge } from '@/notifications/PushNotificationsBridge';

const state = vi.hoisted(() => ({
  listener: null as null | ((token: { type: 'ios'; data: string }) => void),
  enabled: true,
  uploads: [] as string[],
  reads: 0,
  failNextSync: false,
  nativeToken: 'initial-token',
  unregisterAttempts: 0,
  pendingUnregister: false,
  foregroundListeners: new Set<(state: string) => void>(),
  auth: { initialized: true, isAuthenticated: true, accountGeneration: 1,
    user: { id: 'fixture-user' }, apiFetch: async () => ({}) },
}));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/', useGlobalSearchParams: () => ({}) }));
vi.mock('react-native', () => ({ AppState: { addEventListener: (_: string, listener: (state: string) => void) => {
  state.foregroundListeners.add(listener); return { remove() { state.foregroundListeners.delete(listener); } };
} } }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => state.auth }));
vi.mock('@/device-link/selfHostedRelay', () => ({ useSelfHostedRelay: () => null }));
vi.mock('@/notifications/NotificationReconciliationBridge', () => ({ NotificationReconciliationBridge: () => null }));
vi.mock('@/notifications/ChatBackgroundBridge', () => ({ ChatBackgroundBridge: () => null }));
vi.mock('@/notifications/nativeNotifications', () => ({ default: {
  addPushTokenListener: (listener: typeof state.listener) => {
    state.listener = listener; return { remove() { state.listener = null; } };
  },
  addNotificationResponseReceivedListener: () => ({ remove() {} }),
  getLastNotificationResponseAsync: async () => null,
} }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'en' } }) }));
vi.mock('@/notifications/notificationActionRunner', () => ({ handleNotificationActionResponse: () => false }));
vi.mock('@/notifications/pushNotifications', () => ({
  configureForegroundNotificationBehavior() {}, registerNotificationActionCategories: async () => {}, isPushSupported: () => true,
  readPushEnabled: async () => state.enabled, retryPendingUnregister: async () => {
    if (!state.pendingUnregister) return true;
    if (++state.unregisterAttempts === 1) return false;
    state.pendingUnregister = false;
    return true;
  },
  syncPushRegistration: async (opts: { deviceToken?: { type: 'ios'; data: string } }) => {
    if (state.failNextSync) {
      state.failNextSync = false;
      throw new Error('temporarily offline');
    }
    let token = opts.deviceToken;
    if (!token) {
      if (++state.reads > 3) throw Error('recursive native registration');
      token = { type: 'ios', data: state.nativeToken };
      state.listener?.(token);
    }
    state.uploads.push(token.data);
    return 'registered';
  },
}));

const roots: ReturnType<typeof createRoot>[] = [];
afterEach(async () => {
  await act(async () => { for (const root of roots) root.unmount(); });
  roots.length = 0; state.uploads = []; state.reads = 0; state.failNextSync = false; state.enabled = true;
  state.nativeToken = 'initial-token'; state.unregisterAttempts = 0; state.pendingUnregister = false;
  vi.unstubAllGlobals();
});

it('settles native callbacks and uploads only changed event tokens without another native read', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const root = createRoot(document.createElement('div')); roots.push(root);
  await act(async () => { root.render(createElement(PushNotificationsBridge)); });
  expect(state.reads).toBe(1);
  expect(state.uploads.every(token => token === 'initial-token')).toBe(true);
  expect(state.uploads.length).toBeLessThanOrEqual(2);
  const before = state.uploads.length;
  await act(async () => {
    state.listener?.({ type: 'ios', data: 'initial-token' });
    state.listener?.({ type: 'ios', data: 'rotated-token' });
    state.listener?.({ type: 'ios', data: 'rotated-token' });
  });
  expect(state.uploads.slice(before)).toEqual(['rotated-token']);
  expect(state.reads).toBe(1);
  state.enabled = false;
  await act(async () => { state.listener?.({ type: 'ios', data: 'disabled-token' }); });
  expect(state.uploads).not.toContain('disabled-token');
});

// Unit regression: refreshing the same signed-in profile must not re-upload
// its push token. The native-event test above does not rerender the auth context.
it('keeps the same registration after a profile refresh and resyncs on account switch', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const root = createRoot(document.createElement('div'));
  roots.push(root);
  const auth = state.auth;
  try {
    await act(async () => { root.render(createElement(PushNotificationsBridge)); });
    const uploads = [...state.uploads];
    await act(async () => {
      state.auth = { ...auth, user: { ...auth.user } };
      root.render(createElement(PushNotificationsBridge));
    });
    expect(state.uploads).toEqual(uploads);
    await act(async () => {
      state.auth = { ...auth, accountGeneration: auth.accountGeneration + 1, user: { id: 'next-user' } };
      root.render(createElement(PushNotificationsBridge));
    });
    expect(state.reads).toBe(2);
    expect(state.uploads.length).toBeGreaterThan(uploads.length);
  } finally {
    state.auth = auth;
  }
});

// A cached session can render offline and recover without changing its account ID.
it('recovers a failed initial registration on profile refresh, then stops repeating it', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const root = createRoot(document.createElement('div'));
  roots.push(root);
  const auth = state.auth;
  try {
    state.failNextSync = true;
    await act(async () => { root.render(createElement(PushNotificationsBridge)); });
    expect(state.uploads).toEqual([]);
    const refreshProfile = () => act(async () => {
      state.auth = { ...auth, user: { ...auth.user } };
      root.render(createElement(PushNotificationsBridge));
    });
    await refreshProfile();
    expect(state.uploads).toContain('initial-token');
    const uploads = [...state.uploads];
    await refreshProfile();
    expect(state.uploads).toEqual(uploads);
  } finally {
    state.auth = auth;
  }
});

// Cached sessions must repair both a failed opt-out and a failed token rotation
// on foreground, even if iOS never emits another token event.
it.each(['unregister', 'rotation'] as const)('recovers a pending %s on foreground', async (operation) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const root = createRoot(document.createElement('div'));
  roots.push(root);
  if (operation === 'unregister') {
    state.enabled = false;
    state.pendingUnregister = true;
  }
  await act(async () => { root.render(createElement(PushNotificationsBridge)); });
  if (operation === 'rotation') {
    state.nativeToken = 'rotated-token';
    state.failNextSync = true;
    await act(async () => { state.listener?.({ type: 'ios', data: state.nativeToken }); });
    expect(state.uploads).not.toContain('rotated-token');
  }
  const foreground = () => act(async () => {
    for (const listener of state.foregroundListeners) listener('active');
  });
  await foreground();
  if (operation === 'unregister') {
    expect(state.unregisterAttempts).toBe(2);
    expect(state.uploads).toEqual([]);
  } else {
    expect(state.uploads).toContain('rotated-token');
  }
  const reads = state.reads;
  await foreground();
  expect(state.reads).toBe(reads);
});
