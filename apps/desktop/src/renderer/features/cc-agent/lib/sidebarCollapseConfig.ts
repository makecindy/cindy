import { useSyncExternalStore } from 'react';
import { SESSION_LIST_COLLAPSE_MIN_VISIBLE_COUNT } from './sessionListCollapse';

/**
 * 侧栏列表折叠配置。项目内可从显示菜单调整默认条数；对话面板与外层项目列表
 * 仍使用各自的 localStorage override。折叠豁免与「显示全部」由列表自己处理。
 */

const PROJECT_SESSION_LIMIT_KEY = 'sidebar.collapse.projectSessionLimit';
const DIALOGUE_LIMIT_KEY = 'sidebar.collapse.dialogueLimit';
const PROJECT_LIMIT_KEY = 'sidebar.collapse.projectLimit';

/** 项目内会话列表默认展示条数。 */
export const DEFAULT_PROJECT_SESSION_COLLAPSE_LIMIT = SESSION_LIST_COLLAPSE_MIN_VISIBLE_COUNT;
/** 对话段默认上限。 */
export const DEFAULT_DIALOGUE_COLLAPSE_LIMIT = 10;
/** 项目列表默认上限。 */
export const DEFAULT_PROJECT_COLLAPSE_LIMIT = 20;

function readLimit(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  } catch {
    return fallback;
  }
}

const projectSessionLimitListeners = new Set<() => void>();
let projectSessionLimitSnapshot: number | undefined;

function getProjectSessionCollapseLimit(): number {
  return (
    projectSessionLimitSnapshot ??
    readLimit(PROJECT_SESSION_LIMIT_KEY, DEFAULT_PROJECT_SESSION_COLLAPSE_LIMIT)
  );
}

function setProjectSessionCollapseLimit(limit: number): void {
  projectSessionLimitSnapshot = limit;
  try {
    if (limit === DEFAULT_PROJECT_SESSION_COLLAPSE_LIMIT) {
      localStorage.removeItem(PROJECT_SESSION_LIMIT_KEY);
    } else {
      localStorage.setItem(PROJECT_SESSION_LIMIT_KEY, String(limit));
    }
  } catch {
    // The in-memory choice still applies while this sidebar is mounted.
  }
  projectSessionLimitListeners.forEach((listener) => listener());
}

function onProjectSessionLimitStorage(event: StorageEvent): void {
  if (event.key !== PROJECT_SESSION_LIMIT_KEY && event.key !== null) return;
  if (event.storageArea !== window.localStorage) return;
  projectSessionLimitSnapshot = readLimit(
    PROJECT_SESSION_LIMIT_KEY,
    DEFAULT_PROJECT_SESSION_COLLAPSE_LIMIT,
  );
  projectSessionLimitListeners.forEach((listener) => listener());
}

function subscribeToProjectSessionLimit(listener: () => void) {
  if (projectSessionLimitListeners.size === 0) {
    projectSessionLimitSnapshot = getProjectSessionCollapseLimit();
    window.addEventListener('storage', onProjectSessionLimitStorage);
  }
  projectSessionLimitListeners.add(listener);
  return () => {
    projectSessionLimitListeners.delete(listener);
    if (projectSessionLimitListeners.size === 0) {
      window.removeEventListener('storage', onProjectSessionLimitStorage);
      projectSessionLimitSnapshot = undefined;
    }
  };
}

export function useProjectSessionCollapseLimit() {
  return [
    useSyncExternalStore(subscribeToProjectSessionLimit, getProjectSessionCollapseLimit),
    setProjectSessionCollapseLimit,
  ] as const;
}

/** 对话段的折叠上限(默认 10,localStorage 'sidebar.collapse.dialogueLimit' 覆盖)。 */
export function getDialogueCollapseLimit(): number {
  return readLimit(DIALOGUE_LIMIT_KEY, DEFAULT_DIALOGUE_COLLAPSE_LIMIT);
}

/** 项目列表的折叠上限(默认 20,localStorage 'sidebar.collapse.projectLimit' 覆盖)。 */
export function getProjectCollapseLimit(): number {
  return readLimit(PROJECT_LIMIT_KEY, DEFAULT_PROJECT_COLLAPSE_LIMIT);
}
