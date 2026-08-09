/**
 * useCollapsedProjects — Sidebar Project 折叠状态管理
 * ---------------------------------------------------------------------------
 * - owner-scoped localStorage key derived from `cc-agent.sidebar.collapsedProjects`
 * - 默认展开（无条目 = 展开）；仅持久化已折叠项
 * - mount 时执行一次 30 天 GC（清理 lastSeenAt 过期且不在当前 active 集合的项）
 *
 * API:
 *   collapsed         Set<string> — 当前所有折叠的 workingDir
 *   toggle(dir)       折叠/展开单项
 *   collapseAll()     把 activeWorkingDirs 全部塞入折叠集
 *   expandAll()       把 activeWorkingDirs 从折叠集移除
 *   isAllCollapsed    activeWorkingDirs 是否全部都折叠
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createLogger } from '@/lib/logger';
import { readSidebarOwnerStorage, writeSidebarOwnerStorage } from '@/lib/sidebarOwnerStorage';
import { normalizeProjectKey } from '../lib/projectGrouping';

const log = createLogger('UseCollapsedProjects');

const STORAGE_KEY = 'cc-agent.sidebar.collapsedProjects';
const GC_DAYS = 30;
const GC_MS = GC_DAYS * 24 * 60 * 60 * 1000;

interface StoredEntry {
  /** 标记折叠态——只存折叠项，展开项从 stored 中删除 */
  collapsed: true;
  /** ISO 8601 — 上次写入时间，用于 GC 判定 */
  lastSeenAt: string;
}

type Stored = Record<string, StoredEntry>;

interface UseCollapsedProjectsReturn {
  collapsed: Set<string>;
  toggle: (projectKeyOrWorkingDir: string) => void;
  /** 幂等展开单项：已展开则 no-op。用于"新 session 进折叠 Project 时自动展开"等场景。 */
  expand: (projectKeyOrWorkingDir: string) => void;
  setCollapsed: (projectKeyOrWorkingDir: string, collapsed: boolean) => void;
  collapseAll: () => void;
  expandAll: () => void;
  isAllCollapsed: boolean;
}

function loadFromStorage(ownerId: string | null): Stored {
  try {
    const raw = readSidebarOwnerStorage(STORAGE_KEY, ownerId);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      // 浅校验：保留具有 collapsed=true 的条目
      const out: Stored = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (v && typeof v === 'object') {
          const entry = v as Partial<StoredEntry>;
          if (entry.collapsed === true && typeof entry.lastSeenAt === 'string') {
            const projectKey = normalizeProjectKey(k);
            if (projectKey) {
              out[projectKey] = { collapsed: true, lastSeenAt: entry.lastSeenAt };
            }
          }
        }
      }
      return out;
    }
    return {};
  } catch (err) {
    // JSON parse / localStorage 异常 → 静默回退
    log.warn('failed to load stored state:', err);
    return {};
  }
}

function writeToStorage(next: Stored, ownerId: string | null): void {
  if (!writeSidebarOwnerStorage(STORAGE_KEY, ownerId, JSON.stringify(next))) {
    log.warn('failed to write stored state');
  }
}

export function useCollapsedProjects(
  activeWorkingDirs: readonly string[],
  ownerId: string | null,
): UseCollapsedProjectsReturn {
  const [stored, setStored] = useState<Stored>(() => loadFromStorage(ownerId));

  // 用 ref 镜像最新的 activeWorkingDirs，让 toggle/collapseAll/expandAll 都能
  // 走"依赖空数组 + 闭包内读 ref.current"的统一模式，避免在 activeWorkingDirs
  // 引用变化时反复重建回调（统一策略，见 reviewer Minor #2）。
  const activeDirsRef = useRef<readonly string[]>(activeWorkingDirs);
  activeDirsRef.current = activeWorkingDirs;

  // mount / owner switch 时 GC：清理 lastSeenAt 过期且不在 active 集合的条目
  // ADR-4：useEffect 内部通过 activeDirsRef 读取最新值；依赖空数组属于
  // "故意只跑一次"。
  useEffect(() => {
    const cutoff = Date.now() - GC_MS;
    const activeSet = new Set(activeDirsRef.current);
    setStored((prev) => {
      const next: Stored = {};
      let changed = false;
      for (const [dir, entry] of Object.entries(prev)) {
        const lastSeen = new Date(entry.lastSeenAt).getTime();
        const fresh = Number.isFinite(lastSeen) && lastSeen >= cutoff;
        if (fresh || activeSet.has(dir)) {
          next[dir] = entry;
        } else {
          changed = true;
        }
      }
      if (changed) {
        writeToStorage(next, ownerId);
        return next;
      }
      return prev;
    });
  }, [ownerId]);

  const collapsed = useMemo(() => new Set(Object.keys(stored)), [stored]);

  // Callback identity changes only at an owner boundary.
  const toggle = useCallback(
    (projectKeyOrWorkingDir: string) => {
      const projectKey = normalizeProjectKey(projectKeyOrWorkingDir);
      if (!projectKey) return;
      setStored((prev) => {
        const next: Stored = { ...prev };
        if (next[projectKey]) {
          delete next[projectKey];
        } else {
          next[projectKey] = { collapsed: true, lastSeenAt: new Date().toISOString() };
        }
        writeToStorage(next, ownerId);
        return next;
      });
    },
    [ownerId],
  );

  // 幂等展开：仅当目标目录当前在折叠集中时才写入，避免无意义的 setState/写盘。
  const expand = useCallback(
    (projectKeyOrWorkingDir: string) => {
      const projectKey = normalizeProjectKey(projectKeyOrWorkingDir);
      if (!projectKey) return;
      setStored((prev) => {
        if (!prev[projectKey]) return prev;
        const next: Stored = { ...prev };
        delete next[projectKey];
        writeToStorage(next, ownerId);
        return next;
      });
    },
    [ownerId],
  );

  const setCollapsed = useCallback(
    (projectKeyOrWorkingDir: string, nextCollapsed: boolean) => {
      const projectKey = normalizeProjectKey(projectKeyOrWorkingDir);
      if (!projectKey) return;
      setStored((prev) => {
        const isCollapsed = Boolean(prev[projectKey]);
        if (isCollapsed === nextCollapsed) return prev;
        const next: Stored = { ...prev };
        if (nextCollapsed) {
          next[projectKey] = { collapsed: true, lastSeenAt: new Date().toISOString() };
        } else {
          delete next[projectKey];
        }
        writeToStorage(next, ownerId);
        return next;
      });
    },
    [ownerId],
  );

  // collapseAll/expandAll read the latest activeWorkingDirs through the ref;
  // callback identity changes only at an owner boundary.
  const collapseAll = useCallback(() => {
    setStored((prev) => {
      const now = new Date().toISOString();
      const next: Stored = { ...prev };
      for (const dir of activeDirsRef.current) {
        const projectKey = normalizeProjectKey(dir);
        if (!projectKey) continue;
        next[projectKey] = { collapsed: true, lastSeenAt: now };
      }
      writeToStorage(next, ownerId);
      return next;
    });
  }, [ownerId]);

  const expandAll = useCallback(() => {
    setStored((prev) => {
      const next: Stored = { ...prev };
      for (const dir of activeDirsRef.current) {
        const projectKey = normalizeProjectKey(dir);
        if (!projectKey) continue;
        delete next[projectKey];
      }
      writeToStorage(next, ownerId);
      return next;
    });
  }, [ownerId]);

  const isAllCollapsed = useMemo(
    () =>
      activeWorkingDirs.length > 0 &&
      activeWorkingDirs.every((d) => {
        const projectKey = normalizeProjectKey(d);
        return projectKey ? collapsed.has(projectKey) : false;
      }),
    [activeWorkingDirs, collapsed],
  );

  return { collapsed, toggle, expand, setCollapsed, collapseAll, expandAll, isAllCollapsed };
}
