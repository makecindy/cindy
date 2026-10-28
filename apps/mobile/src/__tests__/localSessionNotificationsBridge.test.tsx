// @vitest-environment jsdom
// Unit: the mounted production bridge must acquire an authorized live lease and deliver
// its frames to the native intake. Existing group-only bridge tests do not exercise
// Device Link, stale subscription nonces, account fencing or local-vs-FCM selection.
// Minimal failure: one completed companion reply while Google token acquisition failed.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Envelope } from '@cindy/device-link';
const h = vi.hoisted(() => ({
  enabled: true, background: true, fallback: true, current: true, nonce: 0,
  preferences: new Set<(signedOut?: boolean) => void>(),
  refresh: new Set<() => void>(),
  configure: vi.fn(), clear: vi.fn(), receive: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn(), token: vi.fn(), roster: vi.fn(),
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => `50000000-0000-4000-8000-${String(++h.nonce).padStart(12, '0')}` }));
vi.mock('@/config/env', () => ({ getActiveMobileSessionRealm: () => 'cn', deviceLinkWsUrl: () => 'wss://relay.invalid/api/device-link/ws' }));
vi.mock('@/auth/authOwnerGeneration', () => ({ getMobileAuthOwner: () => ({}), isMobileAuthOwnerCurrent: () => h.current }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => link }));
vi.mock('@/notifications/pushNotifications', () => ({
  usesLocalSessionNotifications: () => h.fallback, readPushEnabled: async () => h.enabled,
  subscribePushPreferences: (listener: (signedOut?: boolean) => void) => { h.preferences.add(listener); return () => h.preferences.delete(listener); },
}));
vi.mock('@/notifications/chatBackground', () => ({ readChatBackgroundEnabled: async () => h.background,
  subscribeChatBackground: () => () => {},
}));
vi.mock('../../modules/cindy-chat-notifications/src', () => ({ default: {
  configureSessionRelay: h.configure, clearSessionRelay: h.clear, receiveSessionNotification: h.receive,
  addListener: (_: string, listener: () => void) => { h.refresh.add(listener); return { remove() { h.refresh.delete(listener); } }; },
} }));
import { LocalSessionNotificationsBridge } from '@/notifications/LocalSessionNotificationsBridge';
import { dispatchLocalSessionFrame } from '@/notifications/localSessionFrames';
const auth = { isAuthenticated: true, accountGeneration: 1, user: { id: 'member' }, deviceId: 'phone', getAccessToken: h.token };
const link = { status: 'online', connectionEpoch: 1, presenceVersion: 1,
  readDeviceList: h.roster,
  openNotificationLink: async () => ({ capabilities: ['mobile-local-notifications-v1'] }), subscribe: h.subscribe, unsubscribe: h.unsubscribe,
};
let root: Root;
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
beforeEach(() => {
  vi.clearAllMocks(); h.enabled = h.background = h.fallback = h.current = true;
  link.connectionEpoch = 1;
  link.presenceVersion = 1;
  h.roster.mockResolvedValue({ devices: [{ deviceId: 'desktop', remoteControlEnabled: true }, { deviceId: 'disabled', remoteControlEnabled: false }] });
  h.token.mockResolvedValue('invalid-test-token');
  h.configure.mockResolvedValue(undefined); h.clear.mockResolvedValue(undefined); h.receive.mockResolvedValue(undefined);
  h.subscribe.mockResolvedValue(undefined); h.unsubscribe.mockResolvedValue(undefined);
  root = createRoot(document.createElement('div'));
});
afterEach(async () => { await act(async () => root.unmount()); });
async function render() { await act(async () => root.render(createElement(LocalSessionNotificationsBridge))); }
function frame(nonce: string, source = 'desktop'): Envelope { return { v: 1, kind: 'push', src: source, dst: 'phone', payload: {
  channel: 'device-link:mobile-notification', payload: { subscriptionId: nonce, category: 'session-done', eventId: 'a'.repeat(64), deepLink: '/sessions/s1?deviceId=desktop' },
} }; }
it('subscribes only to allowed computers and carries a final reply into native intake with its canonical link', async () => {
  await render();
  expect(h.configure).toHaveBeenCalledWith('member:1:cn', 'member', 'phone', 'wss://relay.invalid/api/device-link/ws', 'invalid-test-token', '["desktop"]');
  expect(h.subscribe).toHaveBeenCalledOnce();
  const [nonce, device, topics] = h.subscribe.mock.calls[0];
  expect(device).toBe('desktop'); expect(topics).toEqual([`notifications:${nonce}`]);
  dispatchLocalSessionFrame(frame('old-lease'));
  dispatchLocalSessionFrame(frame(nonce, 'disabled'));
  dispatchLocalSessionFrame({ ...frame(nonce), sharedTask: {} as never });
  expect(h.receive).not.toHaveBeenCalled();
  dispatchLocalSessionFrame(frame(nonce));
  expect(h.receive).toHaveBeenCalledWith('member:1:cn', 'desktop', expect.stringContaining('/sessions/s1?deviceId=desktop'));
  link.connectionEpoch++;
  await render(); h.receive.mockClear();
  dispatchLocalSessionFrame(frame(nonce));
  expect(h.receive).not.toHaveBeenCalled();
});
it('does not configure a fallback when Google push is available, and fences late credentials after logout', async () => {
  h.fallback = false; await render();
  expect(h.configure).not.toHaveBeenCalled(); expect(h.subscribe).not.toHaveBeenCalled();
  let release!: (token: string) => void;
  h.fallback = true; h.token.mockImplementationOnce(() => new Promise<string>(resolve => { release = resolve; }));
  await act(async () => { for (const listener of h.preferences) listener(); });
  h.current = false; h.fallback = false;
  await act(async () => { for (const listener of h.preferences) listener(true); release('invalid-late-token'); });
  expect(h.configure).not.toHaveBeenCalled(); expect(h.clear).toHaveBeenCalled();
});
it('rotates credentials without polling/replacing leases, and removes only the computer that left the roster', async () => {
  h.roster.mockResolvedValue({ devices: ['desktop', 'desktop-two'].map(deviceId => ({ deviceId, remoteControlEnabled: true })) });
  await render();
  expect(h.subscribe).toHaveBeenCalledTimes(2);
  const [nonce] = h.subscribe.mock.calls.find(([, device]) => device === 'desktop-two')!;
  await act(async () => { for (const listener of h.refresh) listener(); });
  expect(h.roster).toHaveBeenCalledOnce();
  expect(h.subscribe).toHaveBeenCalledTimes(2); expect(h.unsubscribe).not.toHaveBeenCalled();
  h.roster.mockResolvedValue({ devices: [{ deviceId: 'desktop-two', remoteControlEnabled: true }] });
  link.presenceVersion++; await render();
  expect(h.subscribe).toHaveBeenCalledTimes(2);
  expect(h.unsubscribe).toHaveBeenCalledExactlyOnceWith(expect.any(String), 'desktop', expect.any(Array));
  dispatchLocalSessionFrame(frame(nonce, 'desktop-two'));
  expect(h.receive).toHaveBeenCalledWith('member:1:cn', 'desktop-two', expect.any(String));
});
