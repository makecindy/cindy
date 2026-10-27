/**
 * 分离侧栏窗口「合并回主窗口」的唯一出口。
 *
 * 不可持久化会话(device-link 远程)的 tab 只在本 renderer 内存里,必须随
 * setDetached(false) 交接给主窗;可持久化会话的快照为 null,主窗按 SQLite 重新水合。
 */

import { isSidebarTabWindow } from '@/lib/sidebarTabWindow';
import { browserWebviewPool } from './browserWebviewPool';
import { getBucket, getSingleTabSnapshot, getTabSnapshot } from '../store';

export async function mergeSidebarWindowBack(
  sessionId: string | null | undefined,
  tabId?: string,
): Promise<void> {
  // 页签独立窗口:只交回指定的那个页签(不可持久化会话附内存态);窗口清空后 main 关窗。
  if (isSidebarTabWindow()) {
    if (!tabId) return;
    const snapshot = getSingleTabSnapshot(sessionId, tabId);
    // 多页签窗口合并回去后窗口往往还在:必须先把这个页签的浏览器 guest 释放掉,否则它在
    // 本窗口后台继续跑,主窗又按同一状态新建一份,两份页面写同一个页签状态。
    if (
      sessionId &&
      getBucket(sessionId).tabs.some((t) => t.id === tabId && t.kind === 'web-browser')
    ) {
      browserWebviewPool.release(tabId);
    }
    await window.electronAPI.sidebarTabWindow?.mergeBack?.({ tabId, snapshot });
    return;
  }
  const snapshot = getTabSnapshot(sessionId);
  const handoff = snapshot ? { snapshots: [snapshot] } : undefined;
  await window.electronAPI.rightSidebarWindow.setDetached(false, handoff);
}
