import { isSupportedControllerPlatform } from './controllerPlatform.js';

export interface ControllerPresenceFreshnessTracker {
  epoch: number;
  epochByDevice: Map<string, number>;
}

export interface ControllerPresenceDirectoryDevice {
  deviceId?: unknown;
  name?: unknown;
  selfName?: unknown;
  online?: unknown;
  platform?: unknown;
  isSelf?: unknown;
}

export function createControllerPresenceFreshnessTracker(): ControllerPresenceFreshnessTracker {
  return {
    epoch: 0,
    epochByDevice: new Map(),
  };
}

/** 任何实时 presence 都比它发起前的 REST 目录请求更新。 */
export function markControllerPresenceFresh(
  tracker: ControllerPresenceFreshnessTracker,
  deviceId: string,
): void {
  tracker.epoch += 1;
  tracker.epochByDevice.set(deviceId, tracker.epoch);
}

/** relay 连接代切换后，旧连接上的 presence 不能压住新目录快照。 */
export function resetControllerPresenceFreshness(
  tracker: ControllerPresenceFreshnessTracker,
): void {
  tracker.epoch += 1;
  tracker.epochByDevice.clear();
}

function presenceChangedAfterRequest(
  tracker: ControllerPresenceFreshnessTracker,
  deviceId: string,
  requestEpoch: number,
): boolean {
  return (tracker.epochByDevice.get(deviceId) ?? 0) > requestEpoch;
}

function hasRealtimePresence(
  tracker: ControllerPresenceFreshnessTracker,
  deviceId: string,
): boolean {
  return tracker.epochByDevice.has(deviceId);
}

function normalizeDirectoryName(device: ControllerPresenceDirectoryDevice): string | null {
  for (const value of [device.selfName, device.name]) {
    if (typeof value !== 'string') continue;
    const normalized = value.trim();
    if (normalized) return normalized;
  }
  return null;
}

/**
 * presence 是增量流，新连接不会收到已经在线设备的历史状态。实时 presence 到达前，
 * 设备目录持续维护当前快照；一旦当前连接代见过该设备的实时 presence，目录无论返回
 * 在线还是离线都不再覆盖状态与平台，避免滞后的 REST 快照双向误翻转。设备名仍可由
 * 目录独立更新。
 *
 * 首次看到的在线设备若缺少客户端支持的平台值，保持为「在线状态未知」，让后续真实
 * presence 仍会形成上线边沿；后续不完整目录则保留已经建立的可信在线状态，直到目录
 * 明确报告离线，避免旧版目录记录中断词典同步。
 */
export function applyControllerPresenceDirectorySnapshot(options: {
  devices: readonly ControllerPresenceDirectoryDevice[];
  requestEpoch: number;
  selfDeviceId: string | null;
  freshness: ControllerPresenceFreshnessTracker;
  getOnline: (deviceId: string) => boolean | undefined;
  setOnline: (deviceId: string, online: boolean) => void;
  forgetOnline: (deviceId: string) => void;
  setPlatform: (deviceId: string, platform: string | null) => void;
  setName: (deviceId: string, name: string) => void;
  shouldNotifyPeerOnline: (device: {
    deviceId: string;
    online: boolean;
    platform: string | null;
  }) => boolean;
  onPeerBecameOnline: (deviceId: string, platform: string | null) => void;
}): void {
  for (const device of options.devices) {
    if (typeof device.deviceId !== 'string' || !device.deviceId.trim()) continue;
    const deviceId = device.deviceId.trim();
    if (device.isSelf === true || deviceId === options.selfDeviceId) continue;
    if (presenceChangedAfterRequest(options.freshness, deviceId, options.requestEpoch)) continue;
    if (typeof device.online !== 'boolean') continue;

    const reportedPlatform =
      typeof device.platform === 'string' && device.platform.trim() ? device.platform.trim() : null;
    const platform = isSupportedControllerPlatform(reportedPlatform) ? reportedPlatform : null;
    const name = normalizeDirectoryName(device);
    if (name) options.setName(deviceId, name);

    if (hasRealtimePresence(options.freshness, deviceId)) continue;

    const wasOnline = options.getOnline(deviceId);
    if (device.online && platform === null) {
      if (wasOnline !== true) {
        options.setPlatform(deviceId, null);
        options.forgetOnline(deviceId);
      }
      continue;
    }

    options.setPlatform(deviceId, platform);
    options.setOnline(deviceId, device.online);
    if (
      wasOnline !== true &&
      options.shouldNotifyPeerOnline({ deviceId, online: device.online, platform })
    ) {
      options.onPeerBecameOnline(deviceId, platform);
    }
  }
}
