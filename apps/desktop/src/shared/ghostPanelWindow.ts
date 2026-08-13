/**
 * 插件停靠面板独立窗口(ghost panel window)的跨进程共享类型。
 *
 * 三方共用:main(controller / IPC handler)、preload(桥接签名)、renderer
 * (主窗镜像 store + 子窗口根组件)。只放纯类型,不放运行时代码。
 * 语义对照 shared/rightSidebarWindow.ts 的 RsbWindowState,差异是按 ghostId
 * 多实例(每个插件至多一扇窗)。
 */

/** 单个插件窗口状态：均仅在当前进程有效；重启后 detached / lastOpen 重置。 */
export interface GhostPanelWindowEntryState {
  /** 当前运行期是否在独立窗口中显示。 */
  detached: boolean;
  /** 当前运行期是否曾请求保持窗口打开；不跨客户端重启。 */
  lastOpen: boolean;
  /** 运行时:子窗口当前是否存在。不持久化。 */
  open: boolean;
}

/** 全量状态:ghostId → 窗口状态。没有条目 = 从未抽离(等价三 false)。 */
export type GhostPanelWindowsState = Record<string, GhostPanelWindowEntryState>;

// ── 预热/就绪/隐藏复用 IPC channel 常量 ──────────────────────────────
/** renderer → main(invoke)：窗口根组件已挂载(React shell 可展示)。 */
export const GHOST_PANEL_WINDOW_RENDERER_READY_CHANNEL = 'ghost-panel-window:renderer-ready';
/** renderer → main(invoke)：首份面板内容已提交(至少空态/错误态可渲染)。 */
export const GHOST_PANEL_WINDOW_PRESENTATION_READY_CHANNEL =
  'ghost-panel-window:presentation-ready';
/** main → renderer(send)：隐藏/显示时通知子窗口刷新面板 + 重置瞬时交互态。 */
export const GHOST_PANEL_WINDOW_VISIBILITY_CHANGED_CHANNEL =
  'ghost-panel-window:visibility-changed';
export const GHOST_PANEL_WINDOW_CLOSE_REQUESTED_CHANNEL =
  'ghost-panel-window:close-requested';
/** main → renderer(send)：原生窗口最小化也统一收进主窗口 Ghost 气泡。 */
export const GHOST_PANEL_WINDOW_MINIMIZE_REQUESTED_CHANNEL =
  'ghost-panel-window:minimize-requested';
export const GHOST_PANEL_WINDOW_CLOSE_REQUEST_RESOLVED_CHANNEL =
  'ghost-panel-window:close-request-resolved';
export const GHOST_PANEL_WINDOW_LOCALE_CHANGED_CHANNEL = 'ghost-panel-window:locale-changed';
