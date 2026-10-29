import AsyncStorage from '@react-native-async-storage/async-storage';
import Native from '../../modules/cindy-chat-notifications/src';
const KEY = 'cindy.push.background';
const listeners = new Set<() => void>();
export function isChatBackgroundSupported() { return Native !== null; }
export async function readChatBackgroundEnabled() {
  return !!Native && (await AsyncStorage.getItem(KEY)) === '1' && !(await Native.isPaused());
}
export async function writeChatBackgroundEnabled(enabled: boolean) {
  if (enabled) await Native?.resume();
  else await Native?.stop();
  await AsyncStorage.setItem(KEY, enabled ? '1' : '0');
  for (const listener of listeners) listener();
}
export function subscribeChatBackground(listener: () => void) {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
export { Native as ChatNotificationsNative };
