/**
 * 插件设置页只缓存布局高度,不保存页面图片、账号文字或临时交互状态。
 * 缓存按 data owner / 插件隔离,仅供同版本重开时留位,真实尺寸仍由 guest 量得。
 */
interface HeightRecord {
  height: number;
  version: string;
}

export const GHOST_SETTINGS_HEIGHT_MIN = 48;
export const GHOST_SETTINGS_HEIGHT_MAX = 800;

const STORAGE_PREFIX = 'ghostSettings.height.v1.';
const LEGACY_PREFIX = 'ghostSettings.snapshot.v2.';
const memoryCache = new Map<string, HeightRecord>();

function scopedKey(dataOwnerId: string, ghostId: string): string {
  return `${encodeURIComponent(dataOwnerId)}:${ghostId}`;
}

/** 只提取布局字段;旧记录里的 dataUrl 等页面内容不得进入新缓存。 */
function parseHeight(raw: string | null): HeightRecord | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return null;
    const { height, version } = value as Record<string, unknown>;
    if (
      typeof height !== 'number' ||
      !Number.isFinite(height) ||
      height <= 0 ||
      typeof version !== 'string'
    )
      return null;
    return {
      height: Math.max(
        GHOST_SETTINGS_HEIGHT_MIN,
        Math.min(GHOST_SETTINGS_HEIGHT_MAX, Math.ceil(height)),
      ),
      version,
    };
  } catch {
    return null;
  }
}

function removePersisted(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // 布局缓存不可用不影响插件功能。
  }
}

function readHeight(key: string): HeightRecord | null {
  const cached = memoryCache.get(key);
  if (cached) return cached;
  let record: HeightRecord | null = null;
  try {
    record = parseHeight(localStorage.getItem(STORAGE_PREFIX + key));
    if (!record) {
      // 仅从已明确归属当前 owner 的旧快照保留高度,不认领无 owner 的 v1 快照。
      record = parseHeight(localStorage.getItem(LEGACY_PREFIX + key));
      if (record) localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(record));
    }
  } catch {
    // 持久化不可用时仍可复用已读取的高度。
  } finally {
    // 不论旧数据是否有效,都不再保留此 owner 的历史页面图片。
    removePersisted(LEGACY_PREFIX + key);
  }
  if (record) memoryCache.set(key, record);
  return record;
}

export function loadGhostSettingsHeight(
  dataOwnerId: string | null,
  ghostId: string,
  version: string,
): number | null {
  if (!dataOwnerId) return null;
  const record = readHeight(scopedKey(dataOwnerId, ghostId));
  return record?.version === version ? record.height : null;
}

export function saveGhostSettingsHeight(
  dataOwnerId: string | null,
  ghostId: string,
  version: string,
  height: number,
): void {
  if (!dataOwnerId || !Number.isFinite(height) || height <= 0) return;
  const key = scopedKey(dataOwnerId, ghostId);
  const record = {
    height: Math.max(
      GHOST_SETTINGS_HEIGHT_MIN,
      Math.min(GHOST_SETTINGS_HEIGHT_MAX, Math.ceil(height)),
    ),
    version,
  };
  const previous = memoryCache.get(key);
  if (previous?.height === record.height && previous.version === version) return;
  memoryCache.set(key, record);
  removePersisted(LEGACY_PREFIX + key);
  try {
    localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(record));
  } catch {
    // 配额满或存储禁用时只保留会话内高度。
  }
}

/** 启动/插件清单变化时迁移当前 owner 的旧缓存并清理已卸载插件的布局记录。 */
export function pruneGhostSettingsHeights(
  dataOwnerId: string | null,
  installedGhostIds: Iterable<string>,
): void {
  if (!dataOwnerId) return;
  const ownerPrefix = `${encodeURIComponent(dataOwnerId)}:`;
  const keep = new Set(installedGhostIds);
  const keys = new Set([...memoryCache.keys()].filter((key) => key.startsWith(ownerPrefix)));
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      for (const prefix of [STORAGE_PREFIX, LEGACY_PREFIX]) {
        if (key?.startsWith(prefix + ownerPrefix)) keys.add(key.slice(prefix.length));
      }
    }
  } catch {
    // 仍清理当前 owner 的会话内孤儿缓存。
  }
  for (const key of keys) {
    if (keep.has(key.slice(ownerPrefix.length))) {
      readHeight(key);
    } else {
      memoryCache.delete(key);
      removePersisted(STORAGE_PREFIX + key);
    }
    removePersisted(LEGACY_PREFIX + key);
  }
}

/** 仅测试用:模拟 renderer 重启后的冷读取。 */
export function __resetGhostSettingsHeightCacheForTest(): void {
  memoryCache.clear();
}
