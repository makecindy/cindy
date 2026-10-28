// @vitest-environment jsdom
// Production bridge -> native service boundary. bot-group-chat.md §10 requires
// notification permission before starting the opt-in, Google-independent socket.
// No existing test mounts this bridge. Minimal regressions: saved opt-in with
// denied permission, or switching it off while token acquisition is pending.
// Unit tier: native IO/auth are controlled; no network, real timers or credentials.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  enabled: true, background: true, preview: true, permission: 'granted', current: true,
  preferences: new Set<(signedOut?: boolean) => void>(),
  foreground: new Set<(state: string) => void>(),
  focus: new Set<() => void>(),
  refresh: new Set<() => void>(),
  token: vi.fn(), me: vi.fn(), configure: vi.fn(), stop: vi.fn(),
  setIdentity: vi.fn(), setPreview: vi.fn(),
}));
vi.mock('react-native', () => ({ AppState: {
  addEventListener: (event: string, listener: any) => {
    if (event === 'focus') {
      h.focus.add(listener); return { remove() { h.focus.delete(listener); } };
    }
    h.foreground.add(listener); return { remove() { h.foreground.delete(listener); } };
  },
} }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({
  t: translate, i18n: { language: 'zh-CN' },
}) }));
function translate(key: string) { return key; }
vi.mock('@/chat/useChatServer', () => ({ useChatClient: () => api }));
const api = { enabled: true, owner: 'fixture-owner', current: () => h.current,
  client: { me: h.me }, token: h.token, endpoint: async () => 'https://chat.example.invalid' };
vi.mock('@/notifications/nativeNotifications', () => ({ default: {
  getPermissionsAsync: async () => ({ status: h.permission }),
} }));
vi.mock('@/notifications/chatBackground', () => ({
  ChatNotificationsNative: {
    configure: h.configure, stop: h.stop, setIdentity: h.setIdentity, setPreview: h.setPreview,
    addListener: (_: string, listener: () => void) => {
      h.refresh.add(listener); return { remove() { h.refresh.delete(listener); } };
    },
  },
  readChatBackgroundEnabled: async () => h.background,
  subscribeChatBackground: (listener: () => void) => {
    h.preferences.add(listener); return () => h.preferences.delete(listener);
  },
}));
vi.mock('@/notifications/pushNotifications', () => ({
  readPushEnabled: async () => h.enabled,
  readPushPreviewEnabled: async () => h.preview,
  subscribePushPreferences: (listener: (signedOut?: boolean) => void) => {
    h.preferences.add(listener); return () => h.preferences.delete(listener);
  },
}));
vi.mock('../../modules/cindy-chat-notifications/src', () => ({ default: null }));
import { readChatNotificationDiagnostics } from '@/notifications/chatNotificationDiagnostics';
import { ChatBackgroundBridge } from '@/notifications/ChatBackgroundBridge';

let root: Root;
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
beforeEach(() => {
  vi.clearAllMocks(); h.enabled = h.background = h.preview = h.current = true;
  h.permission = 'granted'; api.enabled = true;
  h.token.mockResolvedValue('fixture-access-token'); h.me.mockResolvedValue('fixture-actor');
  root = createRoot(document.createElement('div'));
});
afterEach(async () => { await act(async () => root.unmount()); });
async function mount() { await act(async () => { root.render(createElement(ChatBackgroundBridge)); }); }
async function notify() { await act(async () => { for (const listener of h.preferences) listener(); }); }

it('starts the opted-in chat connection without obtaining a Google push token and honors preview privacy', async () => {
  h.preview = false;
  await mount();
  expect(h.configure).toHaveBeenCalledWith('fixture-owner', 'fixture-actor', 'https://chat.example.invalid',
    'fixture-access-token', 'settings.notifications.backgroundActive', 'settings.notifications.backgroundStop', false, 'zh-CN');
  expect(h.setPreview).toHaveBeenCalledWith(false);
});

it('does not start a saved background opt-in when system notification permission is denied', async () => {
  h.permission = 'denied';
  await mount();
  expect(h.configure).not.toHaveBeenCalled();
  expect(h.stop).toHaveBeenCalled();
  expect(h.token).not.toHaveBeenCalled();
  expect(await readChatNotificationDiagnostics()).toEqual({ stage: 'permission-denied' });
});

it('stops an existing connection after notification permission is revoked on return to the app', async () => {
  await mount(); h.stop.mockClear(); h.configure.mockClear(); h.permission = 'denied';
  await act(async () => { for (const listener of h.foreground) listener('active'); });
  expect(h.stop).toHaveBeenCalled();
  expect(h.configure).not.toHaveBeenCalled();
});

it('retries service startup when the Android window gains focus after becoming active', async () => {
  h.configure.mockRejectedValueOnce(new Error('CHAT_OPEN_APP_REQUIRED'));
  await mount();
  h.configure.mockClear();
  await act(async () => { for (const listener of h.focus) listener(); });
  expect(h.configure).toHaveBeenCalledOnce();
});

it('does not restart the connection after opt-out during token acquisition', async () => {
  let release!: (token: string) => void;
  h.token.mockImplementationOnce(() => new Promise<string>(resolve => { release = resolve; }));
  await mount(); expect(h.token).toHaveBeenCalled();
  h.background = false; await notify();
  await act(async () => release('fixture-access-token'));
  expect(h.configure).not.toHaveBeenCalled();
  expect(h.stop).toHaveBeenCalled();
});

it('drops a late token after logout and removes lifecycle listeners', async () => {
  let release!: (token: string) => void;
  h.token.mockImplementationOnce(() => new Promise<string>(resolve => { release = resolve; }));
  await mount();
  await act(async () => { for (const listener of h.preferences) listener(true); });
  await act(async () => release('fixture-access-token'));
  expect(h.configure).not.toHaveBeenCalled();
  expect(h.setIdentity).toHaveBeenLastCalledWith('');
  await act(async () => root.unmount());
  expect(h.foreground.size + h.focus.size + h.preferences.size + h.refresh.size).toBe(0);
});

// Unit: swallowed auth failures must be distinguishable from a started socket,
// without exporting error bodies, tokens or account IDs. Existing tests only
// observed successful native calls. Minimal failure: /me rejects.
it('reports the failing gate without exporting an authentication exception', async () => {
  h.me.mockRejectedValueOnce(new Error('Bearer private-secret'));
  await mount();
  expect(h.configure).not.toHaveBeenCalled();
  expect(await readChatNotificationDiagnostics()).toEqual({ stage: 'failed', failedAt: 'identity' });
});
