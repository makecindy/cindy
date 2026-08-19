import { createLogger } from '@/lib/logger';
import {
  clearClaimedLegacySidebarStorage,
  readClaimedLegacySidebarStorage,
  readSidebarOwnerStorage,
  writeSidebarOwnerStorage,
} from '@/lib/sidebarOwnerStorage';
import type { DataOwnerPushStamp } from '../../../../../shared/dataOwnerPush';
import {
  normalizeSidebarPinnedOrder,
  type SidebarPinnedOrderMutation,
  type SidebarSettingsSnapshot,
} from '../../../../../shared/sidebarSettings';
import { normalizeProjectKey, projectKeyComparisonKey } from '../../lib/projectGrouping';

const log = createLogger('SidebarFilterCore');
/**
 * sidebarFilterCore — useSidebarFilter 的纯函数核心（F-PJ-10 V0.5.1）
 * ---------------------------------------------------------------------------
 * 把 hook 中所有可在 node 环境下脱离 React 测试的逻辑抽到这里：
 *   - localStorage 读写 + 校验
 *   - 切换 / GC reducer（输入旧 state + 动作 → 新 state，不改原值）
 *
 * 决策：vitest 配置为 `environment: 'node'`（apps/desktop/vitest.config.ts）且
 * 项目未引入 jsdom / @testing-library/react，因此 hook 单测无法直接 renderHook。
 * 这里把 hook 的"可测部分"集中暴露成纯函数，单测在 node 环境下注入一个轻量
 * 内存 localStorage shim 即可覆盖所有边界（ADR-3 同款"算法纯函数化"做法）。
 */

export const STATUS_KEY = 'cc-agent.sidebar.filter.status';
export const PROJECTS_KEY = 'cc-agent.sidebar.filter.projects';
export const VENDOR_KEY = 'cc-agent.sidebar.filter.vendor';
export const GROUP_BY_KEY = 'cc-agent.sidebar.filter.groupBy';
export const GROUP_DIALOGUE_KEY = 'cc-agent.sidebar.filter.groupDialogue';
export const GROUP_DEVICE_KEY = 'cc-agent.sidebar.filter.groupDevice';
export const DIALOGUE_GROUP_COLLAPSED_KEY = 'cc-agent.sidebar.dialogueGroupCollapsed';
/** 单一混排列表(未按设备切段)里唯一对话组的折叠状态 key。 */
export const DIALOGUE_GROUP_ALL_KEY = 'all';
export const LAST_ACTIVITY_KEY = 'cc-agent.sidebar.filter.lastActivity';
export const SORT_BY_KEY = 'cc-agent.sidebar.filter.sortBy';
export const TASK_INFO_KEY = 'cc-agent.sidebar.filter.taskInfo';
export const MANUAL_PROJECT_ORDER_KEY = 'cc-agent.sidebar.filter.manualProjectOrder';
export const MANUAL_PINNED_ORDER_KEY = 'cc-agent.sidebar.pinnedSessionOrder';

export type FilterStatus = 'active' | 'archived' | 'all';
/**
 * 项目筛选里的「对话」哨兵 = 无项目归属的任务。不是真实 projectKey,
 * 不能走路径归一化,也不能被项目 GC 清掉。
 */
export const DIALOGUE_FILTER_KEY = 'dialogue';
/** 'all' 字符串字面量 = 选中"全部"；string[] = 勾选的 projectKey 和/或 DIALOGUE_FILTER_KEY。 */
export type FilterProjects = 'all' | string[];
/** M41: vendor filter — 'all' = 全部；'cc' = 仅 Claude；'codex' = 仅 Codex。 */
export type FilterVendor = 'all' | 'cc' | 'codex';
/**
 * Sidebar 主列表分组方式(侧边栏重设计 D 期)。
 *   - project: 「按项目分组」开——有项目的任务收进项目行(默认)。
 *   - flat:   「按项目分组」关——全部平铺,行尾带项目来源标签。
 * 旧值 'date'(按日期分组)已删除,存量值回退 'project'。
 */
export type FilterGroupBy = 'project' | 'flat';
/** 最近活跃范围筛选。默认 all。 */
export type FilterLastActivity = 'all' | '1d' | '3d' | '7d' | '30d';
/** Sidebar 主列表排序方式。默认 recency(菜单文案「按时间排序」= 最近活动在前)。
 *  manual 只用于 Project 分组;priority = 等待处理 > 运行中 > 其余按最近活动(D 期新增)。
 *  （侧边栏重设计裁决：alphabetic 与 time(旧「最早优先」)已删除，存量值回退到
 *  recency——时间排序只保留最近优先一档。） */
export type FilterSortBy = 'recency' | 'manual' | 'priority';

/** 切到平铺时,手动排序失去项目行载体,回落到按时间;其它档位保持。 */
export function nextSortByAfterGroupByChange(
  groupBy: FilterGroupBy,
  sortBy: FilterSortBy,
): FilterSortBy {
  return groupBy === 'flat' && sortBy === 'manual' ? 'recency' : sortBy;
}
/**
 * 任务行右侧信息项（复选）。存储数组的顺序 = 用户勾选先后(nextTaskInfoAfterToggle
 * 按序追加),列表行据此渲染(2026-08-12 用户裁决);菜单里四个选项的排列另有固定顺序。
 */
export type TaskInfoField = 'time' | 'pr' | 'tokens' | 'cost';
export type ManualProjectDropPosition = 'before' | 'after';

const STATUS_VALUES: ReadonlySet<string> = new Set<FilterStatus>(['active', 'archived', 'all']);

/**
 * Safely access localStorage. Some test / SSR environments may not have it
 * available — return null and silently degrade.
 */
function safeStorage(): Storage | null {
  try {
    if (typeof globalThis !== 'undefined' && typeof globalThis.localStorage !== 'undefined') {
      return globalThis.localStorage;
    }
  } catch {
    // Some envs throw on access (security errors). Treat as unavailable.
  }
  return null;
}

/* ============================== load ============================== */

/**
 * 读 localStorage 中的 status；任何异常 / 非法值 → 'active'。
 */
export function loadStatus(): FilterStatus {
  const storage = safeStorage();
  if (!storage) return 'active';
  let raw: string | null = null;
  try {
    raw = storage.getItem(STATUS_KEY);
  } catch (err) {
    log.warn('[useSidebarFilter] failed to read status:', err);
    return 'active';
  }
  if (raw && STATUS_VALUES.has(raw)) {
    return raw as FilterStatus;
  }
  return 'active';
}

/**
 * 读 localStorage 中的 projects；任何异常 / 非法值 → 'all'。
 *
 * 合法 schema：
 *   - JSON.parse 后 === 'all' 字符串
 *   - JSON.parse 后是非空字符串数组（每项均为非空 string）；空数组 → 'all'
 */
export function loadProjects(ownerId: string | null): FilterProjects {
  const raw = readSidebarOwnerStorage(PROJECTS_KEY, ownerId);
  if (raw == null) return 'all';
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.warn('[useSidebarFilter] failed to parse projects JSON:', err);
    return 'all';
  }
  if (parsed === 'all') return 'all';
  if (Array.isArray(parsed)) {
    const cleaned = normalizeFilterProjectList(parsed);
    if (cleaned.length === 0) return 'all';
    return cleaned;
  }
  return 'all';
}

/* ============================== persist ============================== */

export function persistStatus(s: FilterStatus): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    storage.setItem(STATUS_KEY, s);
  } catch (err) {
    log.warn('[useSidebarFilter] failed to persist status:', err);
  }
}

export function persistProjects(p: FilterProjects, ownerId: string | null): void {
  if (!writeSidebarOwnerStorage(PROJECTS_KEY, ownerId, JSON.stringify(p))) {
    log.warn('[useSidebarFilter] failed to persist projects');
  }
}

/* ============================== reducers ============================== */

/**
 * 切换某个 workingDir 的勾选状态，含从 'all' 进入具体多选 + 0 选回退语义。
 *
 * 规则：
 *   - prev === 'all' → 第一次 toggle 后只有该 wd 被勾选 → 返回 [wd]
 *   - prev 是数组 + 已含该 wd → 取消勾选；剩余为空时回退到 'all'
 *   - prev 是数组 + 不含该 wd → 加入该 wd（保持原顺序，新加项追加到末尾）
 *
 * 返回值如果与 prev 引用相同（语义上无变化），调用方可短路不写 storage。
 * 实际上本函数总是返回新对象（除非语义无变化才返回 prev）。
 */
export function nextProjectsAfterToggle(
  prev: FilterProjects,
  workingDir: string,
  localPlatform = 'linux',
): FilterProjects {
  const projectKey = normalizeFilterEntry(workingDir);
  if (!projectKey) return prev;
  if (prev === 'all') {
    return [projectKey];
  }
  // Persisted filters may contain multiple Windows spellings of the same local path from
  // pre-comparison-key versions. Collapse them to one logical identity before toggling so a
  // single click removes the whole selected project rather than one stale spelling at a time.
  const normalizedPrev = normalizeFilterProjectList(prev, localPlatform);
  const idx = findProjectFilterIndex(normalizedPrev, projectKey, localPlatform);
  if (idx >= 0) {
    if (normalizedPrev.length === 1) {
      return 'all';
    }
    return normalizedPrev.slice(0, idx).concat(normalizedPrev.slice(idx + 1));
  }
  return normalizedPrev.concat([projectKey]);
}

/**
 * Idempotently includes a project in an existing Project filter.
 *
 * `'all'` already includes every project. Array filters append only when the
 * project is missing, unlike the user-facing toggle action.
 */
export function includeProjectInFilter(
  prev: FilterProjects,
  workingDir: string,
  localPlatform = 'linux',
): FilterProjects {
  if (prev === 'all') return prev;
  const projectKey = normalizeFilterEntry(workingDir);
  if (!projectKey) return prev;
  const normalizedPrev = normalizeFilterProjectList(prev, localPlatform);
  if (findProjectFilterIndex(normalizedPrev, projectKey, localPlatform) >= 0) {
    return arraysEqual(normalizedPrev, prev) ? prev : normalizedPrev;
  }
  return normalizedPrev.concat(projectKey);
}

/** Match a rendered project against the persisted Project filter identity. */
export function projectFilterIncludes(
  projects: ReadonlySet<string>,
  projectKey: string,
  localPlatform: string,
): boolean {
  if (projectKey === DIALOGUE_FILTER_KEY) return projects.has(DIALOGUE_FILTER_KEY);
  const comparisonKey = projectKeyComparisonKey(projectKey, localPlatform);
  if (comparisonKey == null) return false;
  for (const candidate of projects) {
    if (candidate === DIALOGUE_FILTER_KEY) continue;
    if (projectKeyComparisonKey(candidate, localPlatform) === comparisonKey) return true;
  }
  return false;
}

/**
 * Idempotently removes projects from an existing Project filter.
 *
 * This reducer handles main-process hidden-project snapshots. Repeated
 * broadcasts cannot toggle a project back in, and removing the final explicit
 * project falls back to the existing "zero selected means all" behavior.
 */
export function removeProjectsFromFilter(
  prev: FilterProjects,
  projectKeys: ReadonlySet<string>,
  localPlatform: string,
): FilterProjects {
  if (prev === 'all' || projectKeys.size === 0) return prev;
  const hiddenComparisonKeys = new Set(
    normalizeProjectKeyList(Array.from(projectKeys))
      .map((projectKey) => projectKeyComparisonKey(projectKey, localPlatform))
      .filter((projectKey): projectKey is string => projectKey != null),
  );
  if (hiddenComparisonKeys.size === 0) return prev;
  const normalizedPrev = normalizeFilterProjectList(prev, localPlatform);
  const filtered = normalizedPrev.filter((projectKey) => {
    if (projectKey === DIALOGUE_FILTER_KEY) return true;
    const comparisonKey = projectKeyComparisonKey(projectKey, localPlatform);
    return comparisonKey == null || !hiddenComparisonKeys.has(comparisonKey);
  });
  if (filtered.length === 0) return 'all';
  if (filtered.length === normalizedPrev.length) {
    return arraysEqual(normalizedPrev, prev) ? prev : normalizedPrev;
  }
  return filtered;
}

/* ============================== vendor load/persist ============================== */

const VENDOR_VALUES: ReadonlySet<string> = new Set<FilterVendor>(['all', 'cc', 'codex']);

export function loadVendor(): FilterVendor {
  const storage = safeStorage();
  if (!storage) return 'all';
  let raw: string | null = null;
  try {
    raw = storage.getItem(VENDOR_KEY);
  } catch (err) {
    log.warn('[useSidebarFilter] failed to read vendor:', err);
    return 'all';
  }
  if (raw && VENDOR_VALUES.has(raw)) return raw as FilterVendor;
  return 'all';
}

export function persistVendor(v: FilterVendor): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    storage.setItem(VENDOR_KEY, v);
  } catch (err) {
    log.warn('[useSidebarFilter] failed to persist vendor:', err);
  }
}

/* ============================== groupBy load/persist ============================== */

const GROUP_BY_VALUES: ReadonlySet<string> = new Set<FilterGroupBy>(['project', 'flat']);

/**
 * 读 localStorage 中的 groupBy;任何异常 / 非法值 / 未设置 → 'project'。
 * 「按工作目录分组」是 Cindy 作为工作台的设计基线默认值。
 * 旧值 'date'(按日期分组,D 期删除)不在合法集合内,自动回退 'project'。
 */
export function loadGroupBy(): FilterGroupBy {
  const storage = safeStorage();
  if (!storage) return 'project';
  let raw: string | null = null;
  try {
    raw = storage.getItem(GROUP_BY_KEY);
  } catch (err) {
    log.warn('[useSidebarFilter] failed to read groupBy:', err);
    return 'project';
  }
  if (raw && GROUP_BY_VALUES.has(raw)) return raw as FilterGroupBy;
  return 'project';
}

export function persistGroupBy(groupBy: FilterGroupBy): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    storage.setItem(GROUP_BY_KEY, groupBy);
  } catch (err) {
    log.warn('[useSidebarFilter] failed to persist groupBy:', err);
  }
}

/* ============================== groupDialogue load/persist ============================== */

/**
 * 「对话归为一组」开关(D 期):true = 无项目任务收进「对话」组;
 * false = 散排在主列表里与项目行混排。
 * **默认 true**(2026-08-12 用户裁决,推翻 D 期定稿的默认关):默认配置是
 * 设备 + 项目 + 对话三层都分组。老用户与新用户同一套分组默认(用户明确要求),
 * 差异只在显示模式(见 useSidebarCardMode)。
 */
export function loadGroupDialogue(): boolean {
  const storage = safeStorage();
  if (!storage) return true;
  try {
    return storage.getItem(GROUP_DIALOGUE_KEY) !== 'false';
  } catch (err) {
    log.warn('[useSidebarFilter] failed to read groupDialogue:', err);
    return true;
  }
}

export function persistGroupDialogue(groupDialogue: boolean): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    storage.setItem(GROUP_DIALOGUE_KEY, String(groupDialogue));
  } catch (err) {
    log.warn('[useSidebarFilter] failed to persist groupDialogue:', err);
  }
}

/* ============================== groupDevice load/persist ============================== */

/**
 * 「按设备分组」开关(E 期):默认开(定稿)。仅在有远程设备连接时可见/生效
 * (与顶部设备切换栏同一出现条件);仅本机时选项隐藏、效果自然为单段。
 */
export function loadGroupDevice(): boolean {
  const storage = safeStorage();
  if (!storage) return true;
  try {
    return storage.getItem(GROUP_DEVICE_KEY) !== 'false';
  } catch (err) {
    log.warn('[useSidebarFilter] failed to read groupDevice:', err);
    return true;
  }
}

export function persistGroupDevice(groupDevice: boolean): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    storage.setItem(GROUP_DEVICE_KEY, String(groupDevice));
  } catch (err) {
    log.warn('[useSidebarFilter] failed to persist groupDevice:', err);
  }
}

/* ==================== dialogue group collapsed load/persist ==================== */

/**
 * 「对话」组行的折叠状态(与项目行折叠同级的分组折叠,默认展开)。
 * 项目折叠是 owner-scoped(useCollapsedProjects);对话组按分组 key 记忆:
 * 单一混排列表只有一个组(DIALOGUE_GROUP_ALL_KEY),按设备分组时每个设备段
 * 各有一个对话组('local' / deviceId),折叠互相独立(2026-08-12 实机反馈:
 * 共用一个 boolean 会点一个全展开)。条目是有限的短字符串、无 GC 需求,
 * 按显示类偏好走本地 localStorage 即可。
 * 兼容旧格式:曾是单个 boolean 字符串,'true' 迁移为 [DIALOGUE_GROUP_ALL_KEY]。
 */
export function loadDialogueGroupCollapsedKeys(): ReadonlySet<string> {
  const storage = safeStorage();
  if (!storage) return new Set();
  try {
    const raw = storage.getItem(DIALOGUE_GROUP_COLLAPSED_KEY);
    if (!raw || raw === 'false') return new Set();
    if (raw === 'true') return new Set([DIALOGUE_GROUP_ALL_KEY]);
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((v): v is string => typeof v === 'string'));
  } catch (err) {
    log.warn('[useSidebarFilter] failed to read dialogueGroupCollapsed:', err);
    return new Set();
  }
}

export function persistDialogueGroupCollapsedKeys(keys: ReadonlySet<string>): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    storage.setItem(DIALOGUE_GROUP_COLLAPSED_KEY, JSON.stringify([...keys]));
  } catch (err) {
    log.warn('[useSidebarFilter] failed to persist dialogueGroupCollapsed:', err);
  }
}

/* ============================== lastActivity load/persist ============================== */

const LAST_ACTIVITY_VALUES: ReadonlySet<string> = new Set<FilterLastActivity>([
  'all',
  '1d',
  '3d',
  '7d',
  '30d',
]);

export function loadLastActivity(): FilterLastActivity {
  const storage = safeStorage();
  if (!storage) return 'all';
  let raw: string | null = null;
  try {
    raw = storage.getItem(LAST_ACTIVITY_KEY);
  } catch (err) {
    log.warn('[useSidebarFilter] failed to read lastActivity:', err);
    return 'all';
  }
  if (raw && LAST_ACTIVITY_VALUES.has(raw)) return raw as FilterLastActivity;
  return 'all';
}

export function persistLastActivity(lastActivity: FilterLastActivity): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    storage.setItem(LAST_ACTIVITY_KEY, lastActivity);
  } catch (err) {
    log.warn('[useSidebarFilter] failed to persist lastActivity:', err);
  }
}

/* ============================== sortBy load/persist ============================== */

const SORT_BY_VALUES: ReadonlySet<string> = new Set<FilterSortBy>([
  'recency',
  'manual',
  'priority',
]);

/**
 * 读 sortBy。已删除的 'alphabetic' / 'time'(旧「最早优先」)存量值不在合法集合内，
 * 自动回退 'recency'——时间排序现在只保留「最近优先」一档,菜单里就叫「按时间排序」。
 */
export function loadSortBy(): FilterSortBy {
  const storage = safeStorage();
  if (!storage) return 'recency';
  let raw: string | null = null;
  try {
    raw = storage.getItem(SORT_BY_KEY);
  } catch (err) {
    log.warn('[useSidebarFilter] failed to read sortBy:', err);
    return 'recency';
  }
  if (raw && SORT_BY_VALUES.has(raw)) return raw as FilterSortBy;
  return 'recency';
}

export function persistSortBy(sortBy: FilterSortBy): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    storage.setItem(SORT_BY_KEY, sortBy);
  } catch (err) {
    log.warn('[useSidebarFilter] failed to persist sortBy:', err);
  }
}

/* ============================== taskInfo load/persist ============================== */

const TASK_INFO_VALUES: ReadonlySet<string> = new Set<TaskInfoField>([
  'time',
  'pr',
  'tokens',
  'cost',
]);
/** 默认只显示最近活动时间（现状行为）。 */
export const DEFAULT_TASK_INFO_FIELDS: readonly TaskInfoField[] = ['time'];

/**
 * 读任务行右侧信息复选。存储为 JSON string[]；非法值逐项剔除。
 * 与其它维度不同：空数组是合法状态（用户显式全不选 = 行右侧留空），
 * 只有解析失败 / 未设置才回落默认。
 */
export function loadTaskInfoFields(): TaskInfoField[] {
  const storage = safeStorage();
  if (!storage) return [...DEFAULT_TASK_INFO_FIELDS];
  let raw: string | null = null;
  try {
    raw = storage.getItem(TASK_INFO_KEY);
  } catch (err) {
    log.warn('[useSidebarFilter] failed to read taskInfo:', err);
    return [...DEFAULT_TASK_INFO_FIELDS];
  }
  if (raw == null) return [...DEFAULT_TASK_INFO_FIELDS];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...DEFAULT_TASK_INFO_FIELDS];
    const seen = new Set<string>();
    const cleaned: TaskInfoField[] = [];
    for (const value of parsed) {
      if (typeof value !== 'string' || !TASK_INFO_VALUES.has(value) || seen.has(value)) continue;
      seen.add(value);
      cleaned.push(value as TaskInfoField);
    }
    return cleaned;
  } catch (err) {
    log.warn('[useSidebarFilter] failed to parse taskInfo JSON:', err);
    return [...DEFAULT_TASK_INFO_FIELDS];
  }
}

export function persistTaskInfoFields(fields: readonly TaskInfoField[]): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    storage.setItem(TASK_INFO_KEY, JSON.stringify(fields));
  } catch (err) {
    log.warn('[useSidebarFilter] failed to persist taskInfo:', err);
  }
}

/** 切换某个信息项的勾选状态。空数组合法（全不选）。语义无变化时返回 prev。 */
export function nextTaskInfoAfterToggle(
  prev: readonly TaskInfoField[],
  field: TaskInfoField,
): TaskInfoField[] {
  const idx = prev.indexOf(field);
  if (idx >= 0) return prev.slice(0, idx).concat(prev.slice(idx + 1));
  return prev.concat(field);
}

/* ============================== manual project order load/persist ============================== */

export function loadManualProjectOrder(ownerId: string | null): string[] {
  const raw = readSidebarOwnerStorage(MANUAL_PROJECT_ORDER_KEY, ownerId);
  if (raw == null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.warn('[useSidebarFilter] failed to parse manualProjectOrder JSON:', err);
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const value of parsed) {
    const key = typeof value === 'string' ? normalizeProjectKey(value) : null;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    cleaned.push(key);
  }
  return cleaned;
}

export function persistManualProjectOrder(order: readonly string[], ownerId: string | null): void {
  if (!writeSidebarOwnerStorage(MANUAL_PROJECT_ORDER_KEY, ownerId, JSON.stringify(order))) {
    log.warn('[useSidebarFilter] failed to persist manualProjectOrder');
  }
}

export function normalizeManualProjectOrder(
  prev: readonly string[],
  activeWorkingDirs: readonly string[],
): string[] {
  const activeKeys = normalizeProjectKeyList(activeWorkingDirs);
  const activeSet = new Set(activeKeys);
  const seen = new Set<string>();
  const next: string[] = [];

  for (const wd of prev) {
    const key = normalizeProjectKey(wd);
    if (!key || !activeSet.has(key) || seen.has(key)) continue;
    seen.add(key);
    next.push(key);
  }

  for (const key of activeKeys) {
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(key);
  }

  return next;
}

export function moveManualProjectOrder(
  prev: readonly string[],
  activeWorkingDirs: readonly string[],
  sourceWorkingDir: string,
  targetWorkingDir: string,
  position: ManualProjectDropPosition,
): string[] {
  const normalized = normalizeManualProjectOrder(prev, activeWorkingDirs);
  const sourceKey = normalizeProjectKey(sourceWorkingDir);
  const targetKey = normalizeProjectKey(targetWorkingDir);
  if (!sourceKey || !targetKey || sourceKey === targetKey) return normalized;
  const sourceIndex = normalized.indexOf(sourceKey);
  const targetIndex = normalized.indexOf(targetKey);
  if (sourceIndex < 0 || targetIndex < 0) return normalized;

  const withoutSource = normalized.slice();
  withoutSource.splice(sourceIndex, 1);
  const targetIndexAfterRemoval = withoutSource.indexOf(targetKey);
  if (targetIndexAfterRemoval < 0) return normalized;
  const insertIndex = position === 'after' ? targetIndexAfterRemoval + 1 : targetIndexAfterRemoval;
  withoutSource.splice(insertIndex, 0, sourceKey);
  return withoutSource;
}

/* ============================== manual pinned sidebar order load/persist ============================== */

/**
 * 数据落在 main 进程 owner namespace，通过 IPC 同步读 / 异步写。
 *
 * 一次性 migration:老版本数据在 renderer 的 localStorage 里；Main 明确报告 scoped
 * 状态尚未初始化时才搬过去。确认落盘后由 Main 的单调 consumed 标记停止读取旧值；
 * unscoped key 继续保留，避免破坏仍在使用它的旧版本实例。
 */
export interface LoadedManualPinnedOrder {
  order: string[];
  needsLegacyMigration: boolean;
}

export function loadManualPinnedOrder(snapshot: SidebarSettingsSnapshot): LoadedManualPinnedOrder {
  if (snapshot.pinnedOrderIsAuthoritative) {
    // Main authority includes an explicit empty snapshot. Its durable consumed
    // bit makes the captured copy unreadable without deleting the compatibility key.
    clearClaimedLegacySidebarStorage(MANUAL_PINNED_ORDER_KEY, snapshot.dataOwnerId);
    return {
      order: Array.from(snapshot.pinnedOrder),
      needsLegacyMigration: false,
    };
  }
  // Claim the unscoped key before attempting migration so another account
  // cannot consume this owner's legacy order while Main is temporarily blocked.
  const raw = readClaimedLegacySidebarStorage(MANUAL_PINNED_ORDER_KEY, snapshot.dataOwnerId);
  if (raw === null) {
    return {
      order: Array.from(snapshot.pinnedOrder),
      needsLegacyMigration: false,
    };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return {
        order: Array.from(snapshot.pinnedOrder),
        needsLegacyMigration: false,
      };
    }
    const legacy = normalizeSidebarPinnedOrder(parsed);
    return {
      order: Array.from(legacy),
      needsLegacyMigration: true,
    };
  } catch {
    return {
      order: Array.from(snapshot.pinnedOrder),
      needsLegacyMigration: false,
    };
  }
}

export function persistManualPinnedOrder(
  mutation: SidebarPinnedOrderMutation,
  ownerStamp: DataOwnerPushStamp,
): Promise<string[]> {
  if (typeof window?.electronAPI === 'undefined') return Promise.resolve([]);
  return window.electronAPI.sidebarSettings.mutatePinnedOrder(mutation, ownerStamp);
}

export function finishManualPinnedOrderLegacyMigration(ownerId: string | null): void {
  clearClaimedLegacySidebarStorage(MANUAL_PINNED_ORDER_KEY, ownerId);
}

/**
 * 归一化置顶手动顺序：剔除已不在 activeEntryIds 集合中的条目（去重），
 * 然后把 activeEntryIds 里没在 prev 出现过的"新置顶"按入参顺序追加在末尾。
 *
 * 注意：本函数只在用户**拖拽**时被调用（手动重排是排序意图唯一明确的来源）。
 * "新置顶要排到首位"由消费 manualPinnedOrder 的 visiblePinned 在排序时处理
 * （未知 rank 视为 -1），不在这里改语义——否则当前 vendor/projects 过滤掉的
 * pinned session 会被错误抬到首位。
 */
export function normalizeManualPinnedOrder(
  prev: readonly string[],
  activeEntryIds: readonly string[],
): string[] {
  const activeSet = new Set(activeEntryIds);
  const seen = new Set<string>();
  const next: string[] = [];

  for (const id of prev) {
    if (!activeSet.has(id) || seen.has(id)) continue;
    seen.add(id);
    next.push(id);
  }

  for (const id of activeEntryIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    next.push(id);
  }

  return next;
}

/**
 * 把"可见子集的新顺序"**原位** merge 回完整顺序(通用:置顶会话 / 项目两条拖拽线共用)。
 * ---------------------------------------------------------------------------
 * 侧边栏被过滤(按机器 / vendor / 项目)时,拖拽只重排**可见**的条目;不可见的条目(其它机器 /
 * 其它 vendor)必须**保持原位**,不能被丢弃、也不该被挪到末尾。做法:遍历当前完整顺序,遇到可见项
 * 的槽位就按 `visibleNewOrder` 依次填入,非可见项原样保留;`visibleNewOrder` 里不在完整顺序中的
 * 新条目(刚 pin 的会话 / 新建的项目,还没进 order)追加到末尾。
 *
 * - `currentFullOrder`:当前**全量**活跃条目的规范顺序(置顶 = normalizeManualPinnedOrder(order, 全量);
 *   项目 = normalizeManualProjectOrder(order, 全量))。
 * - `visibleNewOrder`:本次拖拽落定的可见段新顺序。
 * 未过滤时 visibleNewOrder == 全量 → 结果 == visibleNewOrder(恒等,对现状零影响)。
 */
export function mergeVisibleReorder(
  currentFullOrder: readonly string[],
  visibleNewOrder: readonly string[],
): string[] {
  const visibleSet = new Set(visibleNewOrder);
  const queue = [...visibleNewOrder];
  const result: string[] = [];
  for (const id of currentFullOrder) {
    if (visibleSet.has(id)) {
      // 可见项槽位:按新顺序依次填;queue 异常耗尽时保留原 id 不丢。
      result.push(queue.length > 0 ? (queue.shift() as string) : id);
    } else {
      result.push(id); // 不可见置顶项(其它机器 / vendor)原位保留
    }
  }
  // visibleNewOrder 里不在 currentFullOrder 的新置顶 id(刚 pin)→ 追加末尾。
  for (const id of queue) result.push(id);
  return result;
}

/**
 * GC：剔除 prev 中已不在 activeWorkingDirs 集合内的条目。
 *   - prev === 'all' → 直接返回 prev（无变化）
 *   - 全部条目仍在 active 集合内 → 直接返回 prev（无变化）
 *   - 剔除后空 → 回退到 'all'
 */
export function gcProjectsAgainstActive(
  prev: FilterProjects,
  activeWorkingDirs: readonly string[],
  localPlatform = 'linux',
): FilterProjects {
  if (prev === 'all') return prev;
  const activeComparisonKeys = new Set(
    normalizeProjectKeyList(activeWorkingDirs)
      .map((projectKey) => projectKeyComparisonKey(projectKey, localPlatform))
      .filter((projectKey): projectKey is string => projectKey != null),
  );
  const normalizedPrev = normalizeFilterProjectList(prev, localPlatform);
  const filtered = normalizedPrev.filter((projectKey) => {
    if (projectKey === DIALOGUE_FILTER_KEY) return true;
    const comparisonKey = projectKeyComparisonKey(projectKey, localPlatform);
    return comparisonKey != null && activeComparisonKeys.has(comparisonKey);
  });
  if (filtered.length === 0) return 'all';
  if (filtered.length === normalizedPrev.length && arraysEqual(normalizedPrev, prev)) return prev;
  if (filtered.length === normalizedPrev.length) return normalizedPrev;
  return filtered;
}

function normalizeFilterEntry(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  if (raw === DIALOGUE_FILTER_KEY) return DIALOGUE_FILTER_KEY;
  return normalizeProjectKey(raw);
}

function normalizeFilterProjectList(
  values: readonly unknown[],
  localPlatform?: string,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = normalizeFilterEntry(value);
    if (!key) continue;
    const identity = localPlatform == null
      ? key
      : (projectFilterEntryIdentity(key, localPlatform) ?? key);
    if (seen.has(identity)) continue;
    seen.add(identity);
    out.push(key);
  }
  return out;
}

function normalizeProjectKeyList(values: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = typeof value === 'string' ? normalizeProjectKey(value) : null;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function findProjectFilterIndex(
  projectKeys: readonly string[],
  projectKey: string,
  localPlatform: string,
): number {
  const identity = projectFilterEntryIdentity(projectKey, localPlatform);
  if (identity == null) return -1;
  return projectKeys.findIndex(
    (candidate) => projectFilterEntryIdentity(candidate, localPlatform) === identity,
  );
}

/** Logical identity used by every single-project filter operation. */
function projectFilterEntryIdentity(projectKey: string, localPlatform: string): string | null {
  if (projectKey === DIALOGUE_FILTER_KEY) return DIALOGUE_FILTER_KEY;
  return projectKeyComparisonKey(projectKey, localPlatform);
}

function arraysEqual(a: readonly string[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}
