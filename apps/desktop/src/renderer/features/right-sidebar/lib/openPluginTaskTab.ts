import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { getActiveGlobalTabId, requestRevealSessionTab, setActiveGlobalTabId } from '../globalTabs';
import { addTab, ensureHydrated, getBucket, patchTabState, setActiveTab } from '../store';
import type { PluginTaskTabState } from '../plugins/plugin-task';
import { getTabGroup, setGroupActiveTabId, type TabGroupId } from '../tabGroups';
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
  options: { userInitiated?: boolean; resourceViewId?: string; resourceInput?: Record<string, unknown>; resourceWorkingDir?: string;
    placement?: { groupId?: TabGroupId; onSelected?: (tabId: string, existed: boolean) => void };
  } = {},
): Promise<void> {
  const userInitiated = options.userInitiated !== false;
  const resource = {
    ...(options.resourceViewId ? { resourceViewId: options.resourceViewId } : {}),
    ...(options.resourceInput ? { resourceInput: options.resourceInput } : {}),
    ...(options.resourceWorkingDir ? { resourceWorkingDir: options.resourceWorkingDir } : {}),
  };
  const owner = getDataOwnerGeneration();
  const route = await routeSidebarCommand(
    { type: 'open-plugin-task', sessionId, instanceId, ...resource },
    { userInitiated },
  );
  if (!isDataOwnerGenerationCurrent(owner)) return;
  if (route === 'attached') {
    await ensureHydrated(sessionId);
    if (!isDataOwnerGenerationCurrent(owner)) return;
    const bucket = getBucket(sessionId);
    const existing = bucket.tabs.find(
      (tab) =>
        tab.kind === 'plugin-task' &&
        (tab.state as PluginTaskTabState | null)?.instanceId === instanceId &&
        (tab.state as PluginTaskTabState | null)?.resourceViewId === options.resourceViewId,
    );
    let tabId = existing?.id;
    if (existing) {
      if (options.resourceViewId || options.resourceInput) {
        await patchTabState(sessionId, existing.id, state => ({ ...(state as PluginTaskTabState), resourceInput: options.resourceInput ?? {}, resourceWorkingDir: options.resourceWorkingDir }));
      }
      await setActiveTab(sessionId, existing.id, { userInitiated });
      if (isDataOwnerGenerationCurrent(owner)) options.placement?.onSelected?.(existing.id, true);
    } else {
      tabId = (await addTab(sessionId, 'plugin-task', { instanceId, ...resource } satisfies PluginTaskTabState,
        options.placement && {
          groupId: options.placement.groupId,
          onOptimisticAdd: id => options.placement?.onSelected?.(id, false),
        }))
        .id;
    }
    if (!isDataOwnerGenerationCurrent(owner)) return;
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
