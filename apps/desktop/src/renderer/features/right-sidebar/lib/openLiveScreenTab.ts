import { getActiveGlobalTabId, requestRevealSessionTab, setActiveGlobalTabId } from '../globalTabs';
import { addTab, ensureHydrated, getBucket, patchTabState, setActiveTab } from '../store';
import type { LiveScreenTabState } from '../plugins/live-screen';
import { getTabGroup, setGroupActiveTabId } from '../tabGroups';
import { isTabPoppedOut } from '@/lib/sidebarTabWindowState';
import { routeSidebarCommand } from './detachedSidebarRouting';
import { requestRightSidebarVisibility } from './sidebarCommands';

/**
 * 在指定任务的右侧栏打开「设备画面」页签(另一台电脑上的模拟器等):每个任务至多一个,
 * 已有则换成这台设备并聚焦。与本机插件任务页(openPluginTaskTab)同一套语义:设备出现时的
 * 自动打开传 userInitiated:false,不抢分离侧栏的前台;用户点入口才算手势。
 */
export async function openLiveScreenTab(
  sessionId: string,
  screen: LiveScreenTabState,
  options: { userInitiated?: boolean } = {},
): Promise<void> {
  const userInitiated = options.userInitiated !== false;
  const route = await routeSidebarCommand(
    { type: 'open-live-screen', sessionId, screen },
    { userInitiated },
  );
  if (route === 'attached') {
    await ensureHydrated(sessionId);
    const existing = getBucket(sessionId).tabs.find((tab) => tab.kind === 'live-screen');
    let tabId = existing?.id;
    if (existing) {
      const current = existing.state as Partial<LiveScreenTabState> | null;
      if (
        current?.plugin !== screen.plugin ||
        current.id !== screen.id ||
        current.name !== screen.name ||
        current.pluginName !== screen.pluginName
      )
        await patchTabState(sessionId, existing.id, () => screen);
      await setActiveTab(sessionId, existing.id, { userInitiated });
    } else {
      tabId = (await addTab(sessionId, 'live-screen', screen)).id;
    }
    if (tabId) {
      // 与 openPluginTaskTab 相同:目标 Shell 可能尚未挂载,直接写既有激活位。
      if (userInitiated && !isTabPoppedOut(tabId)) {
        const groupId = getTabGroup(tabId);
        setGroupActiveTabId(groupId, sessionId, tabId);
        const globalTabId = getActiveGlobalTabId();
        if (globalTabId && getTabGroup(globalTabId) === groupId && !isTabPoppedOut(globalTabId)) {
          setActiveGlobalTabId(null);
        }
      }
      requestRevealSessionTab(sessionId, tabId);
    }
  }
  if (route === 'attached' || route === 'routed') {
    requestRightSidebarVisibility('open', { sessionId, userInitiated });
  }
}
