import {
  presentationDate,
  presentationText,
  type PresentationLocalizer,
} from './presentationLocalization.js';

export type DeviceAccessState = 'ready' | 'busy' | 'offline' | 'remote_disabled' | 'access_revoked' | 'self';

export interface DeviceListDeviceLike {
  busy: boolean;
  deviceId: string;
  isSelf: boolean;
  lastSeenAt: string | null;
  name: string;
  online: boolean;
  platform: string | null;
  remoteControlEnabled: boolean;
}

export interface DeviceListItem<TDevice extends DeviceListDeviceLike = DeviceListDeviceLike> {
  canOpen: boolean;
  device: TDevice;
  state: DeviceAccessState;
  statusDetail: string;
  statusLabel: string;
}

export interface DeviceListVisibility<TDevice extends DeviceListDeviceLike = DeviceListDeviceLike> {
  availableCount: number;
  hiddenUnavailableCount: number;
  unavailableCount: number;
  visibleItems: DeviceListItem<TDevice>[];
}

export interface DeviceListPresentation {
  emptyCopy: string;
  emptyTitle: string;
  filterMeta: string;
  filterTitle: string;
  headerSubtitle: string;
  toggleAccessibilityLabel: string | null;
  toggleLabel: string | null;
}

export function isControllableDevice(device: DeviceListDeviceLike): boolean {
  return device.online && device.remoteControlEnabled && !device.isSelf && !isMobilePlatform(device.platform);
}

/**
 * Mobile clients can control desktop hosts, but they cannot be controlled as remote targets.
 */
export function isMobilePlatform(platform: string | null | undefined): boolean {
  return platform === 'ios' || platform === 'android';
}

/**
 * Stable device identity ordering: name first, deviceId as deterministic tie-breaker.
 */
export function compareDevicesByName(
  a: { name: string; deviceId: string },
  b: { name: string; deviceId: string },
): number {
  return a.name.localeCompare(b.name) || a.deviceId.localeCompare(b.deviceId);
}

export function toDeviceListItems<TDevice extends DeviceListDeviceLike>(
  devices: readonly TDevice[],
  now = Date.now(),
  revokedDevices: ReadonlySet<string> = new Set(),
  localizer?: PresentationLocalizer,
): DeviceListItem<TDevice>[] {
  return devices
    .map((device) => toDeviceListItem(device, now, revokedDevices, localizer))
    .filter((item) => item.state !== 'self' && !isMobilePlatform(item.device.platform))
    .map((item, index) => ({ index, item }))
    .sort((a, b) => compareDeviceListItems(a.item, b.item) || a.index - b.index)
    .map(({ item }) => item);
}

export function splitDeviceListItems<TDevice extends DeviceListDeviceLike>(
  items: readonly DeviceListItem<TDevice>[],
): {
  available: DeviceListItem<TDevice>[];
  unavailable: DeviceListItem<TDevice>[];
} {
  const available: DeviceListItem<TDevice>[] = [];
  const unavailable: DeviceListItem<TDevice>[] = [];
  for (const item of items) {
    if (item.canOpen) available.push(item);
    else unavailable.push(item);
  }
  return { available, unavailable };
}

export function visibleDeviceListItems<TDevice extends DeviceListDeviceLike>(
  items: readonly DeviceListItem<TDevice>[],
  showUnavailable: boolean,
): DeviceListVisibility<TDevice> {
  const { available, unavailable } = splitDeviceListItems(items);
  const shouldShowUnavailable = showUnavailable || available.length === 0;
  return {
    availableCount: available.length,
    hiddenUnavailableCount: shouldShowUnavailable ? 0 : unavailable.length,
    unavailableCount: unavailable.length,
    visibleItems: shouldShowUnavailable ? [...available, ...unavailable] : available,
  };
}

export function toDeviceListItem<TDevice extends DeviceListDeviceLike>(
  device: TDevice,
  now = Date.now(),
  revokedDevices: ReadonlySet<string> = new Set(),
  localizer?: PresentationLocalizer,
): DeviceListItem<TDevice> {
  const state = deviceAccessState(device, revokedDevices);
  return {
    device,
    state,
    canOpen: state === 'ready' || state === 'busy',
    statusLabel: deviceStatusLabel(state, localizer),
    statusDetail: deviceStatusDetail(device, state, now, localizer),
  };
}

export function deviceAccessState(
  device: DeviceListDeviceLike,
  revokedDevices: ReadonlySet<string> = new Set(),
): DeviceAccessState {
  if (device.isSelf) return 'self';
  if (revokedDevices.has(device.deviceId)) return 'access_revoked';
  if (!device.online) return 'offline';
  if (!device.remoteControlEnabled) return 'remote_disabled';
  return device.busy ? 'busy' : 'ready';
}

export function buildDeviceListPresentation(
  visibility: Pick<DeviceListVisibility, 'availableCount' | 'hiddenUnavailableCount' | 'unavailableCount'>,
  showUnavailable: boolean,
  localizer?: PresentationLocalizer,
): DeviceListPresentation {
  const { availableCount, hiddenUnavailableCount, unavailableCount } = visibility;
  const headerSubtitle = availableCount > 0
    ? presentationText(localizer, 'devices.presentation.deviceList.headerAvailable', `${availableCount} 台电脑可控制`, { count: availableCount })
    : unavailableCount > 0
      ? presentationText(localizer, 'devices.presentation.deviceList.headerUnavailable', `${unavailableCount} 台电脑暂不可用`, { count: unavailableCount })
      : presentationText(localizer, 'devices.presentation.deviceList.waitingForDesktop', '等待电脑端上线');
  const filterTitle = availableCount > 0
    ? presentationText(localizer, 'devices.presentation.deviceList.filterAvailable', '可控制设备')
    : presentationText(localizer, 'devices.presentation.deviceList.filterEmpty', '没有可控制设备');
  const filterMeta = availableCount > 0
    ? presentationText(
        localizer,
        unavailableCount > 0
          ? 'devices.presentation.deviceList.filterMetaWithUnavailable'
          : 'devices.presentation.deviceList.filterMeta',
        `${availableCount} 台可进入${unavailableCount > 0 ? ` · ${unavailableCount} 台需处理` : ''}`,
        { available: availableCount, unavailable: unavailableCount },
      )
    : unavailableCount > 0
      ? presentationText(localizer, 'devices.presentation.deviceList.showUnavailableReason', '展开的设备会显示不可用原因')
      : presentationText(localizer, 'devices.presentation.deviceList.waitingForDesktop', '等待电脑端上线');
  const showToggle = unavailableCount > 0 && availableCount > 0;
  return {
    emptyCopy: presentationText(localizer, 'devices.presentation.deviceList.emptyCopy', '在电脑端登录同一账号，并在设置里的远程控制打开“允许同账号设备控制本机”。'),
    emptyTitle: presentationText(localizer, 'devices.presentation.deviceList.emptyTitle', '还没有可显示的电脑'),
    filterMeta,
    filterTitle,
    headerSubtitle,
    toggleAccessibilityLabel: showToggle
      ? showUnavailable
        ? presentationText(localizer, 'devices.presentation.deviceList.hideUnavailableA11y', '隐藏不可用电脑')
        : presentationText(localizer, 'devices.presentation.deviceList.showUnavailableA11y', '显示不可用电脑')
      : null,
    toggleLabel: showToggle
      ? showUnavailable
        ? presentationText(localizer, 'devices.presentation.deviceList.availableOnly', '只看可用')
        : presentationText(localizer, 'devices.presentation.deviceList.unavailableCount', `不可用 ${hiddenUnavailableCount}`, { count: hiddenUnavailableCount })
      : null,
  };
}

export function platformLabel(platform: string | null): string {
  if (platform === 'darwin') return 'macOS';
  if (platform === 'win32') return 'Windows';
  if (platform === 'linux') return 'Linux';
  if (platform === 'ios') return 'iOS';
  if (platform === 'android') return 'Android';
  return platform || 'Unknown';
}

function deviceStatusLabel(state: DeviceAccessState, localizer?: PresentationLocalizer): string {
  switch (state) {
    case 'ready':
      return presentationText(localizer, 'devices.presentation.deviceList.status.ready', '可控制');
    case 'busy':
      return presentationText(localizer, 'devices.presentation.deviceList.status.busy', '运行中');
    case 'offline':
      return presentationText(localizer, 'devices.presentation.deviceList.status.offline', '离线');
    case 'remote_disabled':
      return presentationText(localizer, 'devices.presentation.deviceList.status.remoteDisabled', '未开启远程控制');
    case 'access_revoked':
      return presentationText(localizer, 'devices.presentation.deviceList.status.accessRevoked', '已撤销访问权限');
    case 'self':
      return presentationText(localizer, 'devices.presentation.deviceList.status.self', '本机');
  }
}

function deviceStatusDetail(
  device: DeviceListDeviceLike,
  state: DeviceAccessState,
  now: number,
  localizer?: PresentationLocalizer,
): string {
  if (state === 'access_revoked') return presentationText(localizer, 'devices.presentation.deviceList.detail.accessRevoked', '需要在电脑端恢复这台手机的访问权限');
  if (state === 'offline') return formatLastSeen(device.lastSeenAt, now, localizer);
  if (state === 'remote_disabled') return presentationText(localizer, 'devices.presentation.deviceList.detail.remoteDisabled', '在电脑端设置里打开允许远程控制');
  if (state === 'self') return presentationText(localizer, 'devices.presentation.deviceList.detail.self', '当前手机');
  if (state === 'busy') return presentationText(localizer, 'devices.presentation.deviceList.detail.busy', '电脑端正在处理任务');
  return presentationText(localizer, 'devices.presentation.deviceList.detail.ready', '已允许远程控制');
}

function compareDeviceListItems(
  a: DeviceListItem<DeviceListDeviceLike>,
  b: DeviceListItem<DeviceListDeviceLike>,
): number {
  if (a.canOpen !== b.canOpen) return a.canOpen ? -1 : 1;
  return compareDevicesByName(a.device, b.device);
}

function formatLastSeen(iso: string | null, now: number, localizer?: PresentationLocalizer): string {
  if (!iso) return presentationText(localizer, 'devices.presentation.deviceList.lastSeen.never', '从未上线');
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return presentationText(localizer, 'devices.presentation.deviceList.lastSeen.unknown', '上次在线时间未知');
  const diffMinutes = Math.max(0, Math.floor((now - ts) / 60_000));
  if (diffMinutes < 1) return presentationText(localizer, 'devices.presentation.deviceList.lastSeen.justNow', '刚刚在线');
  if (diffMinutes < 60) return presentationText(localizer, 'devices.presentation.deviceList.lastSeen.minutesAgo', `${diffMinutes} 分钟前在线`, { count: diffMinutes });
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return presentationText(localizer, 'devices.presentation.deviceList.lastSeen.hoursAgo', `${diffHours} 小时前在线`, { count: diffHours });
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return presentationText(localizer, 'devices.presentation.deviceList.lastSeen.daysAgo', `${diffDays} 天前在线`, { count: diffDays });
  const date = presentationDate(localizer, new Date(ts));
  return presentationText(localizer, 'devices.presentation.deviceList.lastSeen.onDate', `上次在线 ${date}`, { date });
}
