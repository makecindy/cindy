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
  auth: { initialized: true, isAuthenticated: true, accountGeneration: 1,
    user: { id: 'fixture-user' }, apiFetch: async () => ({}) },
}));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/', useGlobalSearchParams: () => ({}) }));
vi.mock('react-native', () => ({ AppState: { addEventListener: () => ({ remove() {} }) } }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => state.auth }));
vi.mock('@/device-link/selfHostedRelay', () => ({ useSelfHostedRelay: () => null }));
vi.mock('@/notifications/ChatBackgroundBridge', () => ({ ChatBackgroundBridge: () => null }));
vi.mock('@/notifications/nativeNotifications', () => ({ default: {
  addPushTokenListener: (listener: typeof state.listener) => {
    state.listener = listener; return { remove() { state.listener = null; } };
  },
  addNotificationResponseReceivedListener: () => ({ remove() {} }),
  getLastNotificationResponseAsync: async () => null,
} }));
vi.mock('@/notifications/pushNotifications', () => ({
  configureForegroundNotificationBehavior() {}, isPushSupported: () => true,
  readPushEnabled: async () => state.enabled, retryPendingUnregister: async () => {},
  syncPushRegistration: async (opts: { deviceToken?: { type: 'ios'; data: string } }) => {
    let token = opts.deviceToken;
    if (!token) {
      if (++state.reads > 3) throw Error('recursive native registration');
      token = { type: 'ios', data: 'initial-token' };
      state.listener?.(token);
    }
    state.uploads.push(token.data);
    return 'registered';
  },
}));

const roots: ReturnType<typeof createRoot>[] = [];
afterEach(async () => {
  await act(async () => { for (const root of roots) root.unmount(); });
  roots.length = 0; state.uploads = []; state.reads = 0; state.enabled = true;
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
