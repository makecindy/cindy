import { getActiveGlobalTabId, requestRevealSessionTab, setActiveGlobalTabId } from '../globalTabs';
import { addTab, ensureHydrated, getBucket, setActiveTab } from '../store';
import type { PluginTaskTabState } from '../plugins/plugin-task';
import { getTabGroup, setGroupActiveTabId } from '../tabGroups';
import { isTabPoppedOut } from '@/lib/sidebarTabWindowState';
import { routeSidebarCommand } from './detachedSidebarRouting';
import { requestRightSidebarVisibility } from './sidebarCommands';

/**
 * 在指定任务的右侧栏打开插件任务页(taskView):同一任务里每个插件实例至多一个
 * 任务页页签,已有则聚焦。后台插件请求传 userInitiated:false，不抢分离侧栏的前台；
 * 显式跳转只接受 Main 已验证真实手势的来源，并在目标 Shell 挂载前保留选中。
 */
export async function openPluginTaskTab(
  sessionId: string,
  instanceId: string,
  options: { userInitiated?: boolean } = {},
): Promise<void> {
  const userInitiated = options.userInitiated !== false;
  const route = await routeSidebarCommand(
    { type: 'open-plugin-task', sessionId, instanceId },
    { userInitiated },
  );
  if (route === 'attached') {
    await ensureHydrated(sessionId);
    const bucket = getBucket(sessionId);
    const existing = bucket.tabs.find(
      (tab) =>
        tab.kind === 'plugin-task' &&
        (tab.state as PluginTaskTabState | null)?.instanceId === instanceId,
    );
    let tabId = existing?.id;
    if (existing) {
      await setActiveTab(sessionId, existing.id, { userInitiated });
    } else {
      tabId = (await addTab(sessionId, 'plugin-task', { instanceId } satisfies PluginTaskTabState))
        .id;
    }
    if (tabId) {
      // 跨任务导航可能尚未挂载目标 Shell，不能只发送会丢失的一次性 reveal。
      // 直接写既有激活位；组归属和弹出位置仍以用户的放置记忆为准。
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
