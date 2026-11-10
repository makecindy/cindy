// Unit: automatic fallback and persisted explicit opt-out were missing from the old switch.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ stored: null as string | null, paused: false, region: 'global', country: 'US', timeZone: 'America/New_York' }));
const native = vi.hoisted(() => ({ stop: vi.fn(), resume: vi.fn(async () => { state.paused = false; }), isPaused: vi.fn(async () => state.paused) }));
const sdk = vi.hoisted(() => ({ getDevicePushTokenAsync: vi.fn() }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
  getItem: async () => state.stored, setItem: async (_key: string, value: string) => { state.stored = value; },
  removeItem: async () => { state.stored = null; },
} }));
vi.mock('expo-localization', () => ({ getLocales: () => [{ regionCode: state.country }], getCalendars: () => [{ timeZone: state.timeZone }] }));
vi.mock('@/config/env', () => ({ getActiveMobileSessionRealm: () => state.region }));
vi.mock('../../modules/cindy-chat-notifications/src', () => ({ default: native }));
vi.mock('expo-notifications', () => ({ ...sdk, setNotificationChannelAsync: vi.fn(),
  AndroidImportance: { HIGH: 4 }, AndroidNotificationVisibility: { PRIVATE: 0 },
}));
import { readChatBackgroundEnabled, readChatBackgroundMode, writeChatBackgroundMode } from '../notifications/chatBackground';
import { readAndroidPushAvailability, setAndroidPushAvailability } from '../notifications/androidPushAvailability';
import notifications from '../notifications/nativeNotifications.android';

beforeEach(() => {
  state.stored = null; state.paused = false; state.region = 'global'; state.country = 'US'; state.timeZone = 'America/New_York';
  vi.clearAllMocks(); setAndroidPushAvailability('unknown');
});
afterEach(() => vi.useRealTimers());

describe('automatic Android notification delivery', () => {
  it('defaults to automatic with direct delivery until Google registration succeeds', async () => {
    expect(await readChatBackgroundMode()).toBe('auto');
    expect(await readChatBackgroundEnabled()).toBe(true);
    sdk.getDevicePushTokenAsync.mockResolvedValue({ type: 'android', data: 'token' });
    await notifications.getDevicePushTokenAsync();
    // A token alone is insufficient; only successful server registration changes the hint.
    expect(readAndroidPushAvailability()).toBe('unknown');
    setAndroidPushAvailability('available');
    expect(await readChatBackgroundEnabled()).toBe(false);
    expect(state.stored).toBeNull();
  });
  it.each([['cn', 'US'], ['global', 'CN']])('keeps direct delivery for mainland use with a cached token (%s/%s)', async (region, country) => {
    state.region = region; state.country = country;
    setAndroidPushAvailability('available');
    expect(await readChatBackgroundEnabled()).toBe(true);
  });
  it('keeps mainland delivery for a Global account on an English-configured phone', async () => {
    state.timeZone = 'Asia/Shanghai'; setAndroidPushAvailability('available');
    expect(await readChatBackgroundEnabled()).toBe(true);
  });
  it('preserves old explicit choices and notification-bar stop across automatic reevaluation', async () => {
    state.stored = '0'; expect(await readChatBackgroundEnabled()).toBe(false);
    state.stored = '1'; setAndroidPushAvailability('available'); expect(await readChatBackgroundEnabled()).toBe(true);
    state.paused = true; expect(await readChatBackgroundMode()).toBe('off'); expect(await readChatBackgroundEnabled()).toBe(false);
    await writeChatBackgroundMode('auto');
    expect(state.stored).toBeNull(); expect(state.paused).toBe(false);
    expect(await readChatBackgroundMode()).toBe('auto');
    await writeChatBackgroundMode('off'); expect(state.stored).toBe('0'); expect(native.stop).toHaveBeenCalledOnce();
  });
  it('bounds an unreachable Google request and allows a subsequent retry', async () => {
    vi.useFakeTimers();
    sdk.getDevicePushTokenAsync.mockReturnValueOnce(new Promise(() => {}));
    const first = notifications.getDevicePushTokenAsync();
    const second = notifications.getDevicePushTokenAsync();
    const results = Promise.allSettled([first, second]);
    await vi.advanceTimersByTimeAsync(8000);
    expect((await results).map(row => row.status)).toEqual(['rejected', 'rejected']);
    expect(sdk.getDevicePushTokenAsync).toHaveBeenCalledOnce();
    expect(readAndroidPushAvailability()).toBe('unavailable');
    expect(await readChatBackgroundEnabled()).toBe(true);
    sdk.getDevicePushTokenAsync.mockResolvedValueOnce({ type: 'android', data: 'new-token' });
    await notifications.getDevicePushTokenAsync();
    expect(readAndroidPushAvailability()).toBe('unavailable');
  });
});
