import type { DeviceInfo, DeviceView } from '@cindy/device-link';
import { TerminalRemoteError } from './types.js';

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max;

/** The REST directory is not a presence push: nullable metadata and ISO time
 * must survive so never-seen/offline devices remain visible to controllers. */
export function readDeviceDirectory(value: unknown): DeviceView[] {
  if (!record(value) || !Array.isArray(value.devices) || value.devices.length > 10_000) {
    throw new TerminalRemoteError('INVALID_RESPONSE', 'Invalid device directory');
  }
  return value.devices.map((device): DeviceView => {
    if (!record(device) || !text(device.deviceId, 128) || typeof device.name !== 'string' || device.name.length > 1024
      || (device.platform !== null && !text(device.platform, 64))
      || (device.appVersion !== null && !text(device.appVersion, 128))
      || typeof device.online !== 'boolean' || typeof device.remoteControlEnabled !== 'boolean'
      || typeof device.busy !== 'boolean' || typeof device.isSelf !== 'boolean'
      || (device.lastSeenAt !== null && (typeof device.lastSeenAt !== 'string'
        || !Number.isFinite(Date.parse(device.lastSeenAt))))) {
      throw new TerminalRemoteError('INVALID_RESPONSE', 'Invalid device directory entry');
    }
    let deviceInfo: DeviceInfo | null | undefined;
    if (device.deviceInfo === null) deviceInfo = null;
    else if (record(device.deviceInfo)) {
      deviceInfo = {};
      for (const key of ['cpuLabel', 'osVersion', 'modelLabel'] as const) {
        if (text(device.deviceInfo[key], 1024)) deviceInfo[key] = device.deviceInfo[key];
      }
      if (typeof device.deviceInfo.memoryGb === 'number' && Number.isFinite(device.deviceInfo.memoryGb)
        && device.deviceInfo.memoryGb >= 0) deviceInfo.memoryGb = device.deviceInfo.memoryGb;
    }
    return {
      deviceId: device.deviceId, name: device.name, platform: device.platform as string | null,
      appVersion: device.appVersion as string | null, online: device.online,
      remoteControlEnabled: device.remoteControlEnabled, busy: device.busy,
      isSelf: device.isSelf, lastSeenAt: device.lastSeenAt as string | null,
      ...(device.selfName === null ? { selfName: null }
        : typeof device.selfName === 'string' ? { selfName: device.selfName.slice(0, 1024) } : {}),
      ...(deviceInfo === undefined ? {} : { deviceInfo }),
    };
  });
}

export function directoryUrl(ws: string): string {
  const url = new URL(ws);
  if (url.username || url.password || !['ws:', 'wss:'].includes(url.protocol)) {
    throw new TerminalRemoteError('INVALID_ENDPOINT', 'Invalid device relay endpoint');
  }
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  if (!url.pathname.endsWith('/ws')) throw new TerminalRemoteError('INVALID_ENDPOINT', 'Device directory endpoint is required');
  url.pathname = `${url.pathname.slice(0, -3)}/devices`;
  url.search = '';
  url.hash = '';
  return url.href;
}
