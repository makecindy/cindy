/**
 * 桌面浮窗(ghost overlay window)的跨进程共享类型与 IPC channel 常量。
 *
 * 三方共用:main(window 工厂 / controller / IPC handler)、preload(桥接签名)、
 * renderer(浮窗根组件 + 主窗镜像 store)。只放纯类型与常量,不放运行时代码。
 * 语义对照 shared/ghostPanelWindow.ts:按 ghostId 多实例,一段意识至多一扇浮窗。
 */

/** 单个浮窗的运行期状态:仅在当前进程有效,重启后重置。 */
export interface GhostOverlayWindowEntryState {
  /** 浮窗是否已创建(main 侧窗口工厂已跑完)。 */
  mounted: boolean;
  /** 浮窗当前是否可见(隐藏 = 仍挂载,只是不绘制)。 */
  visible: boolean;
  /** 浮窗是否处于可交互态(穿透关闭时用户可点按)。 */
  interactive: boolean;
}

/** 全量状态:ghostId → 浮窗状态。没有条目 = 从未创建(等价三 false)。 */
export type GhostOverlayWindowsState = Record<string, GhostOverlayWindowEntryState>;

// ── 就绪/可见性 IPC channel 常量 ──────────────────────────────────────
/** renderer → main(invoke)：浮窗根组件已挂载(可安全接收展示指令)。 */
export const GHOST_OVERLAY_WINDOW_RENDERER_READY_CHANNEL =
  'ghost-overlay-window:renderer-ready';
/** renderer → main(invoke)：首份浮窗内容已提交(至少空态/错误态可渲染)。 */
export const GHOST_OVERLAY_WINDOW_PRESENTATION_READY_CHANNEL =
  'ghost-overlay-window:presentation-ready';
/** main → renderer(send)：隐藏/显示时通知浮窗刷新并重置瞬时交互态。 */
export const GHOST_OVERLAY_WINDOW_VISIBILITY_CHANGED_CHANNEL =
  'ghost-overlay-window:visibility-changed';
