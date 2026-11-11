import AsyncStorage from '@react-native-async-storage/async-storage';
import { getCalendars, getLocales } from 'expo-localization';
import { getActiveMobileSessionRealm } from '@/config/env';
import { readAndroidPushAvailability } from './androidPushAvailability';
import Native from '../../modules/cindy-chat-notifications/src';
const KEY = 'cindy.push.background';
const listeners = new Set<() => void>();
export const CHAT_BACKGROUND_MODES = ['auto', 'on', 'off'] as const;
export type ChatBackgroundMode = typeof CHAT_BACKGROUND_MODES[number];
export function isChatBackgroundSupported() { return Native !== null; }
export async function readChatBackgroundMode(): Promise<ChatBackgroundMode> {
  // The old switch only wrote explicit choices: preserve both on and off on upgrade.
  if (await Native?.isPaused()) return 'off';
  const stored = await AsyncStorage.getItem(KEY);
  return stored === '1' ? 'on' : stored === '0' ? 'off' : 'auto';
}
export async function readChatBackgroundEnabled() {
  if (!Native) return false;
  const mode = await readChatBackgroundMode();
  if (mode !== 'auto') return mode === 'on';
  // Mainland accounts and devices keep the direct channel even if a cached FCM token exists.
  // Language alone is not a location signal; no location permission or network probe is needed.
  return getActiveMobileSessionRealm() === 'cn'
    || getLocales().some(locale => locale.regionCode === 'CN')
    || getCalendars().some(calendar => calendar.timeZone === 'Asia/Shanghai' || calendar.timeZone === 'Asia/Chongqing')
    || readAndroidPushAvailability() !== 'available';
}
export async function writeChatBackgroundMode(mode: ChatBackgroundMode) {
  if (mode === 'off') await Native?.stop();
  if (mode === 'auto') await AsyncStorage.removeItem(KEY);
  else await AsyncStorage.setItem(KEY, mode === 'on' ? '1' : '0');
  if (mode !== 'off') await Native?.resume();
  for (const listener of listeners) listener();
}
export function subscribeChatBackground(listener: () => void) {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
export { Native as ChatNotificationsNative };
