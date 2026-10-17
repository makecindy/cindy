import type { SwitcherDevice } from '../../device-link/switcherDevices';

/** 分组与设备切换栏共用设备集合；断线只改变在线标记，不移除保留的设备。 */
export function buildSidebarDeviceIndex(
  devices: readonly SwitcherDevice[],
): Map<string, { name: string; online: boolean }> {
  const index = new Map<string, { name: string; online: boolean }>();
  for (const device of devices) {
    if (device.status === 'rejected') continue;
    index.set(device.deviceId, {
      name: device.name,
      online: device.status === 'connected',
    });
  }
  return index;
}
