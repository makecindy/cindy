/**
 * tabHosting —— 「这个页签的内容由本 renderer 承载吗」。
 *
 * 同一会话的页签桶可能同时水合在多个 renderer 里:主窗侧边栏 + 若干弹出的页签
 * 窗口。每个页签只由一个 renderer 真正挂载它的 body(webview / 终端 / 文件树),
 * 其它 renderer 只持有它的数据副本:
 *   - 主窗 / 副窗:承载所有**未弹出**的页签;
 *   - 弹出窗口:只承载 main 指派给它的那几个页签。
 *
 * store 据此决定跨 renderer 刷新时哪些页签以本地为准(承载方)、哪些以 SQLite
 * 为准(非承载方),Shell 据此隐藏非承载页签。
 */

import { useSyncExternalStore } from 'react';

import { isSidebarTabWindow } from '@/lib/sidebarTabWindow';
import { isTabPoppedOut } from '@/lib/sidebarTabWindowState';

let hosted: ReadonlySet<string> = new Set();
const subscribers = new Set<() => void>();

function notify(): void {
  for (const cb of [...subscribers]) cb();
}

/** 弹出窗口收到指派后登记自己承载的页签;主窗不调用。 */
export function setHostedTabIds(tabIds: readonly string[]): void {
  const next = new Set(tabIds);
  if (next.size === hosted.size && [...next].every((id) => hosted.has(id))) return;
  hosted = next;
  notify();
}

/** 弹出窗口里新建页签:乐观登记为本窗口承载(main 确认后随指派重发)。 */
export function addHostedTabId(tabId: string): void {
  if (hosted.has(tabId)) return;
  hosted = new Set([...hosted, tabId]);
  notify();
}

export function getHostedTabIds(): ReadonlySet<string> {
  return hosted;
}

export function isTabHostedHere(tabId: string): boolean {
  if (isSidebarTabWindow()) return hosted.has(tabId);
  return !isTabPoppedOut(tabId);
}

function subscribe(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

/** React hook:本窗口承载的页签集合(弹出窗口用)。 */
export function useHostedTabIds(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, getHostedTabIds);
}

/** 仅测试用。 */
export function __resetTabHostingForTest(): void {
  hosted = new Set();
  subscribers.clear();
}
