import { app } from 'electron';
import { createLogger } from '../logger';
import { createDeviceLinkSettings } from '@cindy/app-runtime/deviceLinkSettings';
export { normalizeCachedDeviceName, isPlaceholderDeviceName } from '@cindy/app-runtime/deviceLinkSettings';
export type { DeviceLinkSettings } from '@cindy/app-runtime/deviceLinkSettings';

export const {
  readDeviceLinkSettings,
  updateDeviceLinkSetting,
  writeDeviceLinkSetting,
  readLastKnownDeviceNames,
  writeLastKnownDeviceNames,
  setDeviceControlEnabled,
  rememberLastKnownDeviceName,
  forgetLastKnownDeviceName,
  __testing,
} = createDeviceLinkSettings({ userDataDirectory: () => app.getPath('userData'), logger: createLogger('device-link-settings') });
