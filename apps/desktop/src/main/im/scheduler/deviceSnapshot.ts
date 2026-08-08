import type { DeviceView } from '@cindy/device-link';

import { getClientEndpoint } from '../../clientEndpointsService';
import { serverApiFetch } from '../../serverApiClient';
import { isDesktopSchedulerPlatform } from './state';

const DEVICE_SNAPSHOT_TIMEOUT_MS = 5_000;

export interface SchedulerDesktopDeviceSnapshot {
  selfDeviceId: string;
  peers: Array<{ deviceId: string; platform: string }>;
}

/**
 * Fetch the relay's full account device view. Unlike WebSocket presence, this
 * response is a completion barrier: the scheduler must see its own online row
 * before treating the returned online Desktop set as authoritative.
 */
export async function fetchSchedulerDesktopDeviceSnapshot(): Promise<SchedulerDesktopDeviceSnapshot> {
  const result = await serverApiFetch<{ devices: DeviceView[] }>('/api/device-link/devices', {
    baseUrl: () => getClientEndpoint('deviceLinkApiBaseUrl'),
    cache: 'no-store',
    timeoutMs: DEVICE_SNAPSHOT_TIMEOUT_MS,
    logLabel: '/api/device-link/devices',
  });
  const self = result.devices.find(
    (device) => device.isSelf && device.online && isDesktopSchedulerPlatform(device.platform),
  );
  if (!self) throw new Error('device-link snapshot is missing the online self Desktop');

  return {
    selfDeviceId: self.deviceId,
    peers: result.devices.flatMap((device) => {
      if (
        device.isSelf
        || !device.online
        || !isDesktopSchedulerPlatform(device.platform)
      ) return [];
      return [{ deviceId: device.deviceId, platform: device.platform }];
    }),
  };
}
