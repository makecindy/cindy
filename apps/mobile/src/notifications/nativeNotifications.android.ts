import * as Notifications from 'expo-notifications';
import type { NativeNotificationsApi } from './nativeNotifications.types';

// FCM and the independent background connection share the native message-ID store.
async function prepareChannel() {
  await Notifications.setNotificationChannelAsync('chat-messages', {
    name: 'Cindy', importance: Notifications.AndroidImportance.HIGH,
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
  });
}
const nativeNotifications: NativeNotificationsApi = {
  ...Notifications,
  requestPermissionsAsync: async options => {
    await prepareChannel();
    return Notifications.requestPermissionsAsync(options);
  },
  getDevicePushTokenAsync: async () => {
    await prepareChannel();
    return Notifications.getDevicePushTokenAsync();
  },
};
export default nativeNotifications;
