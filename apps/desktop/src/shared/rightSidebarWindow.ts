/**
 * 右侧栏独立子窗口(RSB window)的跨进程共享类型。
 *
 * 三方共用:main(controller / IPC handler)、preload(桥接签名)、renderer
 * (主窗镜像 store + 子窗口根组件)。只放纯类型,不放运行时代码。
 */

import type { ConversationSearchJump } from './conversationSearchJump.js';

/** 子窗口全局状态:detached 是持久化偏好,lastOpen 是重启恢复用的状态,open 是运行时窗口开闭。 */
export interface RsbWindowState {
  /** 偏好:「侧边栏在新窗口中显示」。持久化,default false。 */
  detached: boolean;
  /** 状态:上次退出时窗口是否处于打开态(供重启恢复)。持久化。 */
  lastOpen: boolean;
  /** 运行时:子窗口当前是否存在。不持久化。 */
  open: boolean;
}

/**
 * 侧边栏渲染上下文 —— 由主窗 MainLayout 上报(单一真相:草稿会话 / remote 会话的
 * workdir 语义只有主窗路由视图知道,子窗口不能自查),main 缓存并转发子窗口。
 */
export interface RsbWindowContext {
  sessionId: string | null;
  workdir: string | null;
  remoteHostId: string | null;
  /** device-link 会话归属：null = 已确认本机，undefined = 尚未解析。 */
  deviceLinkDeviceId?: string | null;
  /** 当前主窗视图是否有侧边栏语义(设置页等无会话视图为 false,子窗口显示占位空态)。 */
  available: boolean;
}

/** main → 子窗口的命令推送(如主窗终端快捷键转发 / detached RSB 内定位文件)。 */
export type RsbWindowCommand =
  | { type: 'open-terminal'; sessionId: string }
  | { type: 'open-web-browser'; sessionId: string; url: string }
  | {
      type: 'ensure-orca-workers-tab';
      sessionId: string;
      focusWorkerSessionId?: string | null;
      searchJump?: ConversationSearchJump | null;
      focusTab?: boolean;
    }
  | { type: 'close-orca-workers-tab'; sessionId: string }
  /** 打开/聚焦「后台任务」页签(每会话单例);focusTaskId 定位到对应 workflow 详情。 */
  | {
      type: 'open-background-tasks-tab';
      sessionId: string;
      focusTaskId?: string | null;
    }
  | {
      type: 'open-turn-review';
      sessionId: string;
      changeSetIds: string[];
      selectedDiffId?: string | null;
      selectedPath?: string | null;
      requestNonce: number;
      /**
       * 承载 review tab 的 RSB 桶(缺省 = sessionId 自身)。协同面板里 worker
       * 流的入口传 lead sessionId:worker 自己的桶在协同视图下不可见。
       */
      hostSessionId?: string | null;
    }
  | {
      type: 'open-file-browser';
      sessionId: string;
      relPath: string;
      targetKind: 'file' | 'directory';
    }
  | {
      type: 'open-file-browser';
      sessionId: string;
      absPath: string;
      targetKind: 'external-file';
    };

/** renderer 请求 main 原子裁决当前 RSB command 的宿主。 */
export interface RsbWindowCommandRouteRequest {
  command: RsbWindowCommand;
  /** false 时 detached host 关闭/未 ready 不得重开，main 会保存 intent。 */
  allowOpen: boolean;
  /**
   * 这条命令是不是用户当次手势直接要求的(点链接 / 点菜单 / 点按钮)。
   *
   * 缺省 true —— 绝大多数调用点都是用户手势,保持既有「带出子窗口」观感。
   * 插件 preview 槽开页、agent 浏览器自动化这类**程序自发**的命令必须显式传
   * false:内容照常送进子窗口,但不得 show/focus 抢走用户当前前台应用
   * (Windows 上 focus() 就是抢前台,后台干活弹窗口是硬伤)。
   */
  userInitiated?: boolean;
}

/** main-owned 宿主裁决；renderer 只有 attached 可以写本地 store。 */
export type RsbWindowCommandRouteResult =
  | 'attached'
  | 'routed'
  | 'queued'
  | 'stale-context';
