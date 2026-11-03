/**
 * moveTabToGroup —— 把一个页签(任务页签或全局页签)搬到另一个页签组的统一入口。
 * 右键菜单「移到 …」与拖拽落点都走这里:改组归属、让它在目标组里被选中。
 * 组 pane 的出现 / 隐藏由 tabGroupPanes 按在场判定处理,这里不碰布局树。
 */

import { createLogger } from '@/lib/logger';
import {
  findGlobalTab,
  isGlobalTabId,
  rememberPluginWindowPlacement,
  setActiveGlobalTabId,
  type PluginViewTabState,
} from './globalTabs';
import { requestRightSidebarVisibility } from './lib/sidebarCommands';
import { setActiveTab } from './store';
import { getTabGroup, setGroupActiveTabId, setTabGroup, type TabGroupId } from './tabGroups';

const log = createLogger('rightSidebar.moveTab');

export function moveTabToGroup(
  tabId: string,
  target: TabGroupId,
  sessionId: string | null,
): boolean {
  if (getTabGroup(tabId) === target) return false;
  setTabGroup(tabId, target);
  setGroupActiveTabId(target, sessionId, tabId);
  if (isGlobalTabId(tabId)) {
    setActiveGlobalTabId(tabId);
    // 插件视图放回侧边栏的某一边 = 不再记它「在独立窗口里」。
    const instanceId = (findGlobalTab(tabId)?.state as PluginViewTabState | null)?.instanceId;
    if (instanceId) rememberPluginWindowPlacement(instanceId, false);
  } else if (sessionId) {
    void setActiveTab(sessionId, tabId).catch((err) => {
      log.warn('activate moved tab failed', { sessionId, tabId, err });
    });
  }
  // 搬回右侧组而右侧栏正收着:展开它,否则页签"消失"了。
  if (target === 'right') requestRightSidebarVisibility('open', { animate: true });
  return true;
}
