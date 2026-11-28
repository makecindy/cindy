/**
 * Cloud instances live on their device cards in Settings → Remote connections → My devices,
 * not in a category of their own. This section opens "My devices";
 * `device=<deviceId>` scrolls to one instance.
 */
export const REMOTE_CLOUD_INSTANCES_SECTION = 'remoteControl.cloudInstances';
export const CLOUD_INSTANCES_SETTINGS_PATH = `/settings?${new URLSearchParams({
  tab: 'remote-control',
  section: REMOTE_CLOUD_INSTANCES_SECTION,
})}`;
export const cloudInstanceDevicePath = (deviceId: string) =>
  `/settings?${new URLSearchParams({
    tab: 'remote-control',
    section: REMOTE_CLOUD_INSTANCES_SECTION,
    device: deviceId,
  })}`;
/**
 * Back to My devices from the instance's own settings: the user knows where they came from, so
 * nothing scrolls or flashes. `devices=open` only restores the list they had expanded.
 */
export const remoteControlReturnPath = (devicesOpen: boolean) =>
  `/settings?${new URLSearchParams({
    tab: 'remote-control',
    ...(devicesOpen ? { devices: 'open' } : {}),
  })}`;
