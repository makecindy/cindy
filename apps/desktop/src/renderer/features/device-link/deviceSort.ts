import { compareDevicesByName } from '@cindy/maker-shared/device-list';

export { compareDevicesByName };

export interface SortablePeerDevice {
  deviceId: string;
  name: string;
  online: boolean;
}

/**
 * 设备切换器排序(用于新建任务等下拉选择器,不同于侧栏/设置的稳定身份排序):
 *   1. 在线设备优先于离线设备(离线行置灰不可点,不应把在线设备挤到折叠区外);
 *   2. 同组内按最近使用时间降序(最近用过的排最上面);
 *   3. 都没有使用记录或时间相同时按名称 → deviceId 稳定升序(compareDevicesByName)。
 */
export function sortDevicesByOnlineAndRecency<T extends SortablePeerDevice>(
  devices: readonly T[],
  lastUsedAtByDeviceId?: Readonly<Record<string, number>> | null,
): T[] {
  if (devices.length <= 1) return [...devices];
  const recency = lastUsedAtByDeviceId ?? null;
  const lastUsed = (deviceId: string): number => {
    const ts = recency?.[deviceId];
    return typeof ts === 'number' && Number.isFinite(ts) && ts > 0 ? ts : 0;
  };
  return [...devices].sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1;
    const recencyDiff = lastUsed(b.deviceId) - lastUsed(a.deviceId);
    if (recencyDiff !== 0) return recencyDiff;
    return compareDevicesByName(a, b);
  });
}
