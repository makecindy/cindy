/**
 * openGhostTabInSidebar —— "打开/聚焦插件页签"的统一入口。
 *
 * 装入流程(installFlow 勾选「立即开启」)等远端调用点通过它把一个
 * panel.position:'tab' 的插件页签带到用户面前:
 *   1. 先经 routeSidebarCommand 请 main 裁决宿主 —— 侧栏抽离成独立窗口时命令
 *      被路由过去,由子窗口的 executeSidebarCommand 落地;
 *   2. attached(内嵌)形态本地执行:ensureHydrated 消除与 Shell 异步 list
 *      拉取的竞态(同 openInSidebarBrowser 的注释),再 addOrFocusSingletonTab
 *      —— 插件页签每会话单例,已开则聚焦;
 *   3. 请求右侧栏可见("已打开 → no-op"由 MainLayout 订阅端自行判断)。
 */

import { ghostPanelKind } from '../../../../shared/ghost';
import { addOrFocusSingletonTab, ensureHydrated } from '../store';
import { routeSidebarCommand } from './detachedSidebarRouting';
import { requestRightSidebarVisibility } from './sidebarCommands';

/** 在指定 session 的右侧栏里打开/聚焦某插件的页签,并确保侧边栏可见。 */
export async function openGhostTabInSidebar(sessionId: string, ghostId: string): Promise<void> {
  const routeResult = await routeSidebarCommand({
    type: 'open-ghost-tab',
    sessionId,
    ghostId,
  });
  if (routeResult !== 'attached') {
    if (routeResult !== 'routed') return;
    requestRightSidebarVisibility('open', { sessionId });
    return;
  }
  await ensureHydrated(sessionId);
  await addOrFocusSingletonTab(sessionId, ghostPanelKind(ghostId));
  requestRightSidebarVisibility('open', { sessionId });
}
