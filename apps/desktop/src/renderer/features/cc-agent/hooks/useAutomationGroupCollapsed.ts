/**
 * useAutomationGroupCollapsed — 侧边栏「自动化任务分组」的展开/收起持久化。
 * ---------------------------------------------------------------------------
 * 这是「轴 1 = 文件夹开/关」:收起 = 把该组下的所有运行藏起来,只留组头一行。
 * 它和组内「轴 2 = 前 5 条 / 显示全部」是两个完全独立的东西 —— 这里只管 disclosure。
 *
 * 折叠状态是**用户的明确选择,永久持久化、不按时间过期**:
 * - owner-scoped localStorage key derived from `cc-agent.sidebar.collapsedAutomationGroups`
 * - 默认收起(storage 里没有该组 = 收起);仅持久化"已展开"的组
 * - 冷启动跟版本默认:没写过 override 的组一律收起,避免侧栏被自动任务刷满
 * - **不做定时 GC** —— 展开就一直展开,直到用户再收起,绝不"用了一阵自己弹开/收起"。
 *   删掉的定时任务会在本地留一条极小的孤儿记录(几十字节),量可忽略,不值得为清它引入
 *   "按时间删"从而误删活跃分组的风险(这正是早先 30 天 GC 会把活跃分组弹开的根因)。
 *
 * 历史兼容:旧版默认展开、只持久化 `collapsed: true`。这类条目仍按「已收起」读;
 * 未写过条目的组不再被猜成「用户想展开」,而是跟随本版默认收起。
 *
 * 每个分组组件各自持有自己的 collapsed 状态(useState),toggle 时对 localStorage 做
 * "读-改-写、只动自己这个 key"。JS 单线程下读改写不可被打断,不同组各写各的 key,不存在
 * 丢更新;跨实例无需同步(一个组的开/关只由它自己的箭头触发)。
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
  /** 当前版本只持久化已展开(false);旧版写入的 true 仍表示已收起。 */
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

/** 读取某个分组当前是否收起(默认 true = 收起)。 */
export function isAutomationGroupCollapsed(groupKey: string, ownerId: string | null): boolean {
  return isEntryCollapsed(loadStored(ownerId)[groupKey]);
}

/** 写入某个分组的收起态:展开则记一条条目,收起则删除该 key(默认值跟随版本)。 */
export function setAutomationGroupCollapsed(
  groupKey: string,
  collapsed: boolean,
  ownerId: string | null,
): void {
  const stored = loadStored(ownerId);
  const wasCollapsed = isEntryCollapsed(stored[groupKey]);
  if (wasCollapsed === collapsed) return;
  if (collapsed) {
    delete stored[groupKey];
  } else {
    stored[groupKey] = { collapsed: false, lastSeenAt: new Date().toISOString() };
  }
  writeStored(stored, ownerId);
}

/**
 * 组件侧 hook:返回 [collapsed, toggle]。collapsed 由 localStorage 初始化(默认收起),
 * 并在 owner / group 边界变化时重新绑定；toggle 只写入创建它时对应的当前 binding。
 */
export function useAutomationGroupCollapsed(groupKey: string): readonly [boolean, () => void] {
  const { dataOwnerId: ownerId, generation: ownerGeneration } = getDataOwnerGeneration();
  const [collapsed, setCollapsedState] = useState(() =>
    isAutomationGroupCollapsed(groupKey, ownerId),
  );
  const committedBindingRef = useRef({ groupKey, ownerId });

  // AuthContext 先同步发布 data owner，再触发 React 重渲染。layout effect 在浏览器绘制前
  // 装载新 binding，避免短暂展示上一账号或上一分组的折叠态。
  useLayoutEffect(() => {
    const committedBinding = committedBindingRef.current;
    if (committedBinding.groupKey === groupKey && committedBinding.ownerId === ownerId) return;
    committedBindingRef.current = { groupKey, ownerId };
    setCollapsedState(isAutomationGroupCollapsed(groupKey, ownerId));
  }, [groupKey, ownerId]);

  const toggle = useCallback(() => {
    const ownerAtRender = { dataOwnerId: ownerId, generation: ownerGeneration };
    const isCurrentBinding = (): boolean => {
      const currentBinding = committedBindingRef.current;
      return (
        currentBinding.groupKey === groupKey &&
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
      setAutomationGroupCollapsed(groupKey, next, ownerId);
      return next;
    });
  }, [groupKey, ownerGeneration, ownerId]);
  return [collapsed, toggle] as const;
}
