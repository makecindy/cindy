import { Alert } from 'react-native';
import type { TFunction } from 'i18next';

/**
 * Every sign-out entry (settings, home drawer, partner home and drawer) asks
 * first: signing out clears this phone's saved accounts and local mirror, and
 * running tasks stop reporting here. Switching accounts already warns; the
 * heavier action must not be quieter.
 */
export function confirmLogout(t: TFunction, hasRunningTasks: boolean, onConfirm: () => void): void {
  Alert.alert(
    t('settings.account.logoutConfirmTitle'),
    hasRunningTasks ? t('settings.account.logoutConfirmRunning') : t('settings.account.logoutHint'),
    [
      { text: t('devices.common.cancel'), style: 'cancel' },
      { text: t('settings.account.logout'), style: 'destructive', onPress: onConfirm },
    ],
  );
}
