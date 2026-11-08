// @vitest-environment jsdom
// Unit/hook: task delivery must not depend on Chat Server availability; stale async work cannot
// restart delivery after sign-out. The old bridge only configured a chat socket and had no task path.
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ current: true, enabled: true, permission: 'granted', background: true,
  me: vi.fn(), token: vi.fn(async () => 'token'), signedOut: undefined as undefined | ((out?: boolean) => void) }));
const native = vi.hoisted(() => ({ stop: vi.fn(), setIdentity: vi.fn(), setTaskIdentity: vi.fn(), setPreview: vi.fn(),
  configureNotifications: vi.fn(), configure: vi.fn(), addListener: vi.fn(() => ({ remove: vi.fn() })) }));
const api = vi.hoisted(() => ({ enabled: true, owner: 'owner:1:cn', userId: 'owner', realm: 'cn',
  current: () => state.current, client: { me: () => state.me() }, endpoint: async () => 'https://chat.example' }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ getAccessToken: state.token }) }));
vi.mock('@/config/env', () => ({ getMobileEndpointForRealm: () => 'https://relay.example' }));
vi.mock('@/device-link/selfHostedRelay', () => ({ useSelfHostedRelay: () => null }));
vi.mock('@/chat/useChatServer', () => ({ useChatClient: () => api }));
vi.mock('react-i18next', () => { const t = (key: string) => key; return { useTranslation: () => ({ t, i18n: { language: 'en' } }) }; });
vi.mock('react-native', () => ({ AppState: { addEventListener: () => ({ remove() {} }) } }));
vi.mock('../notifications/nativeNotifications', () => ({ default: { getPermissionsAsync: async () => ({ status: state.permission }) } }));
vi.mock('../notifications/chatBackground', () => ({ ChatNotificationsNative: native,
  readChatBackgroundEnabled: async () => state.background, subscribeChatBackground: () => () => {} }));
vi.mock('../notifications/pushNotifications', () => ({ readPushEnabled: async () => state.enabled,
  readPushPreviewEnabled: async () => false,
  subscribePushPreferences: (listener: (out?: boolean) => void) => { state.signedOut = listener; return () => {}; } }));
import { ChatBackgroundBridge } from '../notifications/ChatBackgroundBridge';

beforeEach(() => {
  vi.clearAllMocks(); state.current = true; state.enabled = true; state.permission = 'granted'; state.background = true;
  state.me.mockResolvedValue('actor');
});
afterEach(cleanup);

describe('background notification lifecycle', () => {
  it('starts task delivery even when chat is unavailable, with the correct account and preview preference', async () => {
    state.me.mockRejectedValue(new Error('chat offline'));
    renderHook(() => ChatBackgroundBridge());
    await waitFor(() => expect(native.configureNotifications).toHaveBeenCalledWith({ owner: api.owner,
      actor: '', chatBase: '', user: api.userId, taskBase: 'https://relay.example', token: 'token',
      title: 'settings.notifications.backgroundActive', stopLabel: 'settings.notifications.backgroundStop', preview: false, language: 'en' }));
  });
  it.each(['denied', 'off'])('stops and never starts a service when notification permission/preference is %s', async condition => {
    if (condition === 'denied') state.permission = 'denied'; else state.enabled = false;
    renderHook(() => ChatBackgroundBridge());
    await waitFor(() => expect(native.stop).toHaveBeenCalled());
    expect(native.configureNotifications).not.toHaveBeenCalled();
  });
  it('does not restart with a late account response after sign-out', async () => {
    let resolve!: (actor: string) => void;
    state.me.mockReturnValue(new Promise<string>(done => { resolve = done; }));
    renderHook(() => ChatBackgroundBridge());
    await waitFor(() => expect(state.me).toHaveBeenCalled());
    await act(async () => { state.current = false; state.signedOut?.(true); resolve('old-actor'); });
    expect(native.stop).toHaveBeenCalled();
    expect(native.configureNotifications).not.toHaveBeenCalled();
    expect(native.setIdentity).not.toHaveBeenCalledWith('old-actor');
  });
});
