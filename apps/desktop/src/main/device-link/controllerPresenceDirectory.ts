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

function normalizeDirectoryName(device: ControllerPresenceDirectoryDevice): string | null {
  for (const value of [device.selfName, device.name]) {
    if (typeof value !== 'string') continue;
    const normalized = value.trim();
    if (normalized) return normalized;
  }
  return null;
}

/**
 * presence 是增量流，新连接不会收到已经在线设备的历史状态。设备目录承担冷启动
 * 快照，但只能补请求期间没有实时 presence 的设备，避免旧 REST 响应覆盖新广播。
 *
 * 在线设备若缺少可信平台值，保持为「在线状态未知」：这样后续真实 presence 到达
 * 时仍会形成上线边沿，而不会被一条不完整目录记录永久压住词典握手。
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

    const platform =
      typeof device.platform === 'string' && device.platform.trim() ? device.platform.trim() : null;
    options.setPlatform(deviceId, platform);

    const name = normalizeDirectoryName(device);
    if (name) options.setName(deviceId, name);

    if (device.online && platform === null) {
      options.forgetOnline(deviceId);
      continue;
    }

    const wasOnline = options.getOnline(deviceId);
    options.setOnline(deviceId, device.online);
    if (
      wasOnline !== true &&
      options.shouldNotifyPeerOnline({ deviceId, online: device.online, platform })
    ) {
      options.onPeerBecameOnline(deviceId, platform);
    }
  }
}
