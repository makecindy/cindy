import { navigateRemoteSettings, settingsNavigationRoute, type SettingsNavigationTarget } from '@cindy/maker-shared/settings-navigation';
import { deviceDisplayName } from './deviceName';

export async function openSettingsNavigation(target: SettingsNavigationTarget, navigate: (route: string) => void): Promise<void> {
  const self = await window.electronAPI.getDeviceId();
  if (self === target.deviceId) { navigate(settingsNavigationRoute(target)); return; }
  await navigateRemoteSettings(target, window.electronAPI.deviceLink.invoke,
    () => window.electronAPI.openRemoteDesktop({ deviceId: target.deviceId, name: deviceDisplayName(target.deviceId) }));
}
