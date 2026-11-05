import { isSupportedControllerPlatform } from './controllerPlatform.js';
import { isScopedPeer } from '@cindy/device-link';

export interface ControllerPresenceFreshnessTracker {
  epoch: number;
  epochByDevice: Map<string, number>;
}

export interface ControllerPresenceEvidence {
  online: boolean;
  enabled?: boolean;
}

export interface ControllerPresenceDirectoryDevice {
  deviceId?: unknown;
  name?: unknown;
  selfName?: unknown;
  online?: unknown;
  remoteControlEnabled?: unknown;
  platform?: unknown;
  isSelf?: unknown;
}

/** Data-path projection only; neither a retained path nor presence grants control. */
export interface ControllerDataPathProof {
  linkStatus: 'online' | 'connecting' | 'stopped';
  linkReady: boolean;
  offlineDirect: boolean;
  presenceAvailable: boolean | undefined;
  revoked: boolean;
  locallyDisabled: boolean;
}

/** A current, authenticated data path only; an old directory/presence flag is not evidence. */
export function isVerifiedControllerDataPath(input: ControllerDataPathProof): boolean {
  return input.presenceAvailable === true
    && !input.revoked
    && !input.locallyDisabled
    && input.linkReady
    && (input.linkStatus === 'online' || input.offlineDirect);
}

/** Scope a readiness list to ordinary peers with a verified data-path proof. */
export function projectDirectDataDeviceIds(
  deviceIds: readonly string[],
  available: (deviceId: string) => boolean,
): string[] {
  return deviceIds.filter(deviceId => !isScopedPeer(deviceId) && available(deviceId));
}

export function resolveControllerPresence(
  snapshot: { online: boolean; remoteControlEnabled: boolean },
  retainedDirectPath: boolean,
  previousAvailable: boolean | undefined,
): { directOnline: boolean; online: boolean; available: boolean } {
  const directOnline = !snapshot.online && retainedDirectPath;
  const online = snapshot.online || directOnline;
  // Offline presence/directory rows are masked to remoteControlEnabled=false by
  // the relay. Only an online false bit is an explicit control-off; a retained
  // path keeps its last verified availability until the bounded grace expires,
  // and an accepted direct path is itself evidence that control was enabled.
  const explicitControlOff = snapshot.online && snapshot.remoteControlEnabled === false;
  const available = online && !explicitControlOff
    && (directOnline ? previousAvailable !== false : snapshot.remoteControlEnabled);
  return { directOnline, online, available };
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
  /** A fresh current directory row confirmed the peer accepts outbound control. */
  onPeerControlEnabled?: (deviceId: string) => void;
  /** A fresh current directory row confirmed the peer refuses outbound control. */
  onPeerControlDisabled?: (deviceId: string) => void;
  /** Raw directory evidence, separate from any retained display projection. */
  onPeerControlEvidence?: (deviceId: string, evidence: ControllerPresenceEvidence) => void;
  /** False while local signaling is unavailable: report control evidence, do not promote presence. */
  updatePresenceState?: boolean;
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

    const control = device.online === true
      ? device.remoteControlEnabled === true ? true : device.remoteControlEnabled === false ? false : undefined
      : undefined;
    if (control === true) options.onPeerControlEnabled?.(deviceId);
    else if (control === false) options.onPeerControlDisabled?.(deviceId);
    options.onPeerControlEvidence?.(deviceId, { online: device.online === true,
      ...(control === undefined ? {} : { enabled: control }) });
    if (options.updatePresenceState === false) continue;
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
