/**
 * useAutomationGroupCollapsed — 侧边栏「自动化任务分组」的展开/收起持久化。
 * ---------------------------------------------------------------------------
 * 这是「轴 1 = 文件夹开/关」:收起 = 把该组下的所有运行藏起来,只留组头一行。
 * 它和组内「轴 2 = 前 5 条 / 显示全部」是两个完全独立的东西 —— 这里只管 disclosure。
 *
 * 折叠状态是**用户的明确选择,永久持久化、不按时间过期**:
 * - owner-scoped localStorage key derived from `cc-agent.sidebar.collapsedAutomationGroups`
 * - 默认收起(storage 里没有该组 = 收起);通常仅持久化"已展开"的组，设备 key 兼容旧偏好时
 *   可额外持久化显式收起覆盖
 * - 冷启动跟版本默认:没写过 override 的组一律收起,避免侧栏被自动任务刷满
 * - **不做定时 GC** —— 展开就一直展开,直到用户再收起,绝不"用了一阵自己弹开/收起"。
 *   删掉的定时任务会在本地留一条极小的孤儿记录(几十字节),量可忽略,不值得为清它引入
 *   "按时间删"从而误删活跃分组的风险(这正是早先 30 天 GC 会把活跃分组弹开的根因)。
 *
 * 历史兼容:旧版默认展开、只持久化 `collapsed: true`。这类条目仍按「已收起」读;
 * 未写过条目的组不再被猜成「用户想展开」,而是跟随本版默认收起。
 *
 * 普通分组组件各自持有 collapsed 状态；平铺列表的段头批量操作由 ProjectsSection
 * 持有受控投影，再把同一份状态传给组行。两种入口都复用这里的持久化函数。
 */

import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import { createLogger } from '@/lib/logger';
import { readSidebarOwnerStorage, writeSidebarOwnerStorage } from '@/lib/sidebarOwnerStorage';

const log = createLogger('UseAutomationGroupCollapsed');

const STORAGE_KEY = 'cc-agent.sidebar.collapsedAutomationGroups';

interface StoredEntry {
  /**
   * 通常只持久化已展开(false)。设备分组继承旧展开偏好后，true 也可作为设备级显式覆盖，
   * 防止删除设备 key 后再次被旧 key 展开。
   */
  collapsed: boolean;
  /** ISO 8601 — 上次写入时间(仅留作排查/未来用,不参与任何过期判定)。 */
  lastSeenAt: string;
}

type Stored = Record<string, StoredEntry>;

function loadStored(ownerId: string | null): Stored {
  try {
    const raw = readSidebarOwnerStorage(STORAGE_KEY, ownerId);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Stored = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (value && typeof value === 'object') {
          const entry = value as Partial<StoredEntry>;
          if (typeof entry.collapsed === 'boolean' && typeof entry.lastSeenAt === 'string') {
            out[key] = { collapsed: entry.collapsed, lastSeenAt: entry.lastSeenAt };
          }
        }
      }
      return out;
    }
    return {};
  } catch (err) {
    // JSON parse / localStorage 异常(含 node 测试环境无 localStorage)→ 静默回退
    log.warn('failed to load stored state:', err);
    return {};
  }
}

function writeStored(next: Stored, ownerId: string | null): void {
  if (!writeSidebarOwnerStorage(STORAGE_KEY, ownerId, JSON.stringify(next))) {
    log.warn('failed to write stored state');
  }
}

function isEntryCollapsed(entry: StoredEntry | undefined): boolean {
  return entry ? entry.collapsed : true;
}

function resolveStoredEntry(
  stored: Stored,
  groupKey: string,
  legacyGroupKey?: string,
): { entry: StoredEntry | undefined; migrated: boolean } {
  const entry = stored[groupKey];
  if (entry || !legacyGroupKey) return { entry, migrated: false };
  const legacyEntry = stored[legacyGroupKey];
  if (!legacyEntry) return { entry: undefined, migrated: false };
  stored[groupKey] = { ...legacyEntry };
  return { entry: stored[groupKey], migrated: true };
}

/** 读取某个分组当前是否收起(默认 true = 收起)。 */
export function isAutomationGroupCollapsed(
  groupKey: string,
  ownerId: string | null,
  legacyGroupKey?: string,
): boolean {
  const stored = loadStored(ownerId);
  const resolved = resolveStoredEntry(stored, groupKey, legacyGroupKey);
  if (resolved.migrated) writeStored(stored, ownerId);
  return isEntryCollapsed(resolved.entry);
}

/** 写入某个分组的收起态:展开则记一条条目,收起则删除该 key(默认值跟随版本)。 */
export function setAutomationGroupCollapsed(
  groupKey: string,
  collapsed: boolean,
  ownerId: string | null,
  legacyGroupKey?: string,
): void {
  setAutomationGroupsCollapsed(
    [groupKey],
    collapsed,
    ownerId,
    legacyGroupKey ? new Map([[groupKey, legacyGroupKey]]) : undefined,
  );
}

/** 批量写入可见自动任务组的收起态，只落一次 storage。 */
export function setAutomationGroupsCollapsed(
  groupKeys: readonly string[],
  collapsed: boolean,
  ownerId: string | null,
  legacyGroupKeys?: ReadonlyMap<string, string>,
): void {
  if (groupKeys.length === 0) return;
  const stored = loadStored(ownerId);
  const lastSeenAt = new Date().toISOString();
  let changed = false;
  for (const groupKey of groupKeys) {
    const legacyGroupKey = legacyGroupKeys?.get(groupKey);
    const resolved = resolveStoredEntry(stored, groupKey, legacyGroupKey);
    if (resolved.migrated) changed = true;
    if (collapsed && legacyGroupKey) {
      // 设备 scoped key 必须保留显式收起覆盖：旧 key 既可能当前不存在，也仍会被本机组
      // 后续写成展开。只靠删除设备 key 回落默认值，会让远程组被未来的旧 key 重新展开。
      if (stored[groupKey]?.collapsed !== true) {
        stored[groupKey] = { collapsed: true, lastSeenAt };
        changed = true;
      }
      continue;
    }
    const wasCollapsed = isEntryCollapsed(resolved.entry);
    if (wasCollapsed === collapsed) continue;
    changed = true;
    if (collapsed) {
      delete stored[groupKey];
    } else {
      stored[groupKey] = { collapsed: false, lastSeenAt };
    }
  }
  if (changed) writeStored(stored, ownerId);
}

/**
 * 组件侧 hook:返回 [collapsed, toggle]。collapsed 由 localStorage 初始化(默认收起),
 * 并在 owner / group 边界变化时重新绑定；toggle 只写入创建它时对应的当前 binding。
 */
export function useAutomationGroupCollapsed(
  groupKey: string,
  legacyGroupKey?: string,
): readonly [boolean, () => void] {
  const { dataOwnerId: ownerId, generation: ownerGeneration } = getDataOwnerGeneration();
  const [collapsed, setCollapsedState] = useState(() =>
    isAutomationGroupCollapsed(groupKey, ownerId, legacyGroupKey),
  );
  const committedBindingRef = useRef({ groupKey, legacyGroupKey, ownerId });

  // AuthContext 先同步发布 data owner，再触发 React 重渲染。layout effect 在浏览器绘制前
  // 装载新 binding，避免短暂展示上一账号或上一分组的折叠态。
  useLayoutEffect(() => {
    const committedBinding = committedBindingRef.current;
    if (
      committedBinding.groupKey === groupKey &&
      committedBinding.legacyGroupKey === legacyGroupKey &&
      committedBinding.ownerId === ownerId
    ) {
      return;
    }
    committedBindingRef.current = { groupKey, legacyGroupKey, ownerId };
    setCollapsedState(isAutomationGroupCollapsed(groupKey, ownerId, legacyGroupKey));
  }, [groupKey, legacyGroupKey, ownerId]);

  const toggle = useCallback(() => {
    const ownerAtRender = { dataOwnerId: ownerId, generation: ownerGeneration };
    const isCurrentBinding = (): boolean => {
      const currentBinding = committedBindingRef.current;
      return (
        currentBinding.groupKey === groupKey &&
        currentBinding.legacyGroupKey === legacyGroupKey &&
        currentBinding.ownerId === ownerId &&
        isDataOwnerGenerationCurrent(ownerAtRender)
      );
    };
    // Owner generation is published synchronously before React rerenders. Reject an old callback
    // even during that boundary window, then check again inside the state updater.
    if (!isCurrentBinding()) return;
    setCollapsedState((prev) => {
      if (!isCurrentBinding()) return prev;
      const next = !prev;
      setAutomationGroupCollapsed(groupKey, next, ownerId, legacyGroupKey);
      return next;
    });
  }, [groupKey, legacyGroupKey, ownerGeneration, ownerId]);
  return [collapsed, toggle] as const;
}

/**
 * 平铺列表段头使用的受控投影。状态留在 ProjectsSection 生命周期内，因此 storage
 * 暂时不可写时，组行即使因筛选或「显示全部」卸载再挂载，也会继续读取本次明确操作。
 * 这不是跨页面缓存；owner 代次或展示模式变化时整份投影会在绘制前清空并重新回落到
 * 持久化值，避免其它渲染路径写入后仍被旧内存值覆盖。
 */
export function useAutomationGroupsCollapsed(
  groupKeys: readonly string[],
  projectionScope: string,
  legacyGroupKeys?: ReadonlyMap<string, string>,
): readonly [
  boolean,
  (collapsed: boolean) => void,
  (groupKey: string) => boolean,
  (groupKey: string, collapsed: boolean) => void,
] {
  const { dataOwnerId: ownerId, generation: ownerGeneration } = getDataOwnerGeneration();
  const [memoryCollapsedByGroup, setMemoryCollapsedByGroup] = useState<Record<string, boolean>>({});

  useLayoutEffect(() => {
    setMemoryCollapsedByGroup({});
  }, [ownerGeneration, ownerId, projectionScope]);

  const isCollapsed = useCallback(
    (groupKey: string): boolean => {
      const memoryCollapsed = memoryCollapsedByGroup[groupKey];
      return typeof memoryCollapsed === 'boolean'
        ? memoryCollapsed
        : isAutomationGroupCollapsed(groupKey, ownerId, legacyGroupKeys?.get(groupKey));
    },
    [legacyGroupKeys, memoryCollapsedByGroup, ownerId],
  );
  const allCollapsed = groupKeys.every(isCollapsed);
  const setAllCollapsed = useCallback(
    (collapsed: boolean) => {
      const ownerAtRender = { dataOwnerId: ownerId, generation: ownerGeneration };
      if (!isDataOwnerGenerationCurrent(ownerAtRender)) return;
      setMemoryCollapsedByGroup((current) => {
        const next = { ...current };
        for (const groupKey of groupKeys) next[groupKey] = collapsed;
        return next;
      });
      setAutomationGroupsCollapsed(groupKeys, collapsed, ownerId, legacyGroupKeys);
    },
    [groupKeys, legacyGroupKeys, ownerGeneration, ownerId],
  );
  const setCollapsed = useCallback(
    (groupKey: string, collapsed: boolean) => {
      const ownerAtRender = { dataOwnerId: ownerId, generation: ownerGeneration };
      if (!isDataOwnerGenerationCurrent(ownerAtRender)) return;
      setMemoryCollapsedByGroup((current) => ({ ...current, [groupKey]: collapsed }));
      setAutomationGroupCollapsed(groupKey, collapsed, ownerId, legacyGroupKeys?.get(groupKey));
    },
    [legacyGroupKeys, ownerGeneration, ownerId],
  );
  return [allCollapsed, setAllCollapsed, isCollapsed, setCollapsed] as const;
}
