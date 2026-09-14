export interface ControllerDisplayNameFreshnessTracker {
  epoch: number;
  directoryRequestSequence: number;
  epochByDevice: Map<string, number>;
  authoritativeNameByDevice: Map<string, string>;
}

export interface ControllerDisplayNameDirectoryDevice {
  deviceId?: unknown;
  name?: unknown;
}

export interface ControllerDisplayNameFreshnessSince {
  changedAfterRequest: boolean;
  authoritativeName: string | null;
}

type ControllerDisplayNameCandidate =
  { kind: 'valid'; name: string } | { kind: 'empty' } | { kind: 'placeholder' };

export function createControllerDisplayNameFreshnessTracker(): ControllerDisplayNameFreshnessTracker {
  return {
    epoch: 0,
    directoryRequestSequence: 0,
    epochByDevice: new Map(),
    authoritativeNameByDevice: new Map(),
  };
}

export function beginControllerDisplayNameDirectoryRequest(
  tracker: ControllerDisplayNameFreshnessTracker,
): number {
  tracker.directoryRequestSequence += 1;
  return tracker.directoryRequestSequence;
}

export function isLatestControllerDisplayNameDirectoryRequest(
  tracker: ControllerDisplayNameFreshnessTracker,
  sequence: number,
): boolean {
  return tracker.directoryRequestSequence === sequence;
}

function markControllerDisplayNamePresenceFresh(
  tracker: ControllerDisplayNameFreshnessTracker,
  deviceId: string,
): void {
  tracker.epoch += 1;
  tracker.epochByDevice.set(deviceId, tracker.epoch);
}

export function resetControllerDisplayNameFreshness(
  tracker: ControllerDisplayNameFreshnessTracker,
): void {
  tracker.epoch += 1;
  tracker.epochByDevice.clear();
  tracker.authoritativeNameByDevice.clear();
}

export function seedControllerDisplayNamesFromCache(
  cachedNames: Readonly<Record<string, string>>,
  freshness: ControllerDisplayNameFreshnessTracker,
  setDisplayName: (deviceId: string, name: string) => void,
): void {
  for (const [deviceId, name] of Object.entries(cachedNames)) {
    freshness.authoritativeNameByDevice.set(deviceId, name);
    setDisplayName(deviceId, name);
  }
}

export function getControllerDisplayNameFreshnessSince(
  tracker: ControllerDisplayNameFreshnessTracker,
  deviceId: string,
  requestEpoch: number,
): ControllerDisplayNameFreshnessSince {
  return {
    changedAfterRequest: (tracker.epochByDevice.get(deviceId) ?? 0) > requestEpoch,
    authoritativeName: tracker.authoritativeNameByDevice.get(deviceId) ?? null,
  };
}

function classifyControllerDisplayName(
  value: unknown,
  normalizeName: (name: string) => string | null,
): ControllerDisplayNameCandidate {
  if (typeof value !== 'string') return { kind: 'placeholder' };
  if (!value.trim()) return { kind: 'empty' };
  const normalized = normalizeName(value);
  return normalized ? { kind: 'valid', name: normalized } : { kind: 'placeholder' };
}

/**
 * presence.deviceName 可能是数据库展示名，也可能是旧 relay 直接转发的主机名：
 * - 现代 presence 携带 selfName 字段（值可为 null），说明 deviceName 是 relay
 *   已解析的当前展示名；
 *   即使两者恰好相同，也可能是用户刚把数据库名改成了自报名，必须权威更新；
 * - 旧 presence 缺少 selfName 时无法区分展示名与主机名，只在无目录/缓存时临时回退；
 * - 空名是显式清除，必须推进新鲜度以挡住在途旧目录响应；
 * - unknown/no 等占位值不改状态，也不阻断目录补齐。
 */
export function applyControllerDisplayNamePresence(options: {
  deviceId: string;
  name: unknown;
  selfName?: unknown;
  freshness: ControllerDisplayNameFreshnessTracker;
  normalizeName: (name: string) => string | null;
  setDisplayName: (deviceId: string, name: string) => void;
  setFallbackDisplayName: (deviceId: string, name: string) => void;
  rememberName: (deviceId: string, name: string) => void;
  forgetName: (deviceId: string) => void;
}): void {
  const candidate = classifyControllerDisplayName(options.name, options.normalizeName);
  if (candidate.kind === 'valid') {
    const hasSelfNameField = Object.prototype.hasOwnProperty.call(options, 'selfName');
    if (!hasSelfNameField) {
      if (options.freshness.authoritativeNameByDevice.has(options.deviceId)) return;
      options.setFallbackDisplayName(options.deviceId, candidate.name);
      return;
    }
    markControllerDisplayNamePresenceFresh(options.freshness, options.deviceId);
    options.freshness.authoritativeNameByDevice.set(options.deviceId, candidate.name);
    options.setDisplayName(options.deviceId, candidate.name);
    options.rememberName(options.deviceId, candidate.name);
  } else if (candidate.kind === 'empty') {
    markControllerDisplayNamePresenceFresh(options.freshness, options.deviceId);
    options.freshness.authoritativeNameByDevice.delete(options.deviceId);
    options.setDisplayName(options.deviceId, '');
    options.forgetName(options.deviceId);
  }
}

/**
 * 应用设备目录快照时，跳过请求发起后收到过 presence 的设备。presence 比在途 REST
 * 快照新，旧目录值既不能覆盖当前提示，也不能重新写回 last-known 缓存。
 */
export function applyControllerDisplayNameDirectorySnapshot(options: {
  devices: readonly ControllerDisplayNameDirectoryDevice[];
  cachedNames: Readonly<Record<string, string>>;
  freshness: ControllerDisplayNameFreshnessTracker;
  requestEpoch: number;
  normalizeName: (name: string) => string | null;
  setDisplayName: (deviceId: string, name: string) => void;
  rememberName: (deviceId: string, name: string) => void;
  forgetName: (deviceId: string) => void;
}): void {
  for (const device of options.devices) {
    if (typeof device.deviceId !== 'string' || !device.deviceId.trim()) continue;
    const deviceId = device.deviceId.trim();
    if (
      getControllerDisplayNameFreshnessSince(options.freshness, deviceId, options.requestEpoch)
        .changedAfterRequest
    ) {
      continue;
    }

    const candidate = classifyControllerDisplayName(device.name, options.normalizeName);
    if (candidate.kind === 'valid') {
      options.freshness.authoritativeNameByDevice.set(deviceId, candidate.name);
      options.setDisplayName(deviceId, candidate.name);
      options.rememberName(deviceId, candidate.name);
    } else if (candidate.kind === 'empty') {
      options.freshness.authoritativeNameByDevice.delete(deviceId);
      options.setDisplayName(deviceId, '');
      options.forgetName(deviceId);
    } else {
      const cachedName = options.cachedNames[deviceId];
      if (cachedName) {
        options.freshness.authoritativeNameByDevice.set(deviceId, cachedName);
        options.setDisplayName(deviceId, cachedName);
      }
    }
  }
}
