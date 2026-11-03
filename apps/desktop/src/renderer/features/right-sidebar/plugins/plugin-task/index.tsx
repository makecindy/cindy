/**
 * plugin-task —— 右侧栏里跟对话的插件任务页页签(taskView)。
 *
 * 与全局页签 plugin-view 相反:页签存在各任务自己的页签桶里(本地数据库,随任务
 * 持久化),切换任务时随任务切换。一个任务里每个插件实例至多一个任务页页签,由
 * 插件逻辑页经 `cindy.taskView()` 打开或聚焦(lib/openPluginTaskTab.ts)。
 *
 * 页面与 mainView / panel 同一条 webview 路(ghostPanelBody.tsx):插件专属分区、
 * 零桥、主机注入主题;页签头由 Cindy 绘制,没有地址栏。页面经查询参数
 * `session=<id>` 得知自己所在的任务。
 */

import { Puzzle } from 'lucide-react';
import type { TFunction } from 'i18next';

import { GhostPanelError, GhostWebviewBody } from '@/cindy-brain/ghostPanelBody';
import { useGhostRuntimeState } from '@/cindy-brain/runtimeStates';
import { useInstalledGhosts } from '@/cindy-brain/useInstalledGhosts';
import type { InstalledGhost } from '../../../../../shared/ghost';
import { installedGhostStoragePart } from '../../../../../shared/pluginIdentity';
import { registerTabKind } from '../../registry';
import type { TabKindBodyProps, TabKindPlugin } from '../../types';

/** 任务页页签状态:承载哪个已装插件实例。 */
export interface PluginTaskTabState {
  instanceId: string;
}

function useInstalledGhostByInstance(instanceId: string): InstalledGhost | undefined {
  return useInstalledGhosts().find((ghost) => installedGhostStoragePart(ghost) === instanceId);
}

function PluginTaskTabPillTitle({ state, t }: { state: PluginTaskTabState; t: TFunction }) {
  const ghost = useInstalledGhostByInstance(state.instanceId);
  return (
    <>
      {ghost
        ? (ghost.manifest.taskView?.title ?? ghost.manifest.name)
        : t('rightSidebar.tabs.kinds.pluginTask')}
    </>
  );
}

function PluginTaskTabPillIcon({ state }: { state: PluginTaskTabState }) {
  const ghost = useInstalledGhostByInstance(state.instanceId);
  if (ghost?.iconDataUrl) {
    return <img src={ghost.iconDataUrl} alt="" width={13} height={13} className="rounded-[3px]" />;
  }
  return <Puzzle size={13} />;
}

function PluginTaskBody({ state, ctx }: TabKindBodyProps<PluginTaskTabState>) {
  const ghost = useInstalledGhostByInstance(state.instanceId);
  const runtimeState = useGhostRuntimeState(state.instanceId);
  // 归属未知时只保留页签和选中位,不为可能属于远端的任务加载本机插件页。
  if (ctx.remoteHostId || ctx.deviceLinkDeviceId !== null) return null;
  // 停用 / 卸载的瞬间可用性投影已把页签隐藏,这里只兜住收起前的一两帧。
  if (!ghost || ghost.enabled === false || !ghost.manifest.taskView) return null;
  if (runtimeState === 'crashed' || runtimeState === 'fused') {
    return <GhostPanelError ghost={ghost} state={runtimeState} />;
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <GhostWebviewBody
        ghost={ghost}
        html={ghost.manifest.taskView.html}
        query={`session=${encodeURIComponent(ctx.sessionId)}`}
      />
    </div>
  );
}

const plugin: TabKindPlugin<PluginTaskTabState> = {
  kind: 'plugin-task',
  menu: {
    kind: 'plugin-task',
    labelKey: 'rightSidebar.tabs.kinds.pluginTask',
    icon: Puzzle,
    order: 91,
    enabled: true,
    hiddenFromMenu: true,
  },
  TabPillTitle: PluginTaskTabPillTitle,
  TabPillIcon: PluginTaskTabPillIcon,
  TabBody: PluginTaskBody,
  defaultState: () => ({ instanceId: '' }),
  hydrateState: (raw) => ({
    instanceId:
      raw &&
      typeof raw === 'object' &&
      typeof (raw as { instanceId?: unknown }).instanceId === 'string'
        ? (raw as { instanceId: string }).instanceId
        : '',
  }),
};

registerTabKind(plugin as unknown as TabKindPlugin, import.meta.hot);
