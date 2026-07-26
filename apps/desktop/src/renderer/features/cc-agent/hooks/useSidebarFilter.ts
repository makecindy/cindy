/**
 * useSidebarFilter — Sidebar Filter 状态 hook（F-PJ-10 V0.5.1）
 * ---------------------------------------------------------------------------
 * 封装 Status × Project × Vendor × Last activity 筛选状态，以及主列表整理偏好：
 *   - status   : 'active' | 'archived' | 'all'   → 由后端通过 query 过滤
 *   - projects : 'all' | string[]                 → 客户端 render 阶段过滤
 *   - vendor   : 'all' | 'cc' | 'codex'           → 客户端 render 阶段过滤
 *   - lastActivity : 'all' | '1d' | ...           → 客户端 render 阶段过滤
 *   - groupBy  : 'project' | 'date'               → 客户端 render 阶段切换主列表分组
 *   - sortBy   : 'recency' | 'time' | ...         → 客户端 render 阶段切换主列表排序
 *   - manualProjectOrder : string[]               → Project 分组的手动排序偏好
 *
 * 持久化：
 *   - localStorage key `cc-agent.sidebar.filter.status`
 *   - localStorage key `cc-agent.sidebar.filter.projects`
 *   - localStorage key `cc-agent.sidebar.filter.vendor`
 *   - localStorage key `cc-agent.sidebar.filter.groupBy`
 *   - localStorage key `cc-agent.sidebar.filter.lastActivity`
 *   - localStorage key `cc-agent.sidebar.filter.sortBy`
 *   - localStorage key `cc-agent.sidebar.filter.manualProjectOrder`
 *
 * GC（mount 后由编排层在 sessions 首次加载完成时调用一次 `gc(activeWorkingDirs)`）：
 *   - 剔除 projects 数组中已不在 activeWorkingDirs 集合的条目
 *   - 剔除后空 → 自动回退到 'all'
 *
 * 0 选回退：
 *   - 用户取消最后一个勾选 → toggleProject 内部自动写回 'all'
 *
 * 对外暴露：
 *   { status, projects, projectsAsSet, isFilterActive,
 *     setStatus, toggleProject, setProjectsAll, setVendor,
 *     setLastActivity, setGroupBy, setSortBy, setManualProjectOrder, gc }
 *
 * ADR 决策：
 *   - ADR-5：Status 走后端 query，Project 走前端过滤（混合策略）
 *   - ADR-6：不接 activeWorkingDirs 入参（避免循环依赖），GC 由编排层显式触发
 *
 * 内部实现策略：
 *   把所有副作用之外的纯逻辑抽到模块级 `helpers/sidebarFilterCore.ts`，便于
 *   在 vitest（node 环境，无 jsdom / @testing-library/react）下直接单测，
 *   不依赖 React 渲染。Hook 只做 `useState` + 持久化副作用。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  loadStatus,
  loadProjects,
  loadVendor,
  loadGroupBy,
  loadLastActivity,
  loadSortBy,
  loadManualProjectOrder,
  loadManualPinnedOrder,
  persistStatus,
  persistProjects,
  persistVendor,
  persistGroupBy,
  persistLastActivity,
  persistSortBy,
  persistManualProjectOrder,
  persistManualPinnedOrder,
  nextProjectsAfterToggle,
  gcProjectsAgainstActive,
  normalizeManualProjectOrder,
  normalizeManualPinnedOrder,
  type FilterStatus,
  type FilterProjects,
  type FilterVendor,
  type FilterGroupBy,
  type FilterLastActivity,
  type FilterSortBy,
} from './helpers/sidebarFilterCore';

export type {
  FilterStatus,
  FilterProjects,
  FilterVendor,
  FilterGroupBy,
  FilterLastActivity,
  FilterSortBy,
} from './helpers/sidebarFilterCore';
// Re-export storage keys for any caller that needs to clear / migrate them.
export {
  STATUS_KEY,
  PROJECTS_KEY,
  VENDOR_KEY,
  GROUP_BY_KEY,
  LAST_ACTIVITY_KEY,
  SORT_BY_KEY,
  MANUAL_PROJECT_ORDER_KEY,
  MANUAL_PINNED_ORDER_KEY,
} from './helpers/sidebarFilterCore';

export interface UseSidebarFilterReturn {
  /** Status 维度（默认 'active'）。 */
  status: FilterStatus;
  /** Project 维度。'all' = 全部；string[] = 仅显示其中的 normalized workingDir。 */
  projects: FilterProjects;
  /** projects === 'all' 时返回 null，方便 render 阶段做"是否在集合内"判定。 */
  projectsAsSet: Set<string> | null;
  /** 是否处于"已激活筛选"状态（status !== 'active' || projects !== 'all' || vendor !== 'all'）。 */
  isFilterActive: boolean;
  /** 是否处于会收窄 session 集合的内容过滤态；不包含 groupBy / sortBy 展示偏好。 */
  isSessionContentFiltered: boolean;
  /** M41: Vendor 维度（默认 'all'）。 */
  vendor: FilterVendor;
  /** 最近活跃范围筛选。默认 'all'。 */
  lastActivity: FilterLastActivity;
  /** Sidebar 主列表分组方式。默认 'project'，可切到 'date'。 */
  groupBy: FilterGroupBy;
  /** Sidebar 主列表排序方式。默认 'recency'。 */
  sortBy: FilterSortBy;
  /** Project 分组手动排序顺序。元素为 normalized workingDir。 */
  manualProjectOrder: readonly string[];
  /** Pinned 段手动排序顺序。元素为 session id 或带前缀的 project entry id。 */
  manualPinnedOrder: readonly string[];

  setStatus: (s: FilterStatus) => void;
  /** 含 0 选自动回退到 'all'。 */
  toggleProject: (workingDir: string) => void;
  /** 切回 'all'（不取消勾选状态，是显式 reset）。 */
  setProjectsAll: () => void;
  /**
   * 由编排层在 sessions 首次加载完成后调用一次（带去重 ref guard），
   * 把 projects 数组里已不在 activeWorkingDirs 集合内的条目剔除。
   * 调用幂等。
   */
  gc: (activeWorkingDirs: readonly string[]) => void;
  /** M41: 设置 vendor 筛选（'all' | 'cc' | 'codex'），持久化到 localStorage。 */
  setVendor: (v: FilterVendor) => void;
  /** 设置最近活跃范围，持久化到 localStorage。 */
  setLastActivity: (lastActivity: FilterLastActivity) => void;
  /** 设置主列表分组方式，持久化到 localStorage。 */
  setGroupBy: (groupBy: FilterGroupBy) => void;
  /** 设置主列表排序方式，持久化到 localStorage。 */
  setSortBy: (sortBy: FilterSortBy) => void;
  /** 直接替换 Project 手动排序顺序，持久化到 localStorage。 */
  setManualProjectOrder: (
    order: readonly string[],
    activeWorkingDirs: readonly string[],
  ) => void;
  /** 直接替换 Pinned 手动排序顺序并持久化。
   *  activeEntryIds 是当前所有仍有效的 pinned session / project entry id。 */
  setManualPinnedOrder: (
    order: readonly string[],
    activeEntryIds: readonly string[],
  ) => void;
  /** 把一个 pinned entry 提到 manualPinnedOrder 首位（已存在则去重移位）。
   *  pin / re-pin 都调它，确保新置顶立刻可见 rank=0；不调它则 re-pin 会带着
   *  老 rank 卡在原位。函数式更新，对快速连点 pin 安全。 */
  promotePin: (entryId: string) => void;
  /** 从 Pinned 顺序中删除一个 entry；project 置顶状态以 entry 是否存在为准。 */
  removePin: (entryId: string) => void;
}

export function useSidebarFilter(): UseSidebarFilterReturn {
  const [status, setStatusState] = useState<FilterStatus>(() => loadStatus());
  const [projects, setProjectsState] = useState<FilterProjects>(() => loadProjects());
  const [vendor, setVendorState] = useState<FilterVendor>(() => loadVendor());
  const [lastActivity, setLastActivityState] = useState<FilterLastActivity>(() => loadLastActivity());
  const [groupBy, setGroupByState] = useState<FilterGroupBy>(() => loadGroupBy());
  const [sortBy, setSortByState] = useState<FilterSortBy>(() => loadSortBy());
  const [manualProjectOrder, setManualProjectOrderState] = useState<string[]>(() => loadManualProjectOrder());
  const [manualPinnedOrder, setManualPinnedOrderState] = useState<string[]>(() => loadManualPinnedOrder());

  useEffect(
    () =>
      window.electronAPI.sidebarSettingsOnPinnedOrderChanged((next) => {
        setManualPinnedOrderState((prev) =>
          next.length === prev.length && next.every((id, index) => id === prev[index])
            ? prev
            : Array.from(next),
        );
      }),
    [],
  );

  const setStatus = useCallback((s: FilterStatus) => {
    setStatusState(s);
    persistStatus(s);
  }, []);

  const toggleProject = useCallback((workingDir: string) => {
    setProjectsState((prev) => {
      const next = nextProjectsAfterToggle(prev, workingDir);
      if (next === prev) return prev;
      persistProjects(next);
      return next;
    });
  }, []);

  const setProjectsAll = useCallback(() => {
    setProjectsState((prev) => {
      if (prev === 'all') return prev;
      persistProjects('all');
      return 'all';
    });
  }, []);

  const gc = useCallback((activeWorkingDirs: readonly string[]) => {
    setProjectsState((prev) => {
      const next = gcProjectsAgainstActive(prev, activeWorkingDirs);
      if (next === prev) return prev;
      persistProjects(next);
      return next;
    });
    setManualProjectOrderState((prev) => {
      if (prev.length === 0) return prev;
      const next = normalizeManualProjectOrder(prev, activeWorkingDirs);
      if (next.length === prev.length && next.every((wd, index) => wd === prev[index])) return prev;
      persistManualProjectOrder(next);
      return next;
    });
  }, []);

  const projectsAsSet = useMemo<Set<string> | null>(
    () => (projects === 'all' ? null : new Set(projects)),
    [projects],
  );

  const setVendor = useCallback((v: FilterVendor) => {
    setVendorState(v);
    persistVendor(v);
  }, []);

  const setLastActivity = useCallback((next: FilterLastActivity) => {
    setLastActivityState(next);
    persistLastActivity(next);
  }, []);

  const setGroupBy = useCallback((next: FilterGroupBy) => {
    setGroupByState(next);
    persistGroupBy(next);
  }, []);

  const setSortBy = useCallback((next: FilterSortBy) => {
    setSortByState(next);
    persistSortBy(next);
  }, []);

  const setManualProjectOrder = useCallback(
    (order: readonly string[], activeWorkingDirs: readonly string[]) => {
      setManualProjectOrderState((prev) => {
        const next = normalizeManualProjectOrder(order, activeWorkingDirs);
        if (next.length === prev.length && next.every((wd, index) => wd === prev[index])) return prev;
        persistManualProjectOrder(next);
        return next;
      });
    },
    [],
  );

  const setManualPinnedOrder = useCallback(
    (order: readonly string[], activeEntryIds: readonly string[]) => {
      setManualPinnedOrderState((prev) => {
        const next = normalizeManualPinnedOrder(order, activeEntryIds);
        if (next.length === prev.length && next.every((id, index) => id === prev[index])) return prev;
        persistManualPinnedOrder(next);
        return next;
      });
    },
    [],
  );

  const promotePin = useCallback((entryId: string) => {
    setManualPinnedOrderState((prev) => {
      if (prev[0] === entryId) return prev;
      const next = [entryId, ...prev.filter((id) => id !== entryId)];
      persistManualPinnedOrder(next);
      return next;
    });
  }, []);

  const removePin = useCallback((entryId: string) => {
    setManualPinnedOrderState((prev) => {
      if (!prev.includes(entryId)) return prev;
      const next = prev.filter((id) => id !== entryId);
      persistManualPinnedOrder(next);
      return next;
    });
  }, []);

  const isSessionContentFiltered =
    status !== 'active' ||
    projects !== 'all' ||
    vendor !== 'all' ||
    lastActivity !== 'all';

  const isFilterActive =
    isSessionContentFiltered || groupBy !== 'project' || sortBy !== 'recency';

  return {
    status,
    projects,
    projectsAsSet,
    isFilterActive,
    isSessionContentFiltered,
    vendor,
    lastActivity,
    groupBy,
    sortBy,
    manualProjectOrder,
    manualPinnedOrder,
    setStatus,
    toggleProject,
    setProjectsAll,
    gc,
    setVendor,
    setLastActivity,
    setGroupBy,
    setSortBy,
    setManualProjectOrder,
    setManualPinnedOrder,
    promotePin,
    removePin,
  };
}
