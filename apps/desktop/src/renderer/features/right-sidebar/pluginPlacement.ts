/**
 * pluginPlacement —— 左侧栏插件入口点下去,主视图在哪里打开。
 *
 * 决策顺序(用户的放置记忆 > 插件声明的默认 > 内置默认):
 *   1. 页签已经在某扇独立窗口里 → 聚焦那扇窗口;
 *   2. 页签已经在侧边栏的某个组里 → 选中它(右侧组收着就展开);
 *   3. 用户上次把它弹到了独立窗口(windowInstanceIds)→ 再开进窗口;
 *   4. 插件 manifest 的 mainView.open:'sidebar' / 'window';
 *   5. 内置默认:撑满内容区的页面(由调用方 navigate)。
 * 放进侧边栏时的默认边同样是记忆优先(tabGroups 里的组归属),其次 mainView.side /
 * panel.position,最后右侧组(见 globalTabs.defaultGroupForGhost)。
 */

import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';

import type { InstalledGhost } from '../../../shared/ghost';
import { installedGhostStoragePart } from '../../../shared/pluginIdentity';
import { createLogger } from '@/lib/logger';
import { isSidebarTabWindow } from '@/lib/sidebarTabWindow';
import { isTabPoppedOut } from '@/lib/sidebarTabWindowState';
import {
  addGlobalPluginTab,
  findGlobalTabByInstance,
  resetPluginPlacement,
  tabShowsMainView,
  type PluginViewKind,
  type PluginViewTabState,
  isPluginWindowPlacement,
  rememberPluginWindowPlacement,
  removeGlobalTab,
  setActiveGlobalTabId,
  useGlobalTabs,
} from './globalTabs';
import { requestRightSidebarVisibility } from './lib/sidebarCommands';
import { getTabGroup } from './tabGroups';

const log = createLogger('rightSidebar.pluginPlacement');

export type PluginOpenTarget = 'page' | 'sidebar' | 'window';

/** 实例当前的页签若承载的就是主视图(整页入口那一份),返回它;承载别的页面(停靠面板)返回 null。 */
function existingMainViewTab(ghost: InstalledGhost) {
  const existing = findGlobalTabByInstance(installedGhostStoragePart(ghost));
  if (!existing) return null;
  return tabShowsMainView(existing.state as PluginViewTabState, ghost) ? existing : null;
}

/** 左侧栏入口点击时的打开目标(不含「已在侧边栏 / 窗口里」的聚焦分支)。 */
export function resolvePluginOpenTarget(ghost: InstalledGhost): PluginOpenTarget {
  const instanceId = installedGhostStoragePart(ghost);
  const existing = existingMainViewTab(ghost);
  if (existing) return isTabPoppedOut(existing.id) ? 'window' : 'sidebar';
  if (isPluginWindowPlacement(instanceId)) return 'window';
  const open = ghost.manifest.mainView?.open;
  if (open === 'sidebar' || open === 'window') return open;
  return 'page';
}

/**
 * 页签正弹在独立窗口里时,先把它真正交回主窗(窗口登记与主窗投影一起切过来),
 * 再谈放置:只改记忆不交回,主窗会继续把它当作「已弹出」隐藏。全局页签没有任务数据要带,
 * 交回只需 main 把它从窗口摘掉。
 */
async function returnPluginTabFromWindow(tabId: string): Promise<void> {
  if (!isTabPoppedOut(tabId)) return;
  try {
    await window.electronAPI?.sidebarTabWindow?.returnTab?.(tabId);
  } catch (err) {
    log.warn('return plugin tab from window failed', { tabId, err });
  }
}

/** 作为全局页签放进侧边栏(默认边见模块说明),选中它;落在右侧组时展开右侧栏。 */
export async function openPluginInSidebar(
  ghost: InstalledGhost,
  // 左侧导航入口放进侧栏的是主视图页面;详情页「在侧边栏中打开」放的是停靠面板页面。
  view: PluginViewKind = 'main',
): Promise<void> {
  const instanceId = installedGhostStoragePart(ghost);
  const tab = addGlobalPluginTab(instanceId, { ghost, view });
  if (!tab) return;
  await returnPluginTabFromWindow(tab.id);
  rememberPluginWindowPlacement(instanceId, false);
  setActiveGlobalTabId(tab.id);
  if (getTabGroup(tab.id) === 'right') requestRightSidebarVisibility('open');
}

/** 弹到独立窗口(已弹出则聚焦那扇窗口)。只在主窗口可用:弹出请求只接受主窗 sender。 */
export function openPluginInWindow(ghost: InstalledGhost): void {
  const instanceId = installedGhostStoragePart(ghost);
  const api = window.electronAPI?.sidebarTabWindow;
  const tab = addGlobalPluginTab(instanceId, { ghost, view: 'main' });
  if (!tab || !api) return;
  // 弹出窗口里的 preload 同样暴露 api.open,但 main 只接受主窗 sender:副窗口退回侧边栏,
  // 且不记「窗口放置」(记了用户看不到窗口,后续点击还会按这份记忆继续尝试开窗)。
  if (isSidebarTabWindow() || !api.open) {
    setActiveGlobalTabId(tab.id);
    return;
  }
  rememberPluginWindowPlacement(instanceId, true);
  if (isTabPoppedOut(tab.id)) {
    void api.focus(tab.id).catch((err) => log.warn('focus plugin window failed', { err }));
    return;
  }
  void api
    .open({
      tabId: tab.id,
      sessionId: null,
      context: { workdir: null, remoteHostId: null },
      handoff: null,
    })
    .catch((err) => {
      // 没开成:撤销窗口放置记忆,页签回到侧边栏,避免留下错误记忆。
      log.warn('pop out plugin view failed', { instanceId, err });
      rememberPluginWindowPlacement(instanceId, false);
      setActiveGlobalTabId(tab.id);
    });
}

/**
 * 恢复默认位置:弹在窗口里的页签先交回主窗,再清放置记忆并回到插件声明的默认边。
 * (resetPluginPlacement 只管记忆,不碰窗口。)
 */
export async function resetPluginPlacementAndReturn(ghost: InstalledGhost): Promise<void> {
  const instanceId = installedGhostStoragePart(ghost);
  const existing = findGlobalTabByInstance(instanceId);
  if (existing) await returnPluginTabFromWindow(existing.id);
  resetPluginPlacement(instanceId, ghost);
}

/** 已在侧边栏 / 窗口里、且承载的就是主视图的页签:聚焦它。返回 false = 没有(含页签承载别的页面)。 */
export function focusExistingPluginTab(ghost: InstalledGhost): boolean {
  const existing = existingMainViewTab(ghost);
  if (!existing) return false;
  if (isTabPoppedOut(existing.id)) {
    void window.electronAPI?.sidebarTabWindow?.focus(existing.id).catch(() => undefined);
    return true;
  }
  setActiveGlobalTabId(existing.id);
  if (getTabGroup(existing.id) === 'right') requestRightSidebarVisibility('open');
  return true;
}

/** 单实例视图(缺省):同一插件视图同一时刻只活在一个地方。插件声明 mainView.multiple 才放开。 */
export function isSingleInstanceView(ghost: InstalledGhost): boolean {
  return ghost.manifest.mainView?.multiple !== true;
}

/**
 * 整页(/apps/<id>)的单实例守卫:
 *   - 进整页时该实例的页签还在侧栏 / 独立窗口里 → 收掉页签(用户明确选了整页,整页赢;
 *     弹出窗口随之关闭);
 *   - 整页开着时页签又出现(用户点了「在侧边栏中打开」/ 弹出)→ 整页让位,回主入口。
 * 两份同一界面各自保存整份数据会互相覆盖,主机在这里兜底;声明了 multiple 的插件不管。
 */
export function useSingleInstanceViewGuard(ghost: InstalledGhost | null): void {
  const navigate = useNavigate();
  const globalTabs = useGlobalTabs();
  const instanceId = ghost ? installedGhostStoragePart(ghost) : null;
  const single = ghost ? isSingleInstanceView(ghost) : false;
  const settledRef = useRef<string | null>(null);
  useEffect(() => {
    if (!instanceId || !single) {
      settledRef.current = null;
      return;
    }
    // 只看承载主视图的页签:panel 与 mainView 是不同页面时可以并存。
    const existing = globalTabs.find(
      (tab) =>
        (tab.state as PluginViewTabState | null)?.instanceId === instanceId &&
        ghost !== null &&
        tabShowsMainView(tab.state as PluginViewTabState, ghost),
    );
    if (settledRef.current !== instanceId) {
      // 刚进整页:页签在别处就收掉。
      settledRef.current = instanceId;
      if (existing) removeGlobalTab(existing.id);
      return;
    }
    if (existing) {
      // 整页开着时页签出现:整页让位。
      navigate('/', { replace: true });
    }
  }, [ghost, globalTabs, instanceId, navigate, single]);
}
