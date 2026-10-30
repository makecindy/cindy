/**
 * createSidebarTabWindow —— 右侧栏单页签独立窗口的 BrowserWindow 工厂。
 *
 * 复用 right-sidebar-window/window.ts 的 `createSidebarHostWindow`:同一份
 * sidebarWindowPreload、同一组安全字段、同样的外链守卫与崩溃隔离登记——弹出窗口
 * 承载的是侧栏里同一套页签插件(内置浏览器需要 webviewTag)。差异只在启动参数
 * (`sidebarWindow=1&sidebarTabWindow=1`,renderer 入口据此只挂 SidebarTabWindowLayout)、
 * 默认尺寸与独立的位置记忆文件;多扇同时打开时按序层叠,避免完全重叠。
 */

import type { BrowserWindow } from 'electron';

import { createSidebarHostWindow } from '../right-sidebar-window/window.js';

export function createSidebarTabWindow(cascadeIndex: number): BrowserWindow {
  return createSidebarHostWindow({
    query: { sidebarWindow: '1', sidebarTabWindow: '1' },
    stateFile: 'sidebar-tab-window-state.json',
    defaultWidth: 520,
    defaultHeight: 760,
    minWidth: 360,
    minHeight: 420,
    cascadeIndex,
    logLabel: 'sidebar tab window',
  });
}
