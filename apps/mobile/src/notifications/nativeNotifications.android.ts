import * as Notifications from 'expo-notifications';
import { setAndroidPushAvailability } from './androidPushAvailability';
import type { NativeNotificationsApi } from './nativeNotifications.types';

// FCM and the independent background connection share the native message-ID store.
const HIGH_IMPORTANCE = Notifications.AndroidImportance.HIGH;
const PRIVATE_VISIBILITY = Notifications.AndroidNotificationVisibility.PRIVATE;

async function prepareChannel() {
  await Promise.all([
    Notifications.setNotificationChannelAsync('chat-messages', {
      name: 'Cindy', importance: HIGH_IMPORTANCE,
      lockscreenVisibility: PRIVATE_VISIBILITY, showBadge: true,
    }),
    Notifications.setNotificationChannelAsync('task-notifications', {
      name: 'Cindy tasks', importance: HIGH_IMPORTANCE,
      lockscreenVisibility: PRIVATE_VISIBILITY, showBadge: true, sound: 'default',
    }),
  ]);
}
// A missing/unreachable Google service must not keep settings and the registration queue waiting.
let tokenRequest: ReturnType<typeof Notifications.getDevicePushTokenAsync> | undefined;
function deviceToken() {
  if (tokenRequest) return tokenRequest;
  tokenRequest = (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await prepareChannel();
      const result = await Promise.race([
        Notifications.getDevicePushTokenAsync(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('GOOGLE_PUSH_TIMEOUT')), 8_000);
        }),
      ]);
      return result;
    } catch (error) {
      setAndroidPushAvailability('unavailable');
      throw error;
    } finally {
      clearTimeout(timer);
      tokenRequest = undefined;
    }
  })();
  return tokenRequest;
}
const nativeNotifications: NativeNotificationsApi = {
  ...Notifications,
  requestPermissionsAsync: async options => {
    await prepareChannel();
    return Notifications.requestPermissionsAsync(options);
  },
  getDevicePushTokenAsync: deviceToken,
};
export default nativeNotifications;
