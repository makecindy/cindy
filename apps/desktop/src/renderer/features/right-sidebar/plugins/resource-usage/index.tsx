/**
 * resource-usage —— 本机进程 CPU / 内存快照视图。
 *
 * 原为右侧栏页签 plugin（singleton），现由独立的资源用量 BrowserWindow
 * 承载。本文件保留组件与类型导出，供轻量窗口根组件引用。
 */

export { ResourceUsageBody } from './ResourceUsageBody';

export type ResourceUsageState = Record<never, never>;
