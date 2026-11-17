import { ipcMain } from 'electron';
import { parseSettingsNavigationTarget, SETTINGS_NAVIGATE_CHANNEL } from '@cindy/maker-shared/settings-navigation';
import { getDeviceId } from './authManager';
import { openMainWindowSettingsNavigation } from './deepLink';
import { getDeviceLinkInvokeContext } from './device-link/invoke-context';
import { throwIpcError } from './utils/ipcValidate';

export function registerSettingsNavigationIpc(): void {
  ipcMain.handle(SETTINGS_NAVIGATE_CHANNEL, (_event, raw: unknown) => {
    const context = getDeviceLinkInvokeContext();
    if (!context || context.channel !== SETTINGS_NAVIGATE_CHANNEL) throwIpcError('PERMISSION_DENIED', 'Remote navigation requires device-link');
    const target = parseSettingsNavigationTarget(raw);
    if (!target || target.deviceId !== getDeviceId()) throwIpcError('INVALID_PARAMS', 'Settings target does not match this computer');
    openMainWindowSettingsNavigation(target);
    return { ok: true, deviceId: target.deviceId };
  });
}
