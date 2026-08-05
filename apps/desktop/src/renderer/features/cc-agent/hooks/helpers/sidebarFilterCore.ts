import { createLogger } from '@/lib/logger';
import { normalizeProjectKey } from '../../lib/projectGrouping';

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
export const LAST_ACTIVITY_KEY = 'cc-agent.sidebar.filter.lastActivity';
export const SORT_BY_KEY = 'cc-agent.sidebar.filter.sortBy';
export const MANUAL_PROJECT_ORDER_KEY = 'cc-agent.sidebar.filter.manualProjectOrder';
export const MANUAL_PINNED_ORDER_KEY = 'cc-agent.sidebar.pinnedSessionOrder';

export type FilterStatus = 'active' | 'archived' | 'all';
/** 'all' 字符串字面量 = 选中"全部"；string[] = 仅显示其中的 normalized workingDir。 */
export type FilterProjects = 'all' | string[];
/** M41: vendor filter — 'all' = 全部；'cc' = 仅 Claude；'codex' = 仅 Codex。 */
export type FilterVendor = 'all' | 'cc' | 'codex';
/** Sidebar 主列表分组方式。默认 project，date 用于按最近活跃日期分组。 */
export type FilterGroupBy = 'project' | 'date';
/** 最近活跃范围筛选。默认 all。 */
export type FilterLastActivity = 'all' | '1d' | '3d' | '7d' | '30d';
/** Sidebar 主列表排序方式。默认 recency。manual/alphabetic 只用于 Project 分组。 */
export type FilterSortBy = 'recency' | 'time' | 'manual' | 'alphabetic';
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
export function loadProjects(): FilterProjects {
  const storage = safeStorage();
  if (!storage) return 'all';
  let raw: string | null = null;
  try {
    raw = storage.getItem(PROJECTS_KEY);
  } catch (err) {
    log.warn('[useSidebarFilter] failed to read projects:', err);
    return 'all';
  }
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
    const cleaned = normalizeProjectKeyList(parsed);
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

export function persistProjects(p: FilterProjects): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    storage.setItem(PROJECTS_KEY, JSON.stringify(p));
  } catch (err) {
    log.warn('[useSidebarFilter] failed to persist projects:', err);
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
): FilterProjects {
  const projectKey = normalizeProjectKey(workingDir);
  if (!projectKey) return prev;
  if (prev === 'all') {
    return [projectKey];
  }
  const normalizedPrev = normalizeProjectKeyList(prev);
  const idx = normalizedPrev.indexOf(projectKey);
  if (idx >= 0) {
    if (normalizedPrev.length === 1) {
      return 'all';
    }
    return normalizedPrev.slice(0, idx).concat(normalizedPrev.slice(idx + 1));
  }
  return normalizedPrev.concat([projectKey]);
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

const GROUP_BY_VALUES: ReadonlySet<string> = new Set<FilterGroupBy>(['project', 'date']);

/**
 * 读 localStorage 中的 groupBy;任何异常 / 非法值 / 未设置 → 'project'。
 * 「按工作目录分组」是 Cindy 作为工作台的设计基线默认值;用户显式切到
 * 'date' 时由 persistGroupBy 写入 storage,下次启动读回,保留其选择。
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

/* ============================== lastActivity load/persist ============================== */

const LAST_ACTIVITY_VALUES: ReadonlySet<string> = new Set<FilterLastActivity>(['all', '1d', '3d', '7d', '30d']);

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
  'time',
  'manual',
  'alphabetic',
]);

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

/* ============================== manual project order load/persist ============================== */

export function loadManualProjectOrder(): string[] {
  const storage = safeStorage();
  if (!storage) return [];
  let raw: string | null = null;
  try {
    raw = storage.getItem(MANUAL_PROJECT_ORDER_KEY);
  } catch (err) {
    log.warn('[useSidebarFilter] failed to read manualProjectOrder:', err);
    return [];
  }
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

export function persistManualProjectOrder(order: readonly string[]): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    storage.setItem(MANUAL_PROJECT_ORDER_KEY, JSON.stringify(order));
  } catch (err) {
    log.warn('[useSidebarFilter] failed to persist manualProjectOrder:', err);
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
 * 数据落在 main 进程 electron-store(userData/sidebar-settings.json),通过 IPC 同步读 / 异步写,
 * 跨 dev (http://localhost) / installed (file://) 共享(localStorage 按 origin 隔离不通)。
 *
 * 一次性 migration:老版本数据在 renderer 的 localStorage 里,首次 load 发现新存储为空
 * 时把 localStorage 内容搬过去 + 清掉老 key。
 */
export function loadManualPinnedOrder(): string[] {
  if (typeof window?.electronAPI === 'undefined') return [];
  const stored = window.electronAPI.sidebarSettingsLoadPinnedOrderSync();
  if (stored.length > 0) return stored;
  // 一次性 migration
  const storage = safeStorage();
  if (!storage) return [];
  const raw = storage.getItem(MANUAL_PINNED_ORDER_KEY);
  storage.removeItem(MANUAL_PINNED_ORDER_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const legacy = parsed.filter((v): v is string => typeof v === 'string' && v.length > 0);
    if (legacy.length > 0) {
      void window.electronAPI.sidebarSettingsSavePinnedOrder(legacy);
    }
    return legacy;
  } catch {
    return [];
  }
}

export function persistManualPinnedOrder(order: readonly string[]): void {
  if (typeof window?.electronAPI === 'undefined') return;
  void window.electronAPI.sidebarSettingsSavePinnedOrder(order);
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
): FilterProjects {
  if (prev === 'all') return prev;
  const activeSet = new Set(normalizeProjectKeyList(activeWorkingDirs));
  const normalizedPrev = normalizeProjectKeyList(prev);
  const filtered = normalizedPrev.filter((wd) => activeSet.has(wd));
  if (filtered.length === 0) return 'all';
  if (filtered.length === normalizedPrev.length && arraysEqual(normalizedPrev, prev)) return prev;
  if (filtered.length === normalizedPrev.length) return normalizedPrev;
  return filtered;
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

function arraysEqual(a: readonly string[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}
