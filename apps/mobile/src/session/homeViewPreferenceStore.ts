import AsyncStorage from '@react-native-async-storage/async-storage';

import type { HomeListSortBy, HomeStatusFilter } from './homeListPriority';
import type { HomeProjectOrder } from './homeProjectOrder';
import {
  DEFAULT_HOME_TASK_INFO_FIELDS,
  HOME_IDENTITY_FIELDS,
  type HomePinnedView,
  type HomePinnedSort,
  DEFAULT_HOME_FILTERS,
  normalizeLastActivityFilter,
  normalizeProjectFilter,
  normalizeTaskInfoFields,
  normalizeVendorFilter,
  normalizeViewMode,
  type HomeFilterSelection,
  type HomeModeDisplayPreferences,
  type HomeLastActivityFilter,
  type HomeListViewMode,
  type HomeProjectFilter,
  type HomeTeammateFilter,
  type HomeTaskInfoField,
  type HomeVendorFilter,
} from './homeDisplaySettings';

const STORAGE_KEY = 'xdt-maker.mobile.home.view-preferences.v1';

/** 首页视图偏好:设备范围 + 显示菜单(与桌面侧栏同结构)。缺省值保持老用户现在的样子。 */
export interface HomeViewPreferences {
  groupByProject: boolean;
  /** 缺省关:老首页是项目 folder + 对话按时间混排,不是桌面现在的「对话归组」。 */
  groupDialogue: boolean;
  groupDevice: boolean;
  pinnedView: HomePinnedView;
  pinnedSort: HomePinnedSort;
  pinnedOrder: string[];
  /** 缺省关,与手机端「对话」同一默认:自动化运行的任务收进「自动化」目录。 */
  groupAutomation: boolean;
  /** 缺省关:消息平台(飞书、Slack 等)来的无项目任务按平台各收进一个目录。 */
  groupMessaging: boolean;
  sortBy: HomeListSortBy;
  statusFilter: HomeStatusFilter;
  /** 缺省按最近活动;手动时项目行按 manualProjectOrder,对话仍跟任务排序。 */
  projectOrder: HomeProjectOrder;
  manualProjectOrder: string[];
  /** 项目 key 带设备与路径,只对保存它的账号身份有效(见 projectFilterOwner)。 */
  projectFilter: HomeProjectFilter;
  teammateFilter: HomeTeammateFilter;
  teammateFilterOwner: string;
  /** 保存项目筛选时的账号身份(homeNavigationOwner);读取时与当前身份不符则视为不筛选。 */
  projectFilterOwner: string;
  vendorFilter: HomeVendorFilter;
  lastActivityFilter: HomeLastActivityFilter;
  hideAutomations?: boolean;
  /** 旧记录的顶层筛选属于普通任务列表；收件箱的选择单独保存。 */
  inboxFilters?: HomeModeDisplayPreferences;
  taskListMode?: 'tasks' | 'inbox';
  /** 缺省列表(带预览行):手机首页一直是这个样子。 */
  viewMode: HomeListViewMode;
  /** 任务行右侧信息;顺序 = 勾选先后。 */
  taskInfoFields: HomeTaskInfoField[];
  /** 上次选中的电脑;name 用于设备列表尚未同步回来时的表头兜底显示。 */
  selectedDevice: { deviceId: string; name: string } | null;
}

export interface HomeViewPreferencePatch {
  groupByProject?: boolean;
  groupDialogue?: boolean;
  groupDevice?: boolean;
  pinnedView?: HomePinnedView;
  pinnedSort?: HomePinnedSort;
  pinnedOrder?: { owner: string; keys: string[] };
  groupAutomation?: boolean;
  groupMessaging?: boolean;
  sortBy?: HomeListSortBy;
  statusFilter?: HomeStatusFilter;
  projectOrder?: HomeProjectOrder;
  manualProjectOrder?: string[];
  /** 写项目筛选必须同时给 owner,否则无法判断它属于哪个账号。 */
  projectFilter?: { owner: string; value: HomeProjectFilter };
  teammateFilter?: { owner: string; value: HomeTeammateFilter };
  vendorFilter?: HomeVendorFilter;
  lastActivityFilter?: HomeLastActivityFilter;
  hideAutomations?: boolean;
  taskListMode?: 'tasks' | 'inbox';
  viewMode?: HomeListViewMode;
  taskInfoFields?: HomeTaskInfoField[];
  selectedDevice?: { deviceId: string; name: string } | null;
}

/**
 * 读首页视图偏好。偏好整体按设备存一份,但项目筛选按账号隔离:切换账号后另一个账号
 * 的项目 key 匹配不上任何项目,沿用会把新账号的首页筛空,因此身份不符时回到不筛选。
 */
export async function readHomeViewPreferences(owner: string): Promise<HomeViewPreferences> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  if (!raw) return emptyPreferences();
  try {
    return normalizeStoredPreferences(JSON.parse(raw), owner);
  } catch {
    return emptyPreferences();
  }
}

// save 是 read-modify-write:并发调用会拿到同一份旧快照互相覆盖(后落盘者丢掉先落盘的 patch),
// 用单一 pending 链把「读 → 合并 → 写」串行化,保证每次写都基于上一次写完后的状态。
let writeChain: Promise<void> = Promise.resolve();

export function saveHomeViewPreferences(patch: HomeViewPreferencePatch, filterMode: 'tasks' | 'inbox' = 'tasks'): Promise<void> {
  const next = writeChain.then(() => writeHomeViewPreferences(patch, filterMode));
  // 链自身吞掉失败,避免一次异常让后续所有写入跟着 reject。
  writeChain = next.catch(() => undefined);
  return next;
}

/**
 * 只持久化用户 override(docs/dev-rules/configuration-and-overrides.md §2):把 patch 合并进已存的
 * 稀疏记录,未写过的字段不落盘,读取时按当下默认值补齐,默认值演进时未自定义的用户自动跟随。
 * 筛选的 'all' 即「不筛选」= 默认,写入时删除字段(「重置筛选」由此恢复跟随默认);
 * 其余字段一经用户显式选择就保留为 override,即使恰好等于当前默认值。
 * 旧版本写下的完整记录无法区分是否自定义,按规则不猜测,原样当作 override。
 */
async function writeHomeViewPreferences(patch: HomeViewPreferencePatch, filterMode: 'tasks' | 'inbox'): Promise<void> {
  // A failed read (disk/lock) must reject so we do not replace a still-valid
  // blob with defaults. Corrupt JSON is different: keeping it makes every
  // computer switch alert "couldn't save" forever.
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  const record: Record<string, unknown> = { ...(raw === null ? {} : parseStoredRecord(raw)) };
  const assign = (field: string, value: unknown) => {
    if (value !== undefined) record[field] = value;
  };
  assign('groupDevice', patch.groupDevice);
  assign('pinnedView', patch.pinnedView);
  assign('pinnedSort', patch.pinnedSort);
  if (patch.pinnedOrder) {
    record.pinnedOrders = { ...readRecord(record.pinnedOrders), [patch.pinnedOrder.owner]: patch.pinnedOrder.keys };
  }
  assign('groupByProject', patch.groupByProject);
  assign('groupDialogue', patch.groupDialogue);
  assign('groupAutomation', patch.groupAutomation);
  assign('groupMessaging', patch.groupMessaging);
  assign('sortBy', patch.sortBy);
  assign('statusFilter', patch.statusFilter);
  assign('projectOrder', patch.projectOrder);
  assign('manualProjectOrder', patch.manualProjectOrder ? [...patch.manualProjectOrder] : undefined);
  assign('taskListMode', patch.taskListMode);
  const filters = filterMode === 'inbox' ? { ...readRecord(record.inboxFilters) } : record;
  if (patch.viewMode !== undefined) filters.viewMode = patch.viewMode;
  if (patch.taskInfoFields !== undefined) {
    filters.taskInfoFields = [...patch.taskInfoFields];
    filters.taskInfoVersion = 2;
  }
  for (const field of ['projectFilter', 'teammateFilter'] as const) {
    const filter = patch[field];
    if (!filter) continue;
    if (filter.value === 'all') {
      delete filters[field];
      delete filters[`${field}Owner`];
    } else {
      filters[field] = filter.value === 'none' ? 'none' : [...filter.value];
      filters[`${field}Owner`] = filter.owner;
    }
  }
  for (const field of ['vendorFilter', 'lastActivityFilter'] as const) {
    const value = patch[field];
    if (value === undefined) continue;
    if (value === 'all') delete filters[field];
    else filters[field] = value;
  }
  if (patch.hideAutomations === true) filters.hideAutomations = true;
  if (patch.hideAutomations === false) delete filters.hideAutomations;
  if (filterMode === 'inbox') {
    if (Object.keys(filters).length) record.inboxFilters = filters;
    else delete record.inboxFilters;
  }
  // null 是有效值(切回「所有对话」),用 undefined 判断字段是否出现在 patch 里。
  if (patch.selectedDevice !== undefined) {
    const device = normalizeDevice(patch.selectedDevice);
    if (device) {
      record.deviceId = device.deviceId;
      record.deviceName = device.name;
    } else {
      delete record.deviceId;
      delete record.deviceName;
    }
  }
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(record));
}

/** 已存的稀疏记录;损坏或不是对象时从空记录重来(见上方关于损坏 JSON 的说明)。 */
function parseStoredRecord(raw: string): Record<string, unknown> {
  try {
    return readRecord(JSON.parse(raw)) ?? {};
  } catch {
    return {};
  }
}

export async function clearHomeViewPreferences(): Promise<void> {
  await AsyncStorage.removeItem(STORAGE_KEY).catch(() => undefined);
}

function emptyPreferences(): HomeViewPreferences {
  return {
    groupByProject: true,
    groupDevice: true,
    pinnedView: 'list',
    pinnedSort: 'manual',
    pinnedOrder: [],
    groupDialogue: false,
    groupAutomation: false,
    groupMessaging: false,
    selectedDevice: null,
    sortBy: 'recency',
    statusFilter: 'active',
    projectOrder: 'activity',
    manualProjectOrder: [],
    ...DEFAULT_HOME_FILTERS,
    teammateFilterOwner: '',
    projectFilterOwner: '',
    taskListMode: 'tasks',
    viewMode: 'list',
    taskInfoFields: [...DEFAULT_HOME_TASK_INFO_FIELDS],
  };
}

function readFilters(record: Record<string, unknown>, owner: string): HomeFilterSelection {
  const sameProjectOwner = !!owner && readString(record.projectFilterOwner) === owner;
  const teammate = owner && readString(record.teammateFilterOwner) === owner ? record.teammateFilter : undefined;
  return {
    projectFilter: sameProjectOwner ? normalizeProjectFilter(record.projectFilter) : 'all',
    teammateFilter: teammate === 'none' ? 'none' : normalizeProjectFilter(teammate),
    vendorFilter: normalizeVendorFilter(record.vendorFilter),
    lastActivityFilter: normalizeLastActivityFilter(record.lastActivityFilter),
    ...(record.hideAutomations === true ? { hideAutomations: true } : {}),
  };
}

function readTaskInfo(record: Record<string, unknown>): HomeTaskInfoField[] {
  const fields = normalizeTaskInfoFields(record.taskInfoFields);
  if (record.taskInfoVersion === 2 || !Array.isArray(record.taskInfoFields)) return fields;
  return [...new Set([...fields, ...HOME_IDENTITY_FIELDS])];
}

function normalizeStoredPreferences(value: unknown, owner: string): HomeViewPreferences {
  const record = readRecord(value);
  if (!record) return emptyPreferences();
  const inbox = readRecord(record.inboxFilters);
  const deviceId = readString(record.deviceId);
  const deviceName = readString(record.deviceName);
  return {
    groupByProject: typeof record.groupByProject === 'boolean'
      ? record.groupByProject
      : true,
    groupDevice: record.groupDevice !== false,
    pinnedView: record.pinnedView === 'card' ? 'card' : normalizeViewMode(record.pinnedView),
    pinnedSort: record.pinnedSort === 'activity' ? 'activity' : 'manual',
    pinnedOrder: readStringList(readRecord(record.pinnedOrders)?.[owner]),
    groupDialogue: record.groupDialogue === true,
    groupAutomation: record.groupAutomation === true,
    groupMessaging: record.groupMessaging === true,
    selectedDevice: deviceId
      ? { deviceId, name: deviceName || deviceId }
      : null,
    sortBy: record.sortBy === 'priority' || record.sortBy === 'created' ? record.sortBy : 'recency',
    statusFilter: record.statusFilter === 'archived' || record.statusFilter === 'all'
      ? record.statusFilter
      : 'active',
    projectOrder: record.projectOrder === 'custom' ? 'custom' : 'activity',
    manualProjectOrder: readStringList(record.manualProjectOrder),
    ...readFilters(record, owner),
    projectFilterOwner: readString(record.projectFilterOwner) === owner ? owner : '',
    teammateFilterOwner: readString(record.teammateFilterOwner) === owner ? owner : '',
    ...(inbox ? { inboxFilters: {
      ...readFilters(inbox, owner),
      viewMode: normalizeViewMode(inbox.viewMode),
      taskInfoFields: readTaskInfo(inbox),
    } } : {}),
    taskListMode: record.taskListMode === 'inbox' ? 'inbox' : 'tasks',
    viewMode: normalizeViewMode(record.viewMode),
    taskInfoFields: readTaskInfo(record),
  };
}

function normalizeDevice(device: { deviceId: string; name: string } | null): HomeViewPreferences['selectedDevice'] {
  if (!device) return null;
  const deviceId = typeof device.deviceId === 'string' ? device.deviceId.trim() : '';
  if (!deviceId) return null;
  const name = typeof device.name === 'string' ? device.name.trim() : '';
  return {
    deviceId,
    name: name || deviceId,
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
export interface LastTeammateIdentity {
  deviceId: string;
  collectionId: string;
  resourceKind: 'bot';
  resourceId: string;
}
export interface HomeNavigationPreferences {
  /** Preselects the computer when creating another teammate; launch never reopens it. */
  lastTeammate?: LastTeammateIdentity;
  /** The task home's teammate section: expanded rows or collapsed header. */
  teammatesCollapsed?: boolean;
  /** Explicit account override; absent defaults to showing the collapsed avatar strip. */
  showCollapsedTeammateAvatars?: boolean;
  inboxShowCollapsedTeammateAvatars?: boolean;
}
const NAVIGATION_PREFIX = 'cindy.mobile.home.navigation.v1.';

export function normalizeHomeNavigationPreferences(value: unknown): HomeNavigationPreferences {
  const record = readRecord(value);
  if (!record) return {};
  const last = readRecord(record.lastTeammate);
  const identityFields = ['deviceId', 'collectionId', 'resourceId'] as const;
  const validLast = last?.resourceKind === 'bot' && identityFields.every((field) =>
    typeof last[field] === 'string' && last[field].trim().length > 0 && last[field].length <= 256);
  // The retired tasks/teammates `mode` is dropped here, so the next write clears it.
  return {
    ...(typeof record.inboxShowCollapsedTeammateAvatars === 'boolean' ? { inboxShowCollapsedTeammateAvatars: record.inboxShowCollapsedTeammateAvatars } : {}),
    ...(typeof record.showCollapsedTeammateAvatars === 'boolean' ? { showCollapsedTeammateAvatars: record.showCollapsedTeammateAvatars } : {}),
    ...(typeof record.teammatesCollapsed === 'boolean' ? { teammatesCollapsed: record.teammatesCollapsed } : {}),
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
  patch: Omit<HomeNavigationPreferences, 'lastTeammate'> & { lastTeammate?: LastTeammateIdentity | null },
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

/** Task-home group disclosure. Keys carry device and path, so the record belongs to one account. */
export interface HomeCollapsePreferences {
  pinnedCollapsed?: boolean;
  sharedCollapsed?: boolean;
  collapsedProjectKeys?: string[];
  expandedAutomationGroups?: string[];
}
const COLLAPSE_PREFIX = 'cindy.mobile.home.collapse.v1.';
/** Removed projects never toggle again; keep the most recent choices instead of a GC pass. */
const COLLAPSE_KEY_LIMIT = 200;

function normalizeHomeCollapsePreferences(value: unknown): HomeCollapsePreferences {
  const record = readRecord(value);
  if (!record) return {};
  const next: HomeCollapsePreferences = {};
  for (const field of ['pinnedCollapsed', 'sharedCollapsed'] as const) {
    if (typeof record[field] === 'boolean') next[field] = record[field];
  }
  for (const field of ['collapsedProjectKeys', 'expandedAutomationGroups'] as const) {
    if (Array.isArray(record[field])) next[field] = readStringList(record[field]).slice(-COLLAPSE_KEY_LIMIT);
  }
  return next;
}

export async function readHomeCollapsePreferences(owner: string): Promise<HomeCollapsePreferences> {
  if (!owner) return {};
  const raw = await AsyncStorage.getItem(COLLAPSE_PREFIX + encodeURIComponent(owner));
  if (!raw) return {};
  try { return normalizeHomeCollapsePreferences(JSON.parse(raw)); } catch { return {}; }
}

export function saveHomeCollapsePreferences(owner: string, patch: HomeCollapsePreferences): Promise<void> {
  if (!owner) return Promise.resolve();
  const next = writeChain.then(async () => {
    const current = await readHomeCollapsePreferences(owner);
    const merged = normalizeHomeCollapsePreferences({ ...current, ...patch });
    await AsyncStorage.setItem(COLLAPSE_PREFIX + encodeURIComponent(owner), JSON.stringify(merged));
  });
  writeChain = next.catch(() => undefined);
  return next;
}

export const __testing = {
  storageKey: STORAGE_KEY,
  navigationPrefix: NAVIGATION_PREFIX,
  collapsePrefix: COLLAPSE_PREFIX,
};
