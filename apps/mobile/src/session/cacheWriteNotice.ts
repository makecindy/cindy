import { Alert, AppState } from 'react-native';
import i18n from '@/i18n';

let scheduled = false;

/** One notice per app run, deferred until foreground; streaming must not spam alerts. */
export function notifyCacheWriteFailure(): void {
  if (scheduled) return;
  scheduled = true;
  const show = () => Alert.alert(
    i18n.t('devices.list.alert.cacheSaveFailed'),
    i18n.t('devices.list.alert.cacheSaveFailedDetail'),
  );
  if (AppState.currentState === 'active') { show(); return; }
  const subscription = AppState.addEventListener('change', state => {
    if (state !== 'active') return;
    subscription.remove();
    show();
  });
}
