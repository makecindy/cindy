import type { DeviceView, PresenceSnapshot } from '@cindy/device-link';
import { isControllableDevice } from '@cindy/maker-shared/device-list';

export interface PresenceDevicePatchResult {
  devices: readonly DeviceView[];
  device: DeviceView | null;
  changed: boolean;
  becameControllable: boolean;
}

export function patchDeviceViewsWithPresence(
  devices: readonly DeviceView[],
  snapshot: PresenceSnapshot,
  selfDeviceId: string | null | undefined,
): PresenceDevicePatchResult {
  const index = devices.findIndex((device) => device.deviceId === snapshot.deviceId);
  const previous = index >= 0 ? devices[index] : null;
  const next = deviceViewFromPresence(snapshot, selfDeviceId, previous);

  if (!previous && next.isSelf) {
    return { devices, device: next, changed: false, becameControllable: false };
  }

  const wasControllable = previous ? isControllableDevice(previous) : false;
  const becameControllable = !wasControllable && isControllableDevice(next);

  if (previous && shallowDeviceViewEqual(previous, next)) {
    return { devices, device: previous, changed: false, becameControllable };
  }

  const patched = [...devices];
  if (index >= 0) patched[index] = next;
  else patched.push(next);

  return { devices: patched, device: next, changed: true, becameControllable };
}

/**
 * presence 补丁的新鲜度追踪器。首页 loadHome 的 REST 设备快照是"请求发起时刻"的旧数据,
 * 若响应落地前某设备又收到了 presence-changed 补丁(桌面端刚重连上线是最典型场景),
 * 直接整体覆盖会把它改回离线,且 presence 只在状态变化时广播、不会再来一条事件纠正,
 * 首页会卡死在「会话都同步出来了、设备却全部不可用(新建对话按钮灰)」。
 * 用单调递增的纪元号记录每台设备最近一次 presence 补丁,让 loadHome 能判断谁比 REST 快照新。
 */
export interface PresenceFreshnessTracker {
  epoch: number;
  epochByDevice: Map<string, number>;
}

export function createPresenceFreshnessTracker(): PresenceFreshnessTracker {
  return { epoch: 0, epochByDevice: new Map() };
}

/** 登记一次 presence 补丁(每次调用推进全局纪元并记到该设备名下)。 */
export function markPresenceFresh(tracker: PresenceFreshnessTracker, deviceId: string): void {
  tracker.epoch += 1;
  tracker.epochByDevice.set(deviceId, tracker.epoch);
}

/** 收集在 sinceEpoch 之后收到过 presence 补丁的设备 id 集合。 */
export function collectFreshPresenceDeviceIds(
  tracker: PresenceFreshnessTracker,
  sinceEpoch: number,
): Set<string> {
  const fresh = new Set<string>();
  for (const [deviceId, epoch] of tracker.epochByDevice) {
    if (epoch > sinceEpoch) fresh.add(deviceId);
  }
  return fresh;
}

/**
 * 把 REST 设备快照与当前(可能被 presence 补丁更新过的)设备视图合并:
 * - 快照发起后收到过 presence 补丁的设备,以当前视图为准(presence 比快照新);
 * - 其余设备以 REST 快照为准(快照比退后台前的残留状态新);
 * - 只存在于当前视图且 presence 新鲜的设备(REST 快照尚未收录的新设备)追加保留。
 */
export function mergeDeviceViewsWithFreshPresence(
  serverDevices: readonly DeviceView[],
  currentDevices: readonly DeviceView[],
  freshPresenceDeviceIds: ReadonlySet<string>,
): DeviceView[] {
  if (freshPresenceDeviceIds.size === 0) return [...serverDevices];
  const currentById = new Map(currentDevices.map((device) => [device.deviceId, device]));
  const merged = serverDevices.map((device) =>
    freshPresenceDeviceIds.has(device.deviceId)
      ? currentById.get(device.deviceId) ?? device
      : device);
  const serverIds = new Set(serverDevices.map((device) => device.deviceId));
  for (const device of currentDevices) {
    if (!serverIds.has(device.deviceId) && freshPresenceDeviceIds.has(device.deviceId)) {
      merged.push(device);
    }
  }
  return merged;
}

function deviceViewFromPresence(
  snapshot: PresenceSnapshot,
  selfDeviceId: string | null | undefined,
  previous: DeviceView | null,
): DeviceView {
  return {
    deviceId: snapshot.deviceId,
    name: snapshot.deviceName || previous?.name || 'unknown',
    selfName: snapshot.selfName ?? previous?.selfName ?? null,
    deviceInfo: snapshot.deviceInfo ?? previous?.deviceInfo ?? null,
    platform: snapshot.platform || previous?.platform || null,
    appVersion: snapshot.appVersion || previous?.appVersion || null,
    lastSeenAt: new Date(snapshot.lastSeenAt).toISOString(),
    online: snapshot.online,
    busy: snapshot.online && snapshot.busy,
    remoteControlEnabled: snapshot.online && snapshot.remoteControlEnabled,
    isSelf: previous?.isSelf ?? (selfDeviceId ? snapshot.deviceId === selfDeviceId : false),
  };
}

function shallowDeviceViewEqual(a: DeviceView, b: DeviceView): boolean {
  return a.deviceId === b.deviceId
    && a.name === b.name
    && (a.selfName ?? null) === (b.selfName ?? null)
    && deviceInfoEqual(a.deviceInfo, b.deviceInfo)
    && a.platform === b.platform
    && a.appVersion === b.appVersion
    && a.lastSeenAt === b.lastSeenAt
    && a.online === b.online
    && a.busy === b.busy
    && a.remoteControlEnabled === b.remoteControlEnabled
    && a.isSelf === b.isSelf;
}

function deviceInfoEqual(
  a: DeviceView['deviceInfo'] | undefined,
  b: DeviceView['deviceInfo'] | undefined,
): boolean {
  return (a?.cpuLabel ?? null) === (b?.cpuLabel ?? null)
    && (a?.memoryGb ?? null) === (b?.memoryGb ?? null)
    && (a?.osVersion ?? null) === (b?.osVersion ?? null)
    && (a?.modelLabel ?? null) === (b?.modelLabel ?? null);
}
