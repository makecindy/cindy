import {
  sanitizeSourceName,
  shouldShowSourceDevice,
  type MessageSourceDevice,
} from '@cindy/maker-shared/message-source';

/** 撞名消歧时附在设备名后的 id 前缀长度。 */
const SHORT_DEVICE_ID_LENGTH = 6;

export interface SourceDeviceListEntry {
  deviceId: string;
  name: string;
  isSelf?: boolean;
}

export interface SourceDeviceDisplay {
  /** 标签里显示的名字（已按需附短 id）；undefined = 不带名字的通用文案。 */
  name?: string;
  /**
   * 设备是否仍在同账号设备列表里：true 在、false 已不在、null 列表尚未加载（未知）。
   * 只有 false 才算「该设备已移除」。
   */
  present: boolean | null;
}

function normalizedName(name: string): string {
  return name.trim().toLocaleLowerCase();
}

/**
 * 设备标签的名字：优先按 deviceId 取设备列表里的实时名字（设备改名后标签跟着变），
 * 取不到回退发送时的快照。列表里另有设备同名时附短 id 消歧（与侧栏项目行同口径：
 * 平时只显示名字，撞名才带 id）。
 */
export function resolveSourceDeviceDisplay(
  device: MessageSourceDevice,
  devices: readonly SourceDeviceListEntry[] | null | undefined,
): SourceDeviceDisplay {
  const live = devices?.find((item) => item.deviceId === device.deviceId);
  const name = sanitizeSourceName(live?.name) ?? device.name;
  const present = devices ? Boolean(live) : null;
  if (!name) return { present };
  const key = normalizedName(name);
  const collides = (devices ?? []).some(
    (item) => item.deviceId !== device.deviceId && normalizedName(item.name) === key,
  );
  return {
    name: collides ? `${name} (${device.deviceId.slice(0, SHORT_DEVICE_ID_LENGTH)})` : name,
    present,
  };
}

/**
 * 查看者自己就是发送设备时不显示设备标签。查看者身份取本机 device-link 设备 id：
 * 设备列表里的 isSelf 行与登录态 deviceId 同源，两者任一命中都算本机（远程查看被控
 * 电脑的任务时，本机发出的消息也因此不标）。
 */
export function shouldShowSourceDeviceForViewer(
  device: MessageSourceDevice | undefined,
  viewer: {
    authDeviceId: string | null | undefined;
    devices: readonly SourceDeviceListEntry[] | null | undefined;
  },
): device is MessageSourceDevice {
  const selfDeviceId = viewer.devices?.find((item) => item.isSelf)?.deviceId;
  return (
    shouldShowSourceDevice(device, viewer.authDeviceId) &&
    shouldShowSourceDevice(device, selfDeviceId)
  );
}

/** 「我的设备」聚焦到指定设备的设置页深链。 */
export function myDevicesFocusPath(deviceId: string): string {
  return `/settings?tab=remote-control&section=devices&device=${encodeURIComponent(deviceId)}`;
}

/** 来源标签悬停提示：首行动作说明（可选），其后每行一个 id。 */
export function joinSourceTooltip(
  lines: ReadonlyArray<string | null | undefined | false>,
): string | undefined {
  const text = lines.filter((line): line is string => Boolean(line)).join('\n');
  return text || undefined;
}
