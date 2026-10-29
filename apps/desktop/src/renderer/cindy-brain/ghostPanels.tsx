import { useEffect, useState } from 'react';

import type { InstalledGhost } from '../../shared/ghost';
import { installedGhostLogicalIdentity, pluginStoragePart } from '../../shared/pluginIdentity';
import { reconcileGlobalPluginTabs } from '../features/right-sidebar/globalTabs';
import { pruneGhostSettingsHeights } from './ghostSettingsHeight';
import { readInstalledGhostsSnapshot } from './useInstalledGhosts';
import { getDataOwnerGeneration } from '../contexts/dataOwnerGeneration';

/**
 * 插件面板与已装清单的同步入口。
 *
 * 停靠形态(`panel.position: 'left'`)的插件面板不再作为独立 pane 挂进主窗布局树,
 * 而是以右侧栏的**全局页签**(不跟对话,切任务不变)承载,见
 * features/right-sidebar/globalTabs.ts 与 plugins/plugin-view。本模块只剩两件事:
 * - 启动首帧前 / `ghosts:changed` 时把全局页签与已装清单对齐(停靠面板自动加入、
 *   卸载即清);
 * - 清理已卸载插件的设置页高度缓存。
 *
 * 布局树里历史遗留的 `ghost:<id>` pane 继续按「未注册面板」隐藏、数据保留
 * (docs/dev-rules/architecture-invariants.md §3),不再有渲染方。
 * 页签形态(`position: 'tab'`)照旧由插件页独占承载(features/plugin/GhostPagePanelHost)。
 */

// 兼容既有导入点(测试等):粗筛纯函数随面板体一起搬家,原路径继续可用。
export { pickGhostPanelMediaUri } from './ghostPanelBody';

/**
 * 把全局页签与"当前已装清单"对齐,并清理卸载插件的高度缓存。
 * 本函数是"已装清单"的唯一同步点(启动 + ghosts:changed)。
 */
export function syncGhostPanelRegistrations(ghosts: InstalledGhost[]): void {
  // 注意用全量清单(含沉睡)——沉睡只是不显示,高度仍可复用。
  pruneGhostSettingsHeights(
    getDataOwnerGeneration().dataOwnerId,
    ghosts.map((g) => pluginStoragePart(installedGhostLogicalIdentity(g))),
  );
  reconcileGlobalPluginTabs(ghosts);
}

let initialSynced = false;

/**
 * 首帧前的一次性同步(幂等)。由 LayoutRoot / 侧栏子窗口在渲染体内调用,
 * 让停靠面板迁移来的全局页签与侧栏首帧同时就位。
 */
export function ensureGhostPanelsRegistered(): void {
  if (initialSynced) return;
  initialSynced = true;
  // 测试/无桥环境(如 LayoutRoot 单测只 stub 了 layout)没有 ghosts 桥:
  // 视同"没装任何插件",不是错误。
  const api = window.electronAPI?.ghosts;
  if (!api) return;
  syncGhostPanelRegistrations(readInstalledGhostsSnapshot());
}

/**
 * 订阅装/卸广播:同步全局页签 + 返回版本号(依赖"已装清单"的 effect 把版本号
 * 放进 deps 才能感知变化)。
 */
export function useGhostPanelsSync(): number {
  const [version, bump] = useState(0);
  useEffect(() => {
    const api = window.electronAPI?.ghosts;
    if (!api) return;
    return api.onChanged(({ ghosts }) => {
      syncGhostPanelRegistrations(ghosts);
      bump((v) => v + 1);
    });
  }, []);
  return version;
}

/** 仅测试用:允许用例重复走首帧同步路径。 */
export function __resetGhostPanelsForTest(): void {
  initialSynced = false;
}
