import type { DeviceView } from '@cindy/device-link';

import { isDesktopSchedulerPlatform } from './state';

export interface SchedulerDesktopDeviceSnapshot {
  /** Presence of this row is the completion barrier for an authoritative view. */
  selfDeviceId: string;
  peers: Array<{ deviceId: string; platform: string }>;
  observedAt: number;
}

/**
 * Project the server's full Device Link view into the scheduler's small,
 * desktop-only snapshot. No network request belongs here; PR-B supplies the
 * existing Device Link REST adapter.
 */
export function buildSchedulerDesktopDeviceSnapshot(
  devices: readonly Pick<DeviceView, 'deviceId' | 'platform' | 'online' | 'isSelf'>[],
  observedAt = Date.now(),
): SchedulerDesktopDeviceSnapshot | null {
  const self = devices.find(
    (device) => device.isSelf && device.online && isDesktopSchedulerPlatform(device.platform),
  );
  if (!self) return null;

  return {
    selfDeviceId: self.deviceId,
    peers: devices
      .flatMap((device) => {
        if (device.isSelf || !device.online || !isDesktopSchedulerPlatform(device.platform))
          return [];
        return [{ deviceId: device.deviceId, platform: device.platform }];
      })
      .sort((left, right) => left.deviceId.localeCompare(right.deviceId)),
    observedAt,
  };
}
