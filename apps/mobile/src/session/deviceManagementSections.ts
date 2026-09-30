import type { DeviceListItem, DeviceListDeviceLike } from '@cindy/maker-shared/device-list';

/** 离线分组默认只露出最近在线的几台,其余收在「显示全部」后面(只影响呈现,不删数据)。 */
export const DEVICE_MANAGEMENT_OFFLINE_PREVIEW_COUNT = 3;

export interface DeviceManagementSections<TDevice extends DeviceListDeviceLike> {
  /** 在线设备(可控在前;含未开远控 / 已撤销访问的在线设备),保持共享排序。 */
  online: DeviceListItem<TDevice>[];
  /** 离线设备(含已撤销访问的离线设备):按最近在线时间倒序(没有记录的排最后),同时间按名称。 */
  offline: DeviceListItem<TDevice>[];
}

function lastSeenMs(iso: string | null): number {
  if (!iso) return Number.NEGATIVE_INFINITY;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

/**
 * 设备管理页分组:在线 / 可控的在前,离线的单独一组。
 * 同名离线设备(如重装后留下的十来条旧记录)按最近在线排序后,最新的一条总在最上面。
 */
export function buildDeviceManagementSections<TDevice extends DeviceListDeviceLike>(
  rows: readonly DeviceListItem<TDevice>[],
): DeviceManagementSections<TDevice> {
  const online: DeviceListItem<TDevice>[] = [];
  const offline: DeviceListItem<TDevice>[] = [];
  for (const row of rows) {
    // 按设备真实在线状态分组:状态会先判「已撤销访问」,离线的已撤销设备 state 不是 offline。
    if (!row.device.online) offline.push(row);
    else online.push(row);
  }
  offline.sort((a, b) =>
    lastSeenMs(b.device.lastSeenAt) - lastSeenMs(a.device.lastSeenAt)
    || a.device.name.localeCompare(b.device.name)
    || a.device.deviceId.localeCompare(b.device.deviceId));
  return { online, offline };
}

/** 离线分组当前应显示的行;expanded 为 false 时只取最近几条。 */
export function visibleOfflineDeviceRows<T>(offline: readonly T[], expanded: boolean): readonly T[] {
  return expanded ? offline : offline.slice(0, DEVICE_MANAGEMENT_OFFLINE_PREVIEW_COUNT);
}

/** 行内状态文字:离线分组已由标题说明「离线」,只留时间;其余显示「状态 · 说明」。 */
export function deviceManagementStatusText(row: Pick<DeviceListItem, 'state' | 'statusDetail' | 'statusLabel'>): string {
  return row.state === 'offline' ? row.statusDetail : `${row.statusLabel} · ${row.statusDetail}`;
}
