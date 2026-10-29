/**
 * plugin-view —— 右侧栏里承载插件页面的页签(全局页签,不跟对话)。
 *
 * 一个页签对应一个已装插件实例:插件声明了 `panel`(停靠形态)时展示 panel 页面
 * (沿用 GhostChipPanelBody,挂载即清未读),否则展示 `mainView` 页面。webview 分区、
 * 主题注入、崩溃接管与插件页 / 整页 mainView 完全同一条路(ghostPanelBody.tsx)。
 *
 * 页签不进「+」菜单:由插件的左侧栏入口「在侧边栏中打开」或停靠面板的自动迁移加入
 * (features/right-sidebar/globalTabs.ts)。插件被停用 / 卸载时页签按可用性隐藏,
 * 数据由 globalTabs 的 reconcile 处理,本模块只负责渲染。
 */

import { Puzzle } from 'lucide-react';
import type { TFunction } from 'i18next';

import {
  GhostChipPanelBody,
  GhostPanelError,
  GhostWebviewBody,
} from '@/cindy-brain/ghostPanelBody';
import { useGhostRuntimeState } from '@/cindy-brain/runtimeStates';
import { useInstalledGhosts } from '@/cindy-brain/useInstalledGhosts';
import { MAIN_VIEW_ICONS } from '@/cindy-brain/mainViewIcons';
import type { InstalledGhost } from '../../../../../shared/ghost';
import { installedGhostStoragePart } from '../../../../../shared/pluginIdentity';
import {
  effectivePluginView,
  globalTabTitleForGhost,
  type PluginViewTabState,
} from '../../globalTabs';
import { registerTabKind } from '../../registry';
import type { TabKindBodyProps, TabKindPlugin } from '../../types';

function useInstalledGhostByInstance(instanceId: string): InstalledGhost | undefined {
  return useInstalledGhosts().find((ghost) => installedGhostStoragePart(ghost) === instanceId);
}

function PluginViewTabPillTitle({ state, t }: { state: PluginViewTabState; t: TFunction }) {
  const ghost = useInstalledGhostByInstance(state.instanceId);
  return (
    <>
      {ghost
        ? globalTabTitleForGhost(ghost, effectivePluginView(state, ghost))
        : t('rightSidebar.tabs.kinds.pluginView')}
    </>
  );
}

function PluginViewTabPillIcon({ state }: { state: PluginViewTabState }) {
  const ghost = useInstalledGhostByInstance(state.instanceId);
  const Icon = MAIN_VIEW_ICONS[ghost?.manifest.mainView?.icon ?? 'puzzle'] ?? Puzzle;
  return <Icon size={13} />;
}

function PluginViewBody({ state }: TabKindBodyProps<PluginViewTabState>) {
  const ghost = useInstalledGhostByInstance(state.instanceId);
  const runtimeState = useGhostRuntimeState(state.instanceId);
  // 停用 / 卸载的瞬间投影层已把页签隐藏,这里只兜住收起前的一两帧。
  if (!ghost || ghost.enabled === false) return null;
  if (runtimeState === 'crashed' || runtimeState === 'fused') {
    return <GhostPanelError ghost={ghost} state={runtimeState} />;
  }
  // 按页签记录的页面选内容:主视图入口放进侧栏的是 mainView,停靠面板自动出现的是 panel。
  const view = effectivePluginView(state, ghost);
  const panelHtml =
    view === 'panel' && ghost.manifest.panel?.position !== 'tab'
      ? ghost.manifest.panel?.html
      : undefined;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {panelHtml ? (
        <GhostChipPanelBody ghost={ghost} />
      ) : (
        <GhostWebviewBody ghost={ghost} html={ghost.manifest.mainView?.html} />
      )}
    </div>
  );
}

const plugin: TabKindPlugin<PluginViewTabState> = {
  kind: 'plugin-view',
  menu: {
    kind: 'plugin-view',
    labelKey: 'rightSidebar.tabs.kinds.pluginView',
    icon: Puzzle,
    order: 90,
    enabled: true,
    hiddenFromMenu: true,
  },
  TabPillTitle: PluginViewTabPillTitle,
  TabPillIcon: PluginViewTabPillIcon,
  TabBody: PluginViewBody,
  defaultState: () => ({ instanceId: '' }),
  hydrateState: (raw) => {
    const instanceId =
      raw &&
      typeof raw === 'object' &&
      typeof (raw as { instanceId?: unknown }).instanceId === 'string'
        ? (raw as { instanceId: string }).instanceId
        : '';
    // 页签记着它承载的是 panel 还是 main 页面;丢了它就会一律回落成停靠面板那一份。
    const view = (raw as { view?: unknown } | null)?.view;
    return view === 'panel' || view === 'main' ? { instanceId, view } : { instanceId };
  },
};

registerTabKind(plugin as unknown as TabKindPlugin, import.meta.hot);
