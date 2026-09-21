import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  platform: 'ios',
  appId: 'wx-test-mobile',
  universalLink: 'https://login.example.com/wechat/',
  appState: 'active',
  listeners: new Set<(state: string) => void>(),
  installed: vi.fn(),
  request: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock('expo-crypto', () => ({}));
vi.mock('@/auth/pkce', () => ({ createState: () => 'test-random-wechat-state' }));
vi.mock('@/config/env', () => ({
  GOOGLE_IOS_CLIENT_ID: '',
  GOOGLE_IOS_URL_SCHEME: '',
  GOOGLE_WEB_CLIENT_ID: '',
  get WECHAT_APP_ID() { return native.appId; },
  get WECHAT_UNIVERSAL_LINK() { return native.universalLink; },
}));
vi.mock('react-native', () => ({
  Platform: { get OS() { return native.platform; } },
  AppState: {
    get currentState() { return native.appState; },
    addEventListener: (_name: string, listener: (state: string) => void) => {
      native.listeners.add(listener);
      return { remove: () => native.listeners.delete(listener) };
    },
  },
}));
vi.mock('xdt-wechat-login', () => ({
  isWechatInstalled: native.installed,
  requestWechatAuthCode: native.request,
  cancelWechatAuthRequest: native.cancel,
}));

import { acquireNativeSocialCredential, isNativeSocialProviderSupported } from '../nativeSocial';

function changeAppState(state: string) {
  native.appState = state;
  for (const listener of native.listeners) listener(state);
}

beforeEach(() => {
  vi.useFakeTimers();
  native.platform = 'ios';
  native.appState = 'active';
  native.appId = 'wx-test-mobile';
  native.universalLink = 'https://login.example.com/wechat/';
  native.installed.mockReset().mockResolvedValue(true);
  native.request.mockReset().mockResolvedValue({ code: 'test-wechat-code' });
  native.cancel.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  expect(native.listeners.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

describe('native WeChat credential acquisition', () => {
  it.each(['ios', 'android'])('acquires only an authorization code on %s', async (platform) => {
    native.platform = platform;
    expect(isNativeSocialProviderSupported('wechat')).toBe(true);
    await expect(acquireNativeSocialCredential('wechat')).resolves.toEqual({ code: 'test-wechat-code' });
    expect(native.request).toHaveBeenCalledWith({
      appId: 'wx-test-mobile',
      universalLink: 'https://login.example.com/wechat/',
      scope: 'snsapi_userinfo',
      state: 'test-random-wechat-state',
    });
    expect(native.cancel).not.toHaveBeenCalled();
  });

  it('does not launch WeChat when public configuration is missing', async () => {
    native.appId = '';
    expect(isNativeSocialProviderSupported('wechat')).toBe(false);
    await expect(acquireNativeSocialCredential('wechat')).rejects.toMatchObject({
      code: 'SOCIAL_PROVIDER_NOT_CONFIGURED',
    });
    expect(native.installed).not.toHaveBeenCalled();
    expect(native.request).not.toHaveBeenCalled();
  });

  it('reports WeChat as unavailable when it is not installed', async () => {
    native.installed.mockResolvedValue(false);
    await expect(acquireNativeSocialCredential('wechat')).rejects.toMatchObject({
      code: 'SOCIAL_PROVIDER_UNAVAILABLE',
    });
    expect(native.request).not.toHaveBeenCalled();
  });

  it('cleans up after cancellation and permits a new request', async () => {
    native.request.mockRejectedValueOnce(Object.assign(new Error('cancelled'), { code: 'ERR_WECHAT_CANCELLED' }));
    await expect(acquireNativeSocialCredential('wechat')).rejects.toMatchObject({ code: 'ERR_WECHAT_CANCELLED' });
    await expect(acquireNativeSocialCredential('wechat')).resolves.toEqual({ code: 'test-wechat-code' });
  });

  it('does not time out while the user authorizes in WeChat', async () => {
    let complete!: (result: { code: string }) => void;
    native.request.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    const result = acquireNativeSocialCredential('wechat');
    await vi.advanceTimersByTimeAsync(2_000);
    changeAppState('background');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(native.cancel).not.toHaveBeenCalled();
    changeAppState('active');
    complete({ code: 'test-delayed-wechat-code' });
    await expect(result).resolves.toEqual({ code: 'test-delayed-wechat-code' });
  });

  it('releases a timed-out native request before retrying', async () => {
    native.request.mockImplementationOnce(() => new Promise(() => undefined));
    const result = expect(acquireNativeSocialCredential('wechat')).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(8_000);
    await result;
    expect(native.cancel).toHaveBeenCalledOnce();
    await expect(acquireNativeSocialCredential('wechat')).resolves.toEqual({ code: 'test-wechat-code' });
  });
});
