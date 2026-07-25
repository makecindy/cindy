/**
 * ghostPanelWindowState —— 插件停靠面板独立窗口状态的 renderer 端镜像。
 *
 * Source of truth 在 main(ghost-panel-window/controller.ts + settings-store):
 * ghostId → { detached, lastOpen, open },经 `maker:ghost-panel-window:state-changed`
 * 广播到所有窗口。与 rightSidebarWindowState 的差异:
 *  - **首帧走 sendSync**(规则 7):LayoutRoot 第一帧就要知道哪些面板已抽离,
 *    异步拉取会先画停靠面板再消失(重启恢复场景闪一下);
 *  - 过滤谓词按 **detached** 而非 open:恢复期窗口还没建出来时面板同样不许
 *    在主窗停靠位出现。
 *
 * 消费方:LayoutRoot(抽离的 pane 不渲染)、GhostPanel(按钮态)、
 * GhostPanelWindowLayout(子窗自身)。
 */

import { useSyncExternalStore } from 'react';

import type { GhostPanelWindowsState } from '../../shared/ghostPanelWindow';
import { GHOST_PANEL_KIND_PREFIX } from '../../shared/ghost';

let state: GhostPanelWindowsState | null = null;
const subscribers = new Set<() => void>();
let wired = false;

function readInitial(): GhostPanelWindowsState {
  // 无桥环境(jsdom 单测 / stub 不全)视同"没有任何抽离",不是错误。
  try {
    const api = window.electronAPI?.ghostPanelWindow;
    if (!api) return {};
    return api.getStateSync() ?? {};
  } catch {
    return {};
  }
}

/** 惰性绑定 main 广播(整个 renderer 只绑一次,fan-out 在 preload 层)。 */
function ensureWired(): void {
  if (wired) return;
  wired = true;
  try {
    window.electronAPI?.ghostPanelWindow?.onStateChanged((s) => {
      state = s ?? {};
      subscribers.forEach((cb) => cb());
    });
  } catch {
    // 无桥环境:保持首读快照
  }
}

export function getGhostPanelWindowsState(): GhostPanelWindowsState {
  if (state === null) {
    state = readInitial();
    ensureWired();
  }
  return state;
}

function subscribe(cb: () => void): () => void {
  getGhostPanelWindowsState();
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

/**
 * 布局过滤谓词(非 hook,LayoutRoot 的纯函数路径用):该 panelKind 是否
 * 已抽离进独立窗口。非 ghost 面板恒 false。
 */
export function isGhostPanelKindDetached(panelKind: string): boolean {
  if (!panelKind.startsWith(GHOST_PANEL_KIND_PREFIX)) return false;
  const ghostId = panelKind.slice(GHOST_PANEL_KIND_PREFIX.length);
  return getGhostPanelWindowsState()[ghostId]?.detached === true;
}

/** React hook:订阅全量镜像(引用变化 = 有广播)。 */
export function useGhostPanelWindowsState(): GhostPanelWindowsState {
  return useSyncExternalStore(subscribe, getGhostPanelWindowsState);
}

/** 仅测试用。 */
export function __setGhostPanelWindowsStateForTest(next: GhostPanelWindowsState): void {
  state = next;
  subscribers.forEach((cb) => cb());
}

/** 仅测试用。 */
export function __resetGhostPanelWindowsStateForTest(): void {
  state = null;
  subscribers.clear();
  wired = false;
}
