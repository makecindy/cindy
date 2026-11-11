// @vitest-environment jsdom
// Unit/hook: task delivery must not depend on Chat Server availability; stale async work cannot
// restart delivery after sign-out. The old bridge only configured a chat socket and had no task path.
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ current: true, enabled: true, permission: 'granted', background: true,
  me: vi.fn(), token: vi.fn(async () => 'token'), signedOut: undefined as undefined | ((out?: boolean) => void) }));
const native = vi.hoisted(() => ({ stop: vi.fn(), setOwner: vi.fn(), setIdentity: vi.fn(), setTaskIdentity: vi.fn(), setPreview: vi.fn(),
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
  native.configureNotifications.mockReset();
  state.me.mockResolvedValue('actor');
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('background notification lifecycle', () => {
  // Unit regression r4512690973: a cold native service can only start while the
  // Activity has focus. /me still pending when Home is pressed must not delay tasks.
  // Earlier deadline tests only checked configuration after 8s, missing first startup.
  it('starts tasks before a pending chat lookup, then adds chat after the Activity loses focus', async () => {
    vi.useFakeTimers();
    let resolve!: (actor: string) => void;
    let focused = true; let running = false;
    state.me.mockReturnValue(new Promise<string>(done => { resolve = done; }));
    native.configureNotifications.mockImplementation(async () => {
      if (!running && !focused) throw new Error('CHAT_OPEN_APP_REQUIRED');
      running = true;
    });
    renderHook(() => ChatBackgroundBridge());
    await act(async () => {});
    expect(native.configureNotifications).toHaveBeenCalledWith(expect.objectContaining({ actor: '', taskBase: 'https://relay.example' }));
    expect(running).toBe(true);
    focused = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); resolve('actor'); });
    expect(native.configureNotifications).toHaveBeenLastCalledWith(expect.objectContaining({ actor: 'actor', chatBase: 'https://chat.example' }));
    expect(running).toBe(true);
  });
  // Unit regression for PR #9349 / r4512525743: the production hook must bind the
  // native FCM recipient when /me resolves at 9s, beyond the chat lookup's 8s deadline.
  // Existing cases only covered immediate success/failure and sign-out before timeout.
  // Standalone file wall time: 1.42s; fake timers cover the 8s/9s boundary without real waits.
  it.each([true, false])('binds a late chat identity without delaying tasks or enabling a disabled service (background=%s)', async background => {
    vi.useFakeTimers();
    state.background = background;
    let resolve!: (actor: string) => void;
    state.me.mockReturnValue(new Promise<string>(done => { resolve = done; }));
    renderHook(() => ChatBackgroundBridge());
    await act(async () => {});
    await act(async () => { await vi.advanceTimersByTimeAsync(8_000); });
    if (background) expect(native.configureNotifications).toHaveBeenCalledWith(expect.objectContaining({ actor: '', taskBase: 'https://relay.example' }));
    else expect(native.stop).toHaveBeenCalled();
    native.configureNotifications.mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); resolve('late-actor'); });
    expect(native.setIdentity).toHaveBeenCalledWith('late-actor');
    if (background) expect(native.configureNotifications).toHaveBeenLastCalledWith(expect.objectContaining({ actor: 'late-actor', chatBase: 'https://chat.example' }));
    else expect(native.configureNotifications).not.toHaveBeenCalled();
    expect(state.me).toHaveBeenCalledTimes(1);
  });
  it.each(['sign-out', 'disabled', 'permission', 'unmounted', 'new-refresh'])('ignores a late chat identity after %s', async change => {
    vi.useFakeTimers(); state.background = false;
    let resolve!: (actor: string) => void;
    state.me.mockReturnValueOnce(new Promise<string>(done => { resolve = done; }));
    const hook = renderHook(() => ChatBackgroundBridge());
    await act(async () => {});
    await act(async () => { await vi.advanceTimersByTimeAsync(8_000); });
    await act(async () => {
      if (change === 'sign-out') { state.current = false; state.signedOut?.(true); }
      else if (change === 'disabled') { state.enabled = false; state.signedOut?.(); }
      else if (change === 'permission') state.permission = 'denied';
      else if (change === 'unmounted') hook.unmount();
      else state.signedOut?.();
    });
    await act(async () => { resolve('stale-actor'); });
    expect(native.setIdentity).not.toHaveBeenCalledWith('stale-actor');
    expect(native.configureNotifications).not.toHaveBeenCalled();
    if (change === 'new-refresh') expect(native.setIdentity).toHaveBeenLastCalledWith('actor');
  });
  it('starts task delivery even when chat is unavailable, with the correct account and preview preference', async () => {
    state.me.mockRejectedValue(new Error('chat offline'));
    renderHook(() => ChatBackgroundBridge());
    await waitFor(() => expect(native.configureNotifications).toHaveBeenCalledWith({ owner: api.owner,
      actor: '', chatBase: '', user: api.userId, taskBase: 'https://relay.example', token: 'token',
      title: 'settings.notifications.backgroundActive', stopLabel: 'settings.notifications.backgroundStop', preview: false, language: 'en' }));
    expect(native.setOwner).toHaveBeenCalledWith('owner:cn');
    expect(native.setIdentity).not.toHaveBeenCalledWith('');
  });
  // Regression: same-account chat lookup errors must not erase the FCM recipient
  // identity or the known direct-chat config while task delivery is refreshed.
  it.each([true, false])('preserves same-account chat identity on refresh failure with background=%s', async background => {
    state.background = background;
    renderHook(() => ChatBackgroundBridge());
    await waitFor(() => expect(native.setIdentity).toHaveBeenCalledWith('actor'));
    state.me.mockRejectedValue(new Error('temporary chat failure'));
    native.setIdentity.mockClear(); native.configureNotifications.mockClear();
    await act(async () => { state.signedOut?.(); });
    await waitFor(() => expect(state.me).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(native.setIdentity).toHaveBeenCalledWith('actor'));
    expect(native.setIdentity).not.toHaveBeenCalledWith('');
    if (background) expect(native.configureNotifications).toHaveBeenCalledWith(expect.objectContaining({ actor: 'actor', chatBase: 'https://chat.example' }));
    else expect(native.configureNotifications).not.toHaveBeenCalled();
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
    // Task delivery may already be running; sign-out must prevent any later restart.
    native.configureNotifications.mockClear();
    await act(async () => { state.current = false; state.signedOut?.(true); resolve('old-actor'); });
    expect(native.stop).toHaveBeenCalled();
    expect(native.configureNotifications).not.toHaveBeenCalled();
    expect(native.setIdentity).not.toHaveBeenCalledWith('old-actor');
  });
});
