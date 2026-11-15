import { getActiveDataOwnerPushStamp } from '../appSessionState.js';
import { getDeepLinkMainWindow } from '../deepLink.js';
import { APP_SETTINGS_CHANGED } from '../../shared/appPreferenceControl.js';

export function notifyAppSettingsChanged(section: string): void {
  const window = getDeepLinkMainWindow();
  if (!window || window.isDestroyed()) return;
  window.webContents.send(APP_SETTINGS_CHANGED, { section, ownerStamp: getActiveDataOwnerPushStamp() });
}
