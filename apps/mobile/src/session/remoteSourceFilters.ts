/**
 * 模型选择器来源页里「其他电脑上的供应商」格(远程 Agent)。纯函数,不依赖设备与 i18n,
 * 供选择器的数据层与 iOS / Android 两套视图共用。
 */

/** 远程供应商格的稳定 id(与本机格的 'all' / 'favorites' / providerId 不会撞)。 */
export function remoteFilterId(deviceId: string, providerId: string): string {
  return `remote:${JSON.stringify([deviceId, providerId])}`;
}

/**
 * 来源页分块:被控电脑自己的格(全部 / 收藏 / 各供应商)一块,其他电脑每台一块(块标题 = 电脑名),
 * 块与块内顺序保持传入顺序。
 */
export function groupSourceFilters<T extends { remote?: { deviceId: string; deviceName: string } }>(
  filters: readonly T[],
): { local: T[]; devices: { deviceId: string; name: string; filters: T[] }[] } {
  const local: T[] = [];
  const devices: { deviceId: string; name: string; filters: T[] }[] = [];
  for (const filter of filters) {
    const remote = filter.remote;
    if (!remote) {
      local.push(filter);
      continue;
    }
    const device = devices.find((item) => item.deviceId === remote.deviceId);
    if (device) device.filters.push(filter);
    else devices.push({ deviceId: remote.deviceId, name: remote.deviceName, filters: [filter] });
  }
  return { local, devices };
}
