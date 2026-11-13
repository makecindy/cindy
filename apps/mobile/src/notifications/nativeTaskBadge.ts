import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';
import Notifications from './nativeNotifications';
import { queueNotificationBadgeUpdate } from './notificationBadge';
import type { TaskBadgeSnapshot } from './taskBadgeSync';

const native = Platform.OS === 'android' ? requireOptionalNativeModule<{
  setTaskBadgeIdentity?(scope: string, accountId: string): Promise<void>;
  applyTaskBadge?(summary: string): Promise<boolean>;
}>('CindyChatNotifications') : null;

export function supportsTaskBadgePush(): boolean {
  return Platform.OS === 'ios' || (typeof native?.setTaskBadgeIdentity === 'function' && typeof native?.applyTaskBadge === 'function');
}

export async function setTaskBadgeIdentity(scope: string, accountId: string): Promise<void> {
  await queueNotificationBadgeUpdate(async () => { await native?.setTaskBadgeIdentity?.(scope, accountId); });
}

export async function applyTaskBadge(snapshot: TaskBadgeSnapshot): Promise<unknown> {
  if (native?.applyTaskBadge) return native.applyTaskBadge(JSON.stringify(snapshot));
  // Older Android binaries can only repair in the foreground; new FCM delivery
  // requires the native receiver and therefore a new installation package.
  if (snapshot.complete) return Notifications.setBadgeCountAsync(snapshot.badgeCount);
}
