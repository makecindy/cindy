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
 *
 * 任务在本账号的另一台电脑上时，只有声明了 `taskView.remote` 的插件才显示任务页，
 * 页面多带查询参数 `device=<那台电脑的设备 ID>` 与 `deviceName=<那台电脑的名字>`
 * （供页面标明这是哪台电脑上的设备）：画面和操作都由插件自己的页面
 * 完成（逻辑页经 `cindy.liveScreenView()` 取那台电脑上同一插件的设备画面）。SSH
 * 远程任务没有任务页。
 */

import { Puzzle } from 'lucide-react';
import { PluginUiView } from '@/cindy-brain/PluginUiView';
import { getApprovedGhostHostUi } from '../../../../../shared/ghost';
import type { TFunction } from 'i18next';

import { GhostPanelError, GhostWebviewBody } from '@/cindy-brain/ghostPanelBody';
import { useGhostRuntimeState } from '@/cindy-brain/runtimeStates';
import { useInstalledGhosts } from '@/cindy-brain/useInstalledGhosts';
import { useDeviceLinkDeviceList } from '@/features/device-link/useDeviceLinkDeviceList';
import type { InstalledGhost } from '../../../../../shared/ghost';
import { installedGhostStoragePart } from '../../../../../shared/pluginIdentity';
import { registerTabKind } from '../../registry';
import type { TabKindBodyProps, TabKindPlugin } from '../../types';

/** 任务页页签状态:承载哪个已装插件实例。 */
export interface PluginTaskTabState {
  instanceId: string;
  resourceViewId?: string;
  resourceInput?: Record<string, unknown>;
}

function useInstalledGhostByInstance(instanceId: string): InstalledGhost | undefined {
  return useInstalledGhosts().find((ghost) => installedGhostStoragePart(ghost) === instanceId);
}

function PluginTaskTabPillTitle({ state, t }: { state: PluginTaskTabState; t: TFunction }) {
  const ghost = useInstalledGhostByInstance(state.instanceId);
  return (
    <>
      {ghost
        ? (state.resourceViewId ? getApprovedGhostHostUi(ghost)?.views?.find(view => view.id === state.resourceViewId)?.title ?? ghost.manifest.name : ghost.manifest.taskView?.title ?? ghost.manifest.name)
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

/**
 * 任务在另一台电脑上时的任务页：地址多带那台电脑的设备 ID 与名字。名字只供页面标明
 * 「这是哪台电脑上的设备」；设备列表只在这里读，本机任务的页签不依赖它。
 */
function RemotePluginTaskWebview({
  ghost,
  html,
  sessionId,
  deviceId,
}: {
  ghost: InstalledGhost;
  html: string;
  sessionId: string;
  deviceId: string;
}) {
  const name = useDeviceLinkDeviceList()?.find((device) => device.deviceId === deviceId)?.name;
  return (
    <GhostWebviewBody
      ghost={ghost}
      html={html}
      query={
        `session=${encodeURIComponent(sessionId)}&device=${encodeURIComponent(deviceId)}` +
        (name ? `&deviceName=${encodeURIComponent(name.slice(0, 80))}` : '')
      }
    />
  );
}

function PluginTaskBody({ state, ctx }: TabKindBodyProps<PluginTaskTabState>) {
  const ghost = useInstalledGhostByInstance(state.instanceId);
  const runtimeState = useGhostRuntimeState(state.instanceId);
  // 归属未知时只保留页签和选中位,不为可能属于远端的任务加载本机插件页。
  if (ctx.remoteHostId || ctx.deviceLinkDeviceId === undefined) return null;
  // 停用 / 卸载的瞬间可用性投影已把页签隐藏,这里只兜住收起前的一两帧。
  if (!ghost || ghost.enabled === false) return null;
  const remoteDevice = ctx.deviceLinkDeviceId;
  if (state.resourceViewId) return remoteDevice === null
    ? <PluginUiView ghost={ghost} viewId={state.resourceViewId} sessionId={ctx.sessionId} input={state.resourceInput} />
    : null;
  if (!ghost.manifest.taskView) return null;
  if (remoteDevice !== null && ghost.manifest.taskView.remote !== true) return null;
  if (runtimeState === 'crashed' || runtimeState === 'fused') {
    return <GhostPanelError ghost={ghost} state={runtimeState} />;
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {remoteDevice ? (
        <RemotePluginTaskWebview
          ghost={ghost}
          html={ghost.manifest.taskView.html}
          sessionId={ctx.sessionId}
          deviceId={remoteDevice}
        />
      ) : (
        <GhostWebviewBody
          ghost={ghost}
          html={ghost.manifest.taskView.html}
          query={`session=${encodeURIComponent(ctx.sessionId)}`}
        />
      )}
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
    ...((raw as PluginTaskTabState | null)?.resourceInput && typeof (raw as PluginTaskTabState).resourceInput === 'object' && !Array.isArray((raw as PluginTaskTabState).resourceInput) ? { resourceInput: (raw as PluginTaskTabState).resourceInput } : {}),
    ...(typeof (raw as PluginTaskTabState | null)?.resourceViewId === 'string' ? { resourceViewId: (raw as PluginTaskTabState).resourceViewId } : {}),
    instanceId:
      raw &&
      typeof raw === 'object' &&
      typeof (raw as { instanceId?: unknown }).instanceId === 'string'
        ? (raw as { instanceId: string }).instanceId
        : '',
  }),
};

registerTabKind(plugin as unknown as TabKindPlugin, import.meta.hot);
