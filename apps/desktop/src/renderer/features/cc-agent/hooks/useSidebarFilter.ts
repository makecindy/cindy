/**
 * useSidebarFilter — Sidebar Filter 状态 hook（F-PJ-10 V0.5.1）
 * ---------------------------------------------------------------------------
 * 封装 Status × Project × Vendor × Last activity 筛选状态，以及主列表整理偏好：
 *   - status   : 'active' | 'archived' | 'all'   → 由后端通过 query 过滤
 *   - projects : 'all' | string[]                 → 客户端 render 阶段过滤(含对话哨兵)
 *   - vendor   : 'all' | 'cc' | 'codex'           → 客户端 render 阶段过滤
 *   - lastActivity : 'all' | '1d' | ...           → 客户端 render 阶段过滤
 *   - groupBy  : 'project' | 'flat'               → 客户端 render 阶段切换主列表分组
 *   - sortBy   : 'recency' | 'time' | ...         → 客户端 render 阶段切换主列表排序
 *   - manualProjectOrder : string[]               → Project 分组的手动排序偏好
 *
 * 持久化：
 *   - localStorage key `cc-agent.sidebar.filter.status`
 *   - owner-scoped localStorage key derived from `cc-agent.sidebar.filter.projects`
 *   - localStorage key `cc-agent.sidebar.filter.vendor`
 *   - localStorage key `cc-agent.sidebar.filter.groupBy`
 *   - localStorage key `cc-agent.sidebar.filter.lastActivity`
 *   - localStorage key `cc-agent.sidebar.filter.sortBy`
 *   - owner-scoped localStorage key derived from `cc-agent.sidebar.filter.manualProjectOrder`
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

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { createLogger } from '@/lib/logger';
import { isDataOwnerPushStampCurrent } from '@/contexts/dataOwnerGeneration';
import type { DataOwnerPushStamp } from '../../../../shared/dataOwnerPush';
import type {
  SidebarPinnedOrderMutation,
  SidebarSettingsSnapshot,
} from '../../../../shared/sidebarSettings';

import {
  loadStatus,
  loadProjects,
  loadVendor,
  loadGroupBy,
  loadGroupDialogue,
  loadGroupDevice,
  loadLastActivity,
  loadSortBy,
  loadManualProjectOrder,
  loadManualPinnedOrder,
  finishManualPinnedOrderLegacyMigration,
  persistStatus,
  persistProjects,
  persistVendor,
  persistGroupBy,
  persistGroupDialogue,
  persistGroupDevice,
  persistLastActivity,
  persistSortBy,
  persistManualProjectOrder,
  persistManualPinnedOrder,
  nextProjectsAfterToggle,
  nextSortByAfterGroupByChange,
  includeProjectInFilter,
  removeProjectsFromFilter,
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
  TASK_INFO_KEY,
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
  /** Sidebar 主列表分组方式(D 期):'project' = 按项目分组;'flat' = 全平铺。 */
  groupBy: FilterGroupBy;
  /** 「对话归为一组」开关(D 期):true = 无项目任务收进「对话」组;默认 false 散排。 */
  groupDialogue: boolean;
  /** 「按设备分组」开关(E 期):默认 true;仅有远程设备连接时可见/生效。 */
  groupDevice: boolean;
  /** Sidebar 主列表排序方式。默认 'recency'。 */
  sortBy: FilterSortBy;
  /** Project 分组手动排序顺序。元素为 normalized workingDir。 */
  manualProjectOrder: readonly string[];
  /** Pinned 段手动排序顺序。元素为 session id 或带前缀的 project entry id。 */
  manualPinnedOrder: readonly string[];

  setStatus: (s: FilterStatus) => void;
  /** 含 0 选自动回退到 'all'。 */
  toggleProject: (workingDir: string) => void;
  /** Idempotently include a restored project without toggling an existing selection off. */
  ensureProjectIncluded: (workingDir: string) => void;
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
  /** 设置「对话归为一组」，持久化到 localStorage。 */
  setGroupDialogue: (groupDialogue: boolean) => void;
  /** 设置「按设备分组」，持久化到 localStorage。 */
  setGroupDevice: (groupDevice: boolean) => void;
  /** 设置主列表排序方式，持久化到 localStorage。 */
  setSortBy: (sortBy: FilterSortBy) => void;
  /** 一键重置内容筛选（status/projects/vendor/lastActivity）回默认。 */
  resetContentFilters: () => void;
  /** 直接替换 Project 手动排序顺序，持久化到 localStorage。 */
  setManualProjectOrder: (order: readonly string[], activeWorkingDirs: readonly string[]) => void;
  /** 直接替换 Pinned 手动排序顺序并持久化。
   *  activeEntryIds 是拖拽开始时所有仍有效的 pinned session / project entry id；
   *  baseOrder 是该次拖拽实际看到的完整顺序，供 Main 在最新快照上安全 rebase。 */
  setManualPinnedOrder: (
    order: readonly string[],
    activeEntryIds: readonly string[],
    baseOrder: readonly string[],
  ) => Promise<void>;
  /** 把一个 pinned entry 提到 manualPinnedOrder 首位（已存在则去重移位）。
   *  pin / re-pin 都调它，确保新置顶立刻可见 rank=0；不调它则 re-pin 会带着
   *  老 rank 卡在原位。函数式更新，对快速连点 pin 安全。 */
  promotePin: (entryId: string) => Promise<void>;
  /** 从 Pinned 顺序中删除一个 entry；project 置顶状态以 entry 是否存在为准。 */
  removePin: (entryId: string) => Promise<void>;
}

const log = createLogger('UseSidebarFilter');

function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function isExactOwnerStampCurrent(
  actual: DataOwnerPushStamp,
  expected: DataOwnerPushStamp,
): boolean {
  return (
    actual.dataOwnerId === expected.dataOwnerId &&
    actual.ownerGeneration === expected.ownerGeneration &&
    isDataOwnerPushStampCurrent(actual)
  );
}

export function useSidebarFilter(
  hiddenProjectKeys: ReadonlySet<string>,
  initialSnapshot: SidebarSettingsSnapshot,
): UseSidebarFilterReturn {
  const ownerId = initialSnapshot.dataOwnerId;
  const ownerStamp = useMemo<DataOwnerPushStamp>(
    () => ({
      dataOwnerId: initialSnapshot.dataOwnerId,
      ownerGeneration: initialSnapshot.ownerGeneration,
    }),
    [initialSnapshot.dataOwnerId, initialSnapshot.ownerGeneration],
  );
  const [loadedPinned] = useState(() => loadManualPinnedOrder(initialSnapshot));
  const [status, setStatusState] = useState<FilterStatus>(() => loadStatus());
  const [projects, setProjectsState] = useState<FilterProjects>(() => loadProjects(ownerId));
  const [vendor, setVendorState] = useState<FilterVendor>(() => loadVendor());
  const [lastActivity, setLastActivityState] = useState<FilterLastActivity>(() =>
    loadLastActivity(),
  );
  const [groupBy, setGroupByState] = useState<FilterGroupBy>(() => loadGroupBy());
  const [groupDialogue, setGroupDialogueState] = useState<boolean>(() => loadGroupDialogue());
  const [groupDevice, setGroupDeviceState] = useState<boolean>(() => loadGroupDevice());
  const [sortBy, setSortByState] = useState<FilterSortBy>(() => loadSortBy());
  const [manualProjectOrder, setManualProjectOrderState] = useState<string[]>(() =>
    loadManualProjectOrder(ownerId),
  );
  const [manualPinnedOrder, setManualPinnedOrderState] = useState<string[]>(
    () => loadedPinned.order,
  );
  const latestPinnedOrderRef = useRef<string[]>(loadedPinned.order);
  // A claimed legacy copy remains durable until main confirms migration, so it
  // is also the rollback baseline while that first write is in flight.
  const durablePinnedOrderRef = useRef<string[]>(
    loadedPinned.needsLegacyMigration
      ? Array.from(loadedPinned.order)
      : Array.from(initialSnapshot.pinnedOrder),
  );
  const pinnedWriteQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingPinnedWritesRef = useRef(0);
  const legacyMigrationStartedRef = useRef(false);
  const legacyMigrationPendingRef = useRef(loadedPinned.needsLegacyMigration);

  const reconcilePinnedSnapshot = useCallback(
    (
      next: readonly string[],
      nextOwnerStamp: DataOwnerPushStamp,
      pinnedOrderIsAuthoritative: boolean,
    ): void => {
      if (!isExactOwnerStampCurrent(nextOwnerStamp, ownerStamp)) return;
      const snapshot = Array.from(next);
      if (pinnedOrderIsAuthoritative) {
        finishManualPinnedOrderLegacyMigration(ownerId);
        legacyMigrationPendingRef.current = false;
        durablePinnedOrderRef.current = snapshot;
      } else if (legacyMigrationPendingRef.current) {
        return;
      } else {
        durablePinnedOrderRef.current = snapshot;
      }
      if (pendingPinnedWritesRef.current > 0) return;
      latestPinnedOrderRef.current = snapshot;
      setManualPinnedOrderState((prev) => (sameStringArray(prev, snapshot) ? prev : snapshot));
    },
    [ownerId, ownerStamp],
  );

  const enqueuePinnedPersist = useCallback(
    (
      mutation: SidebarPinnedOrderMutation,
      desiredOrder: readonly string[],
      mutationOwnerStamp = ownerStamp,
    ): Promise<void> => {
      const desired = Array.from(desiredOrder);
      pendingPinnedWritesRef.current += 1;
      const task = pinnedWriteQueueRef.current.then(async () => {
        let succeeded = false;
        try {
          if (mutation.kind !== 'migrate-legacy' && legacyMigrationPendingRef.current) {
            const migrated = await persistManualPinnedOrder(
              {
                kind: 'migrate-legacy',
                order: durablePinnedOrderRef.current,
              },
              mutationOwnerStamp,
            );
            if (isExactOwnerStampCurrent(mutationOwnerStamp, ownerStamp)) {
              durablePinnedOrderRef.current = Array.from(migrated);
              finishManualPinnedOrderLegacyMigration(ownerId);
              legacyMigrationPendingRef.current = false;
            }
          }
          const persisted = await persistManualPinnedOrder(mutation, mutationOwnerStamp);
          if (isExactOwnerStampCurrent(mutationOwnerStamp, ownerStamp)) {
            durablePinnedOrderRef.current = Array.from(persisted);
            finishManualPinnedOrderLegacyMigration(ownerId);
            legacyMigrationPendingRef.current = false;
          }
          succeeded = true;
        } catch (err) {
          if (
            isExactOwnerStampCurrent(mutationOwnerStamp, ownerStamp) &&
            sameStringArray(latestPinnedOrderRef.current, desired)
          ) {
            const rollback = Array.from(durablePinnedOrderRef.current);
            latestPinnedOrderRef.current = rollback;
            setManualPinnedOrderState(rollback);
          }
          throw err;
        } finally {
          pendingPinnedWritesRef.current = Math.max(0, pendingPinnedWritesRef.current - 1);
          if (
            succeeded &&
            pendingPinnedWritesRef.current === 0 &&
            isExactOwnerStampCurrent(mutationOwnerStamp, ownerStamp)
          ) {
            const persisted = Array.from(durablePinnedOrderRef.current);
            latestPinnedOrderRef.current = persisted;
            setManualPinnedOrderState((prev) =>
              sameStringArray(prev, persisted) ? prev : persisted,
            );
          }
        }
      });
      pinnedWriteQueueRef.current = task.catch(() => undefined);
      return task;
    },
    [ownerId, ownerStamp],
  );

  const updatePinnedOrder = useCallback(
    (
      updater: (current: readonly string[]) => string[],
      createMutation: (
        current: readonly string[],
        next: readonly string[],
      ) => SidebarPinnedOrderMutation,
    ): Promise<void> => {
      const current = Array.from(latestPinnedOrderRef.current);
      const next = updater(current);
      if (sameStringArray(next, current)) return Promise.resolve();
      latestPinnedOrderRef.current = next;
      setManualPinnedOrderState(next);
      return enqueuePinnedPersist(createMutation(current, next), next);
    },
    [enqueuePinnedPersist],
  );

  // Hidden projects are a main-process snapshot shared by every renderer.
  // Reconcile before paint so a broadcast received in another window cannot
  // leave a stale project-only filter behind.
  useLayoutEffect(() => {
    setProjectsState((prev) => {
      const next = removeProjectsFromFilter(prev, hiddenProjectKeys, window.electronAPI.platform);
      if (next === prev) return prev;
      persistProjects(next, ownerId);
      return next;
    });
  }, [hiddenProjectKeys, ownerId]);

  useEffect(() => {
    const unsubscribe = window.electronAPI.sidebarSettings.onPinnedOrderChanged(
      (order, ownerStamp) => {
        reconcilePinnedSnapshot(order, ownerStamp, true);
      },
    );
    const latest = window.electronAPI.sidebarSettings.loadSnapshot();
    reconcilePinnedSnapshot(latest.pinnedOrder, latest, latest.pinnedOrderIsAuthoritative);
    if (
      isExactOwnerStampCurrent(latest, ownerStamp) &&
      !latest.pinnedOrderIsAuthoritative &&
      legacyMigrationPendingRef.current &&
      !legacyMigrationStartedRef.current
    ) {
      legacyMigrationStartedRef.current = true;
      const legacyOrder = Array.from(durablePinnedOrderRef.current);
      void enqueuePinnedPersist(
        { kind: 'migrate-legacy', order: legacyOrder },
        legacyOrder,
        ownerStamp,
      ).catch((err) => {
        log.warn('legacy pinned order migration failed; keeping the legacy copy', err);
      });
    }
    return unsubscribe;
  }, [enqueuePinnedPersist, ownerStamp, reconcilePinnedSnapshot]);

  const setStatus = useCallback((s: FilterStatus) => {
    setStatusState(s);
    persistStatus(s);
  }, []);

  const toggleProject = useCallback(
    (workingDir: string) => {
      setProjectsState((prev) => {
        const next = nextProjectsAfterToggle(prev, workingDir, window.electronAPI.platform);
        if (next === prev) return prev;
        persistProjects(next, ownerId);
        return next;
      });
    },
    [ownerId],
  );

  const ensureProjectIncluded = useCallback(
    (workingDir: string) => {
      setProjectsState((prev) => {
        const next = includeProjectInFilter(prev, workingDir, window.electronAPI.platform);
        if (next === prev) return prev;
        persistProjects(next, ownerId);
        return next;
      });
    },
    [ownerId],
  );

  const setProjectsAll = useCallback(() => {
    setProjectsState((prev) => {
      if (prev === 'all') return prev;
      persistProjects('all', ownerId);
      return 'all';
    });
  }, [ownerId]);

  const gc = useCallback(
    (activeWorkingDirs: readonly string[]) => {
      setProjectsState((prev) => {
        const next = gcProjectsAgainstActive(
          prev,
          activeWorkingDirs,
          window.electronAPI.platform,
        );
        if (next === prev) return prev;
        persistProjects(next, ownerId);
        return next;
      });
      setManualProjectOrderState((prev) => {
        if (prev.length === 0) return prev;
        const next = normalizeManualProjectOrder(prev, activeWorkingDirs);
        if (next.length === prev.length && next.every((wd, index) => wd === prev[index]))
          return prev;
        persistManualProjectOrder(next, ownerId);
        return next;
      });
    },
    [ownerId],
  );

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
    // 手动排序只对项目行有意义。切到平铺后菜单不再露出该档,若仍保留
    // sortBy=manual,渲染层会继续按它禁用设备分组,菜单却显示「按时间」。
    setSortByState((current) => {
      const nextSort = nextSortByAfterGroupByChange(next, current);
      if (nextSort === current) return current;
      persistSortBy(nextSort);
      return nextSort;
    });
  }, []);

  const setGroupDialogue = useCallback((next: boolean) => {
    setGroupDialogueState(next);
    persistGroupDialogue(next);
  }, []);

  const setGroupDevice = useCallback((next: boolean) => {
    setGroupDeviceState(next);
    persistGroupDevice(next);
  }, []);

  const setSortBy = useCallback((next: FilterSortBy) => {
    setSortByState(next);
    persistSortBy(next);
  }, []);

  const resetContentFilters = useCallback(() => {
    setStatusState('active');
    persistStatus('active');
    setProjectsState((prev) => {
      if (prev === 'all') return prev;
      persistProjects('all', ownerId);
      return 'all';
    });
    setVendorState('all');
    persistVendor('all');
    setLastActivityState('all');
    persistLastActivity('all');
  }, [ownerId]);

  const setManualProjectOrder = useCallback(
    (order: readonly string[], activeWorkingDirs: readonly string[]) => {
      setManualProjectOrderState((prev) => {
        const next = normalizeManualProjectOrder(order, activeWorkingDirs);
        if (next.length === prev.length && next.every((wd, index) => wd === prev[index]))
          return prev;
        persistManualProjectOrder(next, ownerId);
        return next;
      });
    },
    [ownerId],
  );

  const setManualPinnedOrder = useCallback(
    (order: readonly string[], activeEntryIds: readonly string[], baseOrder: readonly string[]) =>
      updatePinnedOrder(
        () => normalizeManualPinnedOrder(order, activeEntryIds),
        (_latestOrder, nextOrder) => ({
          kind: 'reorder',
          baseOrder: Array.from(baseOrder),
          order: nextOrder,
        }),
      ),
    [updatePinnedOrder],
  );

  const promotePin = useCallback(
    (entryId: string) =>
      updatePinnedOrder(
        (prev) =>
          prev[0] === entryId
            ? Array.from(prev)
            : [entryId, ...prev.filter((id) => id !== entryId)],
        () => ({ kind: 'promote', entryId }),
      ),
    [updatePinnedOrder],
  );

  const removePin = useCallback(
    (entryId: string) =>
      updatePinnedOrder(
        (prev) => (prev.includes(entryId) ? prev.filter((id) => id !== entryId) : Array.from(prev)),
        () => ({ kind: 'remove', entryId }),
      ),
    [updatePinnedOrder],
  );

  const isSessionContentFiltered =
    status !== 'active' || projects !== 'all' || vendor !== 'all' || lastActivity !== 'all';

  const isFilterActive = isSessionContentFiltered || groupBy !== 'project' || sortBy !== 'recency';

  return {
    status,
    projects,
    projectsAsSet,
    isFilterActive,
    isSessionContentFiltered,
    vendor,
    lastActivity,
    groupBy,
    groupDialogue,
    groupDevice,
    sortBy,
    manualProjectOrder,
    manualPinnedOrder,
    setStatus,
    toggleProject,
    ensureProjectIncluded,
    setProjectsAll,
    gc,
    setVendor,
    setLastActivity,
    setGroupBy,
    setGroupDialogue,
    setGroupDevice,
    setSortBy,
    resetContentFilters,
    setManualProjectOrder,
    setManualPinnedOrder,
    promotePin,
    removePin,
  };
}
