/**
 * 右侧栏「页签独立窗口」(sidebar tab window)的跨进程共享类型。
 *
 * 与 shared/rightSidebarWindow.ts(整栏子窗口)的差异:按 **窗口多实例**,一扇窗口
 * 可以承载多个页签(同一任务的页签 + 任意全局页签),本质上是「住在别的窗口里的
 * 页签组」。用户把正在看的页签弹出到自己的窗口,或搬进已有的弹出窗口;主窗口的
 * 侧边栏继续存在并显示其余页签。关闭弹出窗口 = 关闭它承载的全部页签;「合并回侧边栏」
 * 按页签送回。三方共用:main(controller / IPC)、preload(桥接签名)、renderer(主窗
 * 镜像 store + 弹出窗口根组件)。只放纯类型与 channel 常量,不放运行时代码。
 */

import type { RsbWindowTabSnapshot } from './rightSidebarWindow.js';

/** 弹出窗口承载页签所需的会话渲染上下文,由主窗在弹出瞬间一次性交付。 */
export interface SidebarTabWindowContext {
  workdir: string | null;
  remoteHostId: string | null;
  /** device-link 会话归属:null = 已确认本机,undefined = 尚未解析。 */
  deviceLinkDeviceId?: string | null;
  subagentsAvailable?: boolean;
}

/** 窗口里的一个页签:任务页签带所属任务,全局页签(插件视图)为 null。 */
export interface SidebarTabWindowTabRef {
  tabId: string;
  sessionId: string | null;
}

/** main 指派给某扇弹出窗口的内容;随页签加入 / 离开更新并重新下发。 */
export interface SidebarTabWindowAssignment {
  windowId: string;
  /** 窗口里任务页签所属的任务;只有全局页签时为 null。一扇窗口只服务一个任务。 */
  sessionId: string | null;
  tabs: SidebarTabWindowTabRef[];
  context: SidebarTabWindowContext;
}

/** 下发给弹出窗口的指派:附不可持久化会话的整桶内存快照(仅 device-link 远程会话非空)。 */
export interface SidebarTabWindowAssignmentPayload extends SidebarTabWindowAssignment {
  handoff: RsbWindowTabSnapshot | null;
  /** 本次指派要求选中的已承载页签；只发给它的窗口，不持久化。 */
  revealTabId?: string;
}

/** 主窗 → main 的弹出 / 搬入请求。 */
export interface SidebarTabWindowOpenRequest {
  tabId: string;
  /** 任务页签所属任务;全局页签(不跟对话,如插件视图)为 null。 */
  sessionId: string | null;
  context: SidebarTabWindowContext;
  /** 只对不可持久化会话(device-link 远程)非空。 */
  handoff?: RsbWindowTabSnapshot | null;
  /** 搬进已有的弹出窗口;缺省 / 窗口不存在或任务不符时新开一扇。 */
  targetWindowId?: string;
  /** 拖出窗口松手的屏幕坐标(DIP):新窗口落在这附近;缺省沿用层叠位置。 */
  position?: { x: number; y: number };
}

/** 弹出窗口合并回侧边栏时交回的单页签内存态(仅不可持久化会话)。 */
export interface SidebarTabReturnSnapshot {
  sessionId: string;
  tab: { id: string; kind: string; state: unknown };
}

/** 弹出窗口 → main:把某个页签合并回侧边栏。 */
export interface SidebarTabWindowMergeBackRequest {
  tabId: string;
  snapshot: SidebarTabReturnSnapshot | null;
}

/** 弹出窗口 → main:在本窗口里新建的页签归本窗口承载。 */
export interface SidebarTabWindowAdoptRequest {
  tabId: string;
  sessionId: string | null;
  /**
   * 不可持久化会话(device-link 远程)里新建页签的内存态:页签只存在于该 renderer 里,
   * main 留一份,窗口崩溃 / 作废时随交回通知带回侧栏,页签不会连同窗口一起消失。
   */
  snapshot?: SidebarTabReturnSnapshot | null;
}

/** 单个已弹出页签的运行时状态;只在当前进程有效,不跨重启。 */
export interface SidebarTabWindowEntryState {
  windowId: string;
  sessionId: string | null;
  /** 窗口是否已经展示(或正在等待首份内容后展示)。 */
  open: boolean;
}

/** 全量状态:tabId → 所在窗口。没有条目 = 该页签没有弹出。 */
export type SidebarTabWindowsState = Record<string, SidebarTabWindowEntryState>;

/** main → 主窗:页签离开弹出窗口,回到侧边栏(合并 / 崩溃)。 */
export interface SidebarTabReturnedPayload {
  sessionId: string | null;
  tabId: string;
  /** 不可持久化会话交回的内存态;可持久化会话为 null,主窗按 SQLite 刷新。 */
  snapshot: SidebarTabReturnSnapshot | null;
  /**
   * merge = 用户合并回侧栏;crash = 窗口崩溃 / 作废;closed = 页签在窗口里被关掉(不再显示,
   * 主窗据此丢掉自己缓存里的副本——不可持久化会话没有数据库广播可依赖)。
   */
  reason: 'merge' | 'crash' | 'closed';
}

/** main → 所有窗口:某会话的页签持久化数据被其它 renderer 改动。 */
export interface RightSidebarTabsChangedPayload {
  sessionId: string;
}

// ── IPC channel 常量 ──────────────────────────────────────────────────
/** renderer → main(invoke):弹出窗口壳已挂载。 */
export const SIDEBAR_TAB_WINDOW_RENDERER_READY_CHANNEL = 'sidebar-tab-window:renderer-ready';
/** renderer → main(invoke):被指派页签的首份内容已提交。 */
export const SIDEBAR_TAB_WINDOW_PRESENTATION_READY_CHANNEL =
  'sidebar-tab-window:presentation-ready';
/** renderer → main(invoke):读取本窗口的指派(重载 / 预热窗口晚于指派挂载时用)。 */
export const SIDEBAR_TAB_WINDOW_GET_ASSIGNMENT_CHANNEL = 'sidebar-tab-window:get-assignment';
/** renderer → main(invoke):把某个页签合并回侧边栏;窗口清空后随之关闭。 */
export const SIDEBAR_TAB_WINDOW_MERGE_BACK_CHANNEL = 'sidebar-tab-window:merge-back';
/** renderer → main(invoke):本窗口里新建的页签归本窗口承载。 */
export const SIDEBAR_TAB_WINDOW_ADOPT_TAB_CHANNEL = 'sidebar-tab-window:adopt-tab';
/** main → 弹出窗口(send):指派(页签加入 / 离开时重发全量)。 */
export const SIDEBAR_TAB_WINDOW_ASSIGNED_CHANNEL = 'sidebar-tab-window:assigned';
/**
 * main → 弹出窗口(send):用户经原生入口关窗(红绿灯 / 系统关闭 / Windows X)。
 * 关窗 = 关闭窗口里的全部页签:renderer 逐个走 store.closeTab(插件 onBeforeClose、
 * 确认拦截照常),页签从桶里消失后再由 renderer 请求 close-for-tab;最后一个页签
 * 离开时 main 销毁窗口;有页签被否决则窗口留着。
 */
export const SIDEBAR_TAB_WINDOW_CLOSE_REQUESTED_CHANNEL = 'sidebar-tab-window:close-requested';
/** main → 弹出窗口(send):显示 / 隐藏切换。 */
export const SIDEBAR_TAB_WINDOW_VISIBILITY_CHANGED_CHANNEL =
  'sidebar-tab-window:visibility-changed';
export const SIDEBAR_TAB_WINDOW_LOCALE_CHANGED_CHANNEL = 'sidebar-tab-window:locale-changed';
