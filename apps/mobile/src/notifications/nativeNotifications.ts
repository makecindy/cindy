import * as Notifications from 'expo-notifications';

import type { NativeNotificationsApi } from './nativeNotifications.types';

/** SDK boundary; Android also prepares its notification channel. */
const nativeNotifications: NativeNotificationsApi = Notifications;

export default nativeNotifications;
