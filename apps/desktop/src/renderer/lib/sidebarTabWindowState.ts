/**
 * sidebarTabWindowState —— 右侧栏单页签独立窗口状态的 renderer 端镜像。
 *
 * Source of truth 在 main(sidebar-tab-window/controller.ts):tabId → { sessionId, open },
 * 经 `maker:sidebar-tab-window:state-changed` 广播到所有窗口。这里只做内存镜像 +
 * useSyncExternalStore 订阅;不落盘,客户端重启后所有页签回到主窗。
 *
 * 消费方:RightSidebarShell(主窗 / 副窗侧栏把已弹出的页签从投影里隐藏)、
 * store(切到被弹出页签 = 聚焦其窗口;关掉被弹出页签 = 销毁其窗口)。
 * 弹出窗口自身不消费(它只认自己的指派)。
 *
 * 首帧走异步拉取而非 sendSync:弹出状态不跨重启,冷启动时镜像必然为空,不存在
 * 「先画出已弹出页签再消失」的跳变;运行期的变化全部由广播同步驱动。
 */

import { useSyncExternalStore } from 'react';

import type { SidebarTabWindowsState } from '../../shared/sidebarTabWindow';

const EMPTY_STATE: SidebarTabWindowsState = Object.freeze({}) as SidebarTabWindowsState;

let state: SidebarTabWindowsState = EMPTY_STATE;
const subscribers = new Set<() => void>();
let wired = false;
let bootstrapPromise: Promise<void> | null = null;

function setState(next: SidebarTabWindowsState): void {
  state = next ?? EMPTY_STATE;
  subscribers.forEach((cb) => cb());
}

/** 惰性绑定 main 广播(整个 renderer 只绑一次,fan-out 在 preload 层)并拉一次全量。 */
function ensureWired(): void {
  if (wired) return;
  wired = true;
  const api = typeof window !== 'undefined' ? window.electronAPI?.sidebarTabWindow : undefined;
  if (!api) return;
  // 无桥环境(jsdom 单测 / stub 不全)视同"没有任何弹出",不是错误。
  try {
    if (typeof api.onStateChanged === 'function') api.onStateChanged((next) => setState(next));
  } catch {
    // ignore
  }
  if (!bootstrapPromise && typeof api.getState === 'function') {
    try {
      bootstrapPromise = api
        .getState()
        .then((next) => setState(next))
        .catch(() => undefined);
    } catch {
      bootstrapPromise = null;
    }
  }
}

export function getSidebarTabWindowsState(): SidebarTabWindowsState {
  ensureWired();
  return state;
}

/** 该页签当前是否活在弹出窗口里(非 hook,store 等纯函数路径用)。 */
export function isTabPoppedOut(tabId: string): boolean {
  return getSidebarTabWindowsState()[tabId] !== undefined;
}

function subscribe(cb: () => void): () => void {
  ensureWired();
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

/** React hook:订阅全量镜像(引用变化 = 有广播)。 */
export function useSidebarTabWindowsState(): SidebarTabWindowsState {
  return useSyncExternalStore(subscribe, getSidebarTabWindowsState);
}

export interface SidebarTabWindowSummary {
  windowId: string;
  /** 窗口里任务页签所属任务;只有全局页签时为 null。 */
  sessionId: string | null;
  tabIds: string[];
}

/** 纯函数:按窗口归并镜像(tabId → 窗口)。页签顺序按镜像枚举序。 */
export function summarizeSidebarTabWindows(
  state: SidebarTabWindowsState,
): SidebarTabWindowSummary[] {
  const byWindow = new Map<string, SidebarTabWindowSummary>();
  for (const [tabId, entry] of Object.entries(state)) {
    let summary = byWindow.get(entry.windowId);
    if (!summary) {
      summary = { windowId: entry.windowId, sessionId: null, tabIds: [] };
      byWindow.set(entry.windowId, summary);
    }
    summary.tabIds.push(tabId);
    if (entry.sessionId !== null) summary.sessionId = entry.sessionId;
  }
  return [...byWindow.values()];
}

/** 仅测试用。 */
export function __setSidebarTabWindowsStateForTest(next: SidebarTabWindowsState): void {
  wired = true;
  setState(next);
}

/** 仅测试用。 */
export function __resetSidebarTabWindowsStateForTest(): void {
  state = EMPTY_STATE;
  subscribers.clear();
  wired = false;
  bootstrapPromise = null;
}
