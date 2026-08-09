/**
 * useAutomationGroupCollapsed — 侧边栏「自动化任务分组」的展开/收起持久化。
 * ---------------------------------------------------------------------------
 * 这是「轴 1 = 文件夹开/关」:收起 = 把该组下的所有运行藏起来,只留组头一行。
 * 它和组内「轴 2 = 前 5 条 / 显示全部」是两个完全独立的东西 —— 这里只管 disclosure。
 *
 * 折叠状态是**用户的明确选择,永久持久化、不按时间过期**:
 * - owner-scoped localStorage key derived from `cc-agent.sidebar.collapsedAutomationGroups`
 * - 默认展开(storage 里没有该组 = 展开);仅持久化"已收起"的组
 * - **不做定时 GC** —— 收起就一直收起,直到用户再展开,绝不"用了一阵自己弹开"。
 *   删掉的定时任务会在本地留一条极小的孤儿记录(几十字节),量可忽略,不值得为清它引入
 *   "按时间删"从而误删活跃分组的风险(这正是早先 30 天 GC 会把活跃分组弹开的根因)。
 *
 * 每个分组组件各自持有自己的 collapsed 状态(useState),toggle 时对 localStorage 做
 * "读-改-写、只动自己这个 key"。JS 单线程下读改写不可被打断,不同组各写各的 key,不存在
 * 丢更新;跨实例无需同步(一个组的开/关只由它自己的箭头触发)。
 */

import { useCallback, useState } from 'react';
import { getDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { createLogger } from '@/lib/logger';
import { readSidebarOwnerStorage, writeSidebarOwnerStorage } from '@/lib/sidebarOwnerStorage';

const log = createLogger('UseAutomationGroupCollapsed');

const STORAGE_KEY = 'cc-agent.sidebar.collapsedAutomationGroups';

interface StoredEntry {
  /** 只存"已收起"的组,展开的组从 stored 中删除。 */
  collapsed: true;
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
          if (entry.collapsed === true && typeof entry.lastSeenAt === 'string') {
            out[key] = { collapsed: true, lastSeenAt: entry.lastSeenAt };
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

/** 读取某个分组当前是否收起(默认 false = 展开)。 */
export function isAutomationGroupCollapsed(groupKey: string, ownerId: string | null): boolean {
  return Boolean(loadStored(ownerId)[groupKey]);
}

/** 写入某个分组的收起态:收起则记一条条目,展开则删除该 key(默认值跟随版本)。 */
export function setAutomationGroupCollapsed(
  groupKey: string,
  collapsed: boolean,
  ownerId: string | null,
): void {
  const stored = loadStored(ownerId);
  const wasCollapsed = Boolean(stored[groupKey]);
  if (wasCollapsed === collapsed) return;
  if (collapsed) {
    stored[groupKey] = { collapsed: true, lastSeenAt: new Date().toISOString() };
  } else {
    delete stored[groupKey];
  }
  writeStored(stored, ownerId);
}

/**
 * 组件侧 hook:返回 [collapsed, toggle]。collapsed 由 localStorage 初始化(默认展开),
 * toggle 翻转并持久化。组件以 group.id 作为 key 渲染,故 groupKey 在实例生命周期内稳定。
 */
export function useAutomationGroupCollapsed(groupKey: string): readonly [boolean, () => void] {
  const ownerId = getDataOwnerGeneration().dataOwnerId;
  const [collapsed, setCollapsedState] = useState(() =>
    isAutomationGroupCollapsed(groupKey, ownerId),
  );
  const toggle = useCallback(() => {
    setCollapsedState((prev) => {
      const next = !prev;
      setAutomationGroupCollapsed(groupKey, next, ownerId);
      return next;
    });
  }, [groupKey, ownerId]);
  return [collapsed, toggle] as const;
}
