/**
 * 每账号最近使用的远程设备记录(renderer localStorage,按 dataOwnerId 隔离)。
 *
 * 用于新建任务设备切换器的「在线优先 → 最近使用优先 → 名称升序」排序:
 * 既记住用户在切换器里显式选过的设备,也记住新建任务 / 添加远程项目时用过的设备,
 * 与 remoteProjectsStore 的远端任务活跃时间合并后,哪怕刚换过一次还没建任务也能排到上面。
 */

const MAX_RECENT_DEVICES = 64;

function storageKey(ownerId: string): string {
  return 'cindy:recentDeviceUsage:v1:' + encodeURIComponent(ownerId);
}

function isValidTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function parseUsageMap(raw: string | null): Record<string, number> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const deviceId = key.trim();
      if (deviceId && isValidTimestamp(value)) out[deviceId] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function pruneUsageMap(map: Record<string, number>): Record<string, number> {
  const entries = Object.entries(map);
  if (entries.length <= MAX_RECENT_DEVICES) return map;
  entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return Object.fromEntries(entries.slice(0, MAX_RECENT_DEVICES));
}

export function getRecentDeviceUsage(ownerId: string | null): Record<string, number> {
  if (!ownerId) return {};
  try {
    return parseUsageMap(localStorage.getItem(storageKey(ownerId)));
  } catch {
    return {};
  }
}

export function recordRecentDeviceUsage(
  ownerId: string | null,
  deviceId: string | null | undefined,
  at = Date.now(),
): void {
  const id = typeof deviceId === 'string' ? deviceId.trim() : '';
  if (!ownerId || !id || !isValidTimestamp(at)) return;
  try {
    const key = storageKey(ownerId);
    const current = parseUsageMap(localStorage.getItem(key));
    const prev = current[id] ?? 0;
    if (prev >= at) return;
    current[id] = at;
    localStorage.setItem(key, JSON.stringify(pruneUsageMap(current)));
  } catch {
    // Preference storage is best effort and must not block switching or task creation.
  }
}

/**
 * 合并多份「设备 → 最近使用时间(ms)」映射,同一设备取较新的时间戳。
 * 典型用法:合并本地显式选择记录与远端任务镜像的最近活跃时间。
 */
export function mergeDeviceRecencyMaps(
  ...maps: ReadonlyArray<Readonly<Record<string, number>> | null | undefined>
): Record<string, number> {
  const merged: Record<string, number> = {};
  for (const map of maps) {
    if (!map) continue;
    for (const [key, value] of Object.entries(map)) {
      const deviceId = key.trim();
      if (!deviceId || !isValidTimestamp(value)) continue;
      if (value > (merged[deviceId] ?? 0)) merged[deviceId] = value;
    }
  }
  return merged;
}
