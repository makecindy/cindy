import AsyncStorage from '@react-native-async-storage/async-storage';

import type { HomeListSortBy, HomeStatusFilter } from './homeListPriority';
import type { HomeProjectOrder } from './homeProjectOrder';

const STORAGE_KEY = 'xdt-maker.mobile.home.view-preferences.v1';

/** 首页视图偏好:设备范围 + 显示菜单(分组 / 排序 / 状态)。缺省值保持老用户现在的样子。 */
export interface HomeViewPreferences {
  groupByProject: boolean;
  /** 缺省关:老首页是项目 folder + 对话按时间混排,不是桌面现在的「对话归组」。 */
  groupDialogue: boolean;
  sortBy: HomeListSortBy;
  statusFilter: HomeStatusFilter;
  /** 缺省按最近活动;手动时项目行按 manualProjectOrder,对话仍跟任务排序。 */
  projectOrder: HomeProjectOrder;
  manualProjectOrder: string[];
  /** 上次选中的电脑;name 用于设备列表尚未同步回来时的表头兜底显示。 */
  selectedDevice: { deviceId: string; name: string } | null;
}

export interface HomeViewPreferencePatch {
  groupByProject?: boolean;
  groupDialogue?: boolean;
  sortBy?: HomeListSortBy;
  statusFilter?: HomeStatusFilter;
  projectOrder?: HomeProjectOrder;
  manualProjectOrder?: string[];
  selectedDevice?: { deviceId: string; name: string } | null;
}

export async function readHomeViewPreferences(): Promise<HomeViewPreferences> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  if (!raw) return emptyPreferences();
  try {
    return normalizeStoredPreferences(JSON.parse(raw));
  } catch {
    return emptyPreferences();
  }
}

// save 是 read-modify-write:并发调用会拿到同一份旧快照互相覆盖(后落盘者丢掉先落盘的 patch),
// 用单一 pending 链把「读 → 合并 → 写」串行化,保证每次写都基于上一次写完后的状态。
let writeChain: Promise<void> = Promise.resolve();

export function saveHomeViewPreferences(patch: HomeViewPreferencePatch): Promise<void> {
  const next = writeChain.then(() => writeHomeViewPreferences(patch));
  // 链自身吞掉失败,避免一次异常让后续所有写入跟着 reject。
  writeChain = next.catch(() => undefined);
  return next;
}

async function writeHomeViewPreferences(patch: HomeViewPreferencePatch): Promise<void> {
  // A failed read (including corrupt JSON) is not an empty preference record.
  // Preserve it rather than replacing unrelated choices with defaults.
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  const current = raw === null ? emptyPreferences() : normalizeStoredPreferences(JSON.parse(raw));
  const next: HomeViewPreferences = {
    groupByProject: patch.groupByProject ?? current.groupByProject,
    groupDialogue: patch.groupDialogue ?? current.groupDialogue,
    sortBy: patch.sortBy ?? current.sortBy,
    statusFilter: patch.statusFilter ?? current.statusFilter,
    projectOrder: patch.projectOrder ?? current.projectOrder,
    manualProjectOrder: patch.manualProjectOrder ?? current.manualProjectOrder,
    // null 是有效值(切回「所有对话」),用 undefined 判断字段是否出现在 patch 里。
    selectedDevice: patch.selectedDevice !== undefined
      ? normalizeDevice(patch.selectedDevice)
      : current.selectedDevice,
  };
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(serializePreferences(next)));
}

export async function clearHomeViewPreferences(): Promise<void> {
  await AsyncStorage.removeItem(STORAGE_KEY).catch(() => undefined);
}

function emptyPreferences(): HomeViewPreferences {
  return {
    groupByProject: true,
    groupDialogue: false,
    selectedDevice: null,
    sortBy: 'recency',
    statusFilter: 'active',
    projectOrder: 'activity',
    manualProjectOrder: [],
  };
}

function normalizeStoredPreferences(value: unknown): HomeViewPreferences {
  const record = readRecord(value);
  if (!record) return emptyPreferences();
  const deviceId = readString(record.deviceId);
  const deviceName = readString(record.deviceName);
  return {
    groupByProject: typeof record.groupByProject === 'boolean'
      ? record.groupByProject
      : true,
    groupDialogue: record.groupDialogue === true,
    selectedDevice: deviceId
      ? { deviceId, name: deviceName || deviceId }
      : null,
    sortBy: record.sortBy === 'priority' ? 'priority' : 'recency',
    statusFilter: record.statusFilter === 'archived' || record.statusFilter === 'all'
      ? record.statusFilter
      : 'active',
    projectOrder: record.projectOrder === 'custom' ? 'custom' : 'activity',
    manualProjectOrder: readStringList(record.manualProjectOrder),
  };
}

function normalizeDevice(device: { deviceId: string; name: string } | null): HomeViewPreferences['selectedDevice'] {
  if (!device) return null;
  const deviceId = device.deviceId.trim();
  if (!deviceId) return null;
  return {
    deviceId,
    name: device.name.trim() || deviceId,
  };
}

function serializePreferences(preferences: HomeViewPreferences): Record<string, unknown> {
  return {
    groupByProject: preferences.groupByProject,
    groupDialogue: preferences.groupDialogue,
    sortBy: preferences.sortBy,
    statusFilter: preferences.statusFilter,
    projectOrder: preferences.projectOrder,
    manualProjectOrder: preferences.manualProjectOrder,
    ...(preferences.selectedDevice
      ? {
          deviceId: preferences.selectedDevice.deviceId,
          deviceName: preferences.selectedDevice.name,
        }
      : {}),
  };
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const next: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const key = item.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    next.push(key);
  }
  return next;
}

/** Explicit navigation overrides are separate from legacy device/display preferences.
 * Identity is account + host + resource, never a cached canonical Session or a name.
 */
export type HomeMode = 'tasks' | 'teammates';
export interface LastTeammateIdentity {
  deviceId: string;
  collectionId: string;
  resourceKind: 'bot';
  resourceId: string;
}
export interface HomeNavigationPreferences {
  mode?: HomeMode;
  lastTeammate?: LastTeammateIdentity;
}
const NAVIGATION_PREFIX = 'cindy.mobile.home.navigation.v1.';

export function normalizeHomeNavigationPreferences(value: unknown): HomeNavigationPreferences {
  const record = readRecord(value);
  if (!record) return {};
  const last = readRecord(record.lastTeammate);
  const identityFields = ['deviceId', 'collectionId', 'resourceId'] as const;
  const validLast = last?.resourceKind === 'bot' && identityFields.every((field) =>
    typeof last[field] === 'string' && last[field].trim().length > 0 && last[field].length <= 256);
  return {
    ...(record.mode === 'tasks' || record.mode === 'teammates' ? { mode: record.mode } : {}),
    ...(validLast ? { lastTeammate: {
      deviceId: last!.deviceId as string,
      collectionId: last!.collectionId as string,
      resourceKind: 'bot' as const,
      resourceId: last!.resourceId as string,
    } } : {}),
  };
}

export async function readHomeNavigationPreferences(owner: string): Promise<HomeNavigationPreferences> {
  if (!owner) return {};
  // A failed read must not be treated as an empty blob and overwrite prior choices.
  const raw = await AsyncStorage.getItem(NAVIGATION_PREFIX + encodeURIComponent(owner));
  if (!raw || raw.length > 4096) return {};
  try { return normalizeHomeNavigationPreferences(JSON.parse(raw)); } catch { return {}; }
}

export function saveHomeNavigationPreferences(
  owner: string,
  patch: { mode?: HomeMode; lastTeammate?: LastTeammateIdentity | null },
): Promise<void> {
  if (!owner) return Promise.resolve();
  // Share the existing serialized writer; each operation captures its own owner.
  const next = writeChain.then(async () => {
    const current = await readHomeNavigationPreferences(owner);
    const merged = normalizeHomeNavigationPreferences({ ...current, ...patch });
    await AsyncStorage.setItem(NAVIGATION_PREFIX + encodeURIComponent(owner), JSON.stringify(merged));
  });
  writeChain = next.catch(() => undefined);
  return next;
}

export const __testing = {
  storageKey: STORAGE_KEY,
  navigationPrefix: NAVIGATION_PREFIX,
};
