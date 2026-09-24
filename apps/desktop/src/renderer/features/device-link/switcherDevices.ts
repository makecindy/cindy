/**
 * switcherDevices —— 机器切换栏设备列表 + 三态分类(纯函数,可单测)。
 * ---------------------------------------------------------------------------
 * 综合三份数据,给每台「与远程控制相关」的设备打一个状态:
 *   - connected  → 已同步且当前在线(remoteProjectsStore 有 connected 分片)= 已连接,可选中过滤;
 *   - connecting → 在线可控但尚未同步,或仅有断线缓存(bootstrap 在途 / relay 重连中 / 设备离线),
 *                  icon 闪耀,仍可选中过滤;
 *   - rejected   → 对方已撤销本机访问权限(revokedDevicesStore)= 被拒,仅展示(禁止标识 + 点击提示)。
 *
 * 无缓存的离线设备 / 未开启被控 / 与本机无关的设备不进切换栏(归 设置→远程控制 管理)。
 * 本机(isSelf)排除。
 */

import type { RemoteDeviceSummary } from './remoteProjectsStore';
import { isSharedTaskPeer } from '@cindy/device-link';
import { compareDevicesByName, isMobilePlatform } from '@cindy/maker-shared/device-list';

export type DeviceConnectionStatus = 'connected' | 'connecting' | 'rejected';

export interface SwitcherDevice {
  deviceId: string;
  name: string;
  status: DeviceConnectionStatus;
}

export interface BuildSwitcherDevicesInput {
  /** 全量同账号设备(device-link:list-devices);null = 尚未加载。 */
  fullList: readonly DeviceLinkDeviceView[] | null;
  /** 已同步或保留断线缓存的被控设备(remoteProjectsStore)。 */
  syncedDevices: readonly RemoteDeviceSummary[];
  /** 被对方撤销了本机访问权限的设备 id 集合(revokedDevicesStore)。 */
  revoked: ReadonlySet<string>;
}

export function buildSwitcherDevices({
  fullList,
  syncedDevices,
  revoked,
}: BuildSwitcherDevicesInput): SwitcherDevice[] {
  const list = fullList ?? [];
  const nameById = new Map<string, string>();
  const selfIds = new Set<string>();
  const mobileIds = new Set<string>();
  const onlineControllable = new Set<string>();
  for (const d of list) {
    nameById.set(d.deviceId, d.name);
    if (d.isSelf) {
      selfIds.add(d.deviceId);
      continue;
    }
    // 手机等移动端无法被控,永不进列表(即便异常上报 remoteControlEnabled=true 也挡掉)。
    if (isMobilePlatform(d.platform)) {
      mobileIds.add(d.deviceId);
      continue;
    }
    // controlEnabled 是本机「是否允许主动控制该设备」的本地偏好;关掉的设备不进切换栏
    // (与 useDeviceLinkRemoteProjects 的合格判定 disabledControlDeviceIds 同口径)。
    if (d.online && d.remoteControlEnabled && d.controlEnabled) onlineControllable.add(d.deviceId);
  }

  const cached = new Map<string, RemoteDeviceSummary>();
  for (const s of syncedDevices) {
    cached.set(s.deviceId, s);
    // 已连接设备的名字以同步分片(remoteProjectsStore)为准:REST 改名只更新它、不广播 presence,
    // fullList 的名字会滞后 → chip 标签需用同步分片名覆盖。空名才回退 fullList 既有名 / deviceId。
    if (s.deviceName) nameById.set(s.deviceId, s.deviceName);
    else if (!nameById.has(s.deviceId)) nameById.set(s.deviceId, s.deviceName);
  }

  // 候选 = 已连接 ∪ 被拒 ∪ 在线可控(连接中),排除本机与移动端。
  const candidates = new Set<string>([...cached.keys(), ...revoked, ...onlineControllable]);
  for (const id of selfIds) candidates.delete(id);
  for (const id of mobileIds) candidates.delete(id);

  const devices: SwitcherDevice[] = [];
  for (const deviceId of candidates) {
    // Shared tasks belong to task navigation, never the device selector.
    if (isSharedTaskPeer(deviceId)) continue;
    const cachedDevice = cached.get(deviceId);
    let status: DeviceConnectionStatus = 'connecting';
    if (revoked.has(deviceId)) {
      status = 'rejected';
    } else if (cachedDevice && cachedDevice.connected !== false) {
      status = 'connected';
    }
    devices.push({ deviceId, name: nameById.get(deviceId) || deviceId, status });
  }

  // 统一按稳定身份(名字 → deviceId)排,不含状态/在线/时间 → 状态抖动不改变顺序
  // (与设置「我的设备」用同一个 compareDevicesByName,规则一致)。
  devices.sort(compareDevicesByName);
  return devices;
}

/**
 * 可选中(可切换过滤)的设备 id:已连接 + 连接中。被拒(rejected)仅作状态展示、不可选,
 * 故归一化与选中高亮都按这个集合。
 */
export function selectableDeviceIds(devices: readonly SwitcherDevice[]): string[] {
  return devices.filter((d) => d.status !== 'rejected').map((d) => d.deviceId);
}
