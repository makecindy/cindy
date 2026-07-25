/**
 * 插件停靠面板独立窗口(ghost panel window)的跨进程共享类型。
 *
 * 三方共用:main(controller / IPC handler)、preload(桥接签名)、renderer
 * (主窗镜像 store + 子窗口根组件)。只放纯类型,不放运行时代码。
 * 语义对照 shared/rightSidebarWindow.ts 的 RsbWindowState,差异是按 ghostId
 * 多实例(每个插件至多一扇窗)。
 */

/** 单个插件窗口状态:detached 是持久化偏好,lastOpen 供重启恢复,open 是运行时开闭。 */
export interface GhostPanelWindowEntryState {
  /** 偏好:「该插件面板在独立窗口中显示」。持久化,default false。 */
  detached: boolean;
  /** 状态:上次退出时窗口是否处于打开态(供重启恢复)。持久化。 */
  lastOpen: boolean;
  /** 运行时:子窗口当前是否存在。不持久化。 */
  open: boolean;
}

/** 全量状态:ghostId → 窗口状态。没有条目 = 从未抽离(等价三 false)。 */
export type GhostPanelWindowsState = Record<string, GhostPanelWindowEntryState>;
