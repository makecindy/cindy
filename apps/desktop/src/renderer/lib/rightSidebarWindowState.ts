/**
 * rightSidebarWindowState —— 「侧边栏在新窗口中显示」状态的 renderer 端镜像。
 *
 * Source of truth 在 main(right-sidebar-window/controller.ts + settings-store):
 *   - detached: 当前进程内的分离状态
 *   - open:     子窗口运行时开闭
 * 两者都经 `maker:rsb-window:state-changed` 广播到所有窗口,这里只做内存镜像 +
 * useSyncExternalStore 订阅；两者都不落 localStorage，客户端重启后回到主窗口。
 *
 * MainLayout 用它决定:内嵌右侧栏是否渲染、展开按钮的语义(内嵌展开 vs 开子窗口)。
 */

import { useSyncExternalStore } from 'react';
import { isSecondaryWindow } from './secondaryWindow';

export interface RsbWindowUiState {
  loaded: boolean;
  detached: boolean;
  open: boolean;
  hostSessionId?: string | null;
  userClose?: boolean;
}

function initialState(): RsbWindowUiState {
  // 会话副窗拥有自己的内嵌 RSB，永远不参与主窗的全局 detached 偏好。
  return isSecondaryWindow()
    ? { loaded: true, detached: false, open: false }
    : { loaded: false, detached: false, open: false };
}

let state: RsbWindowUiState = initialState();
const subscribers = new Set<() => void>();
let wired = false;
let bootstrapPromise: Promise<{
  detached: boolean;
  lastOpen: boolean;
  open: boolean;
} | null> | null = null;

function setState(next: RsbWindowUiState): void {
  if (
    state.loaded === next.loaded &&
    state.detached === next.detached &&
    state.open === next.open &&
    state.hostSessionId === next.hostSessionId &&
    state.userClose === next.userClose
  ) {
    return;
  }
  state = next;
  subscribers.forEach((cb) => cb());
}

/** 惰性绑定 main 的状态广播(整个 renderer 只绑一次,fan-out 在 preload 层)。 */
function ensureWired(): void {
  if (wired || isSecondaryWindow()) return;
  wired = true;
  window.electronAPI?.rightSidebarWindow?.onStateChanged((s) => {
    setState({
      loaded: true,
      detached: s.detached,
      open: s.open,
      ...(s.hostSessionId ? { hostSessionId: s.hostSessionId } : {}),
      ...(s.userClose === false ? { userClose: false } : {}),
    });
  });
}

export function getRsbWindowUiState(): RsbWindowUiState {
  return state;
}

export function subscribeRsbWindowUiState(cb: () => void): () => void {
  ensureWired();
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

/**
 * 启动期从 main 拉全量当前进程 state。
 * 失败兜底:静默,保持默认 { detached:false, open:false }(等广播纠正)。
 */
export async function bootstrapRsbWindowState(): Promise<{
  detached: boolean;
  lastOpen: boolean;
  open: boolean;
} | null> {
  if (isSecondaryWindow()) {
    const attached = { detached: false, lastOpen: false, open: false };
    setState({ loaded: true, detached: false, open: false });
    return attached;
  }
  ensureWired();
  if (!bootstrapPromise) {
    bootstrapPromise = (async () => {
      try {
        const s = await window.electronAPI.rightSidebarWindow.getState();
        setState({
          loaded: true,
          detached: s.detached,
          open: s.open,
          ...(s.hostSessionId ? { hostSessionId: s.hostSessionId } : {}),
        });
        return s;
      } catch {
        // IPC 异常时明确落到 attached fallback，避免整个会话期永久卡在 unknown。
        setState({ loaded: true, detached: false, open: false });
        return null;
      }
    })();
  }
  return bootstrapPromise;
}

/** tab/open 动作在决定写本 renderer store 还是转发 detached 子窗前必须 await。 */
export async function ensureRsbWindowStateLoaded(): Promise<RsbWindowUiState> {
  if (state.loaded) return state;
  await bootstrapRsbWindowState();
  return state;
}

/** React hook:订阅 { detached, open } 镜像。 */
export function useRightSidebarWindowState(): RsbWindowUiState {
  return useSyncExternalStore(subscribeRsbWindowUiState, getRsbWindowUiState);
}

export function _resetRsbWindowStateForTests(): void {
  state = initialState();
  bootstrapPromise = null;
  subscribers.clear();
  wired = false;
}
