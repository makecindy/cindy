/**
 * live-screen —— 右侧栏里跟对话的「设备画面」页签:任务在同账号另一台电脑上、那台电脑的
 * 插件为该任务开着设备画面(例如模拟器)时,在这里直接查看并操作那台设备。
 *
 * 与本机插件任务页(plugin-task)对应:本机任务由插件自己的页面承载;远程任务拿不到那台
 * 电脑上的插件页,改由宿主经远程桌面通道显示同一台设备。页签标题沿用插件名,位置、
 * 打开方式(设备出现时自动打开)与本机一致。每个任务至多一个,切换设备只换页签里的目标。
 *
 * 程序化入口见 lib/openLiveScreenTab.ts;不进「+」菜单(没有设备时没有内容可开)。
 */

import { Smartphone } from 'lucide-react';
import type { TFunction } from 'i18next';
import { LIVE_SCREEN_ID, LIVE_SCREEN_PLUGIN_ID } from '@cindy/device-link';

import { LiveScreenPanel } from '@/features/remote-desktop/LiveScreenPanel';
import { useKnownTaskLiveScreens } from '@/features/remote-desktop/taskLiveScreensStore';
import { useDeviceLinkDeviceList } from '@/features/device-link/useDeviceLinkDeviceList';
import { deviceDisplayName } from '@/lib/deviceName';
import { openLiveScreenTab } from '../../lib/openLiveScreenTab';
import { registerTabKind } from '../../registry';
import type { TabKindBodyProps, TabKindPlugin } from '../../types';

/** 页签显示哪台设备;名称只用于连接前的标题,连接后以对方电脑核实的为准。 */
export interface LiveScreenTabState {
  plugin: string;
  id: string;
  name: string;
  pluginName: string;
}

const EMPTY: LiveScreenTabState = { plugin: '', id: '', name: '', pluginName: '' };

export function parseLiveScreenTabState(raw: unknown): LiveScreenTabState | null {
  const value = raw as Partial<LiveScreenTabState> | null;
  if (
    !value ||
    typeof value !== 'object' ||
    typeof value.plugin !== 'string' ||
    !LIVE_SCREEN_PLUGIN_ID.test(value.plugin) ||
    typeof value.id !== 'string' ||
    !LIVE_SCREEN_ID.test(value.id)
  )
    return null;
  const text = (input: unknown) => (typeof input === 'string' ? input.slice(0, 256) : '');
  return {
    plugin: value.plugin,
    id: value.id,
    name: text(value.name),
    pluginName: text(value.pluginName),
  };
}

function LiveScreenTabPillTitle({ state, t }: { state: LiveScreenTabState; t: TFunction }) {
  return <>{state.pluginName || t('remoteDesktop.liveScreenTitle')}</>;
}

function LiveScreenTabPillIcon() {
  return <Smartphone size={13} />;
}

function LiveScreenBody({
  state,
  ctx,
  active,
  shellVisible,
}: TabKindBodyProps<LiveScreenTabState>) {
  const devices = useDeviceLinkDeviceList();
  const screens = useKnownTaskLiveScreens(ctx.sessionId);
  const deviceId = ctx.deviceLinkDeviceId;
  // 只为已确认在另一台电脑上的任务连接;本机或归属未知的任务不显示任何内容。
  if (ctx.remoteHostId || typeof deviceId !== 'string' || !state.plugin || !state.id) return null;
  return (
    <LiveScreenPanel
      // 换电脑或换设备即重建连接。
      key={`${deviceId}|${state.plugin}|${state.id}`}
      deviceId={deviceId}
      deviceName={deviceDisplayName(deviceId, undefined, devices ?? [])}
      screen={{ plugin: state.plugin, id: state.id, name: state.name || undefined }}
      visible={active !== false && shellVisible !== false}
      devices={screens}
      onSelectDevice={(device) => {
        const picked = screens.find(
          (item) => item.plugin === device.plugin && item.id === device.id,
        );
        if (picked)
          void openLiveScreenTab(ctx.sessionId, {
            plugin: picked.plugin,
            id: picked.id,
            name: picked.name,
            pluginName: picked.pluginName,
          }).catch(() => {});
      }}
    />
  );
}

const plugin: TabKindPlugin<LiveScreenTabState> = {
  kind: 'live-screen',
  menu: {
    kind: 'live-screen',
    labelKey: 'remoteDesktop.liveScreenTitle',
    icon: Smartphone,
    order: 92,
    enabled: true,
    hiddenFromMenu: true,
    singleton: true,
  },
  TabPillTitle: LiveScreenTabPillTitle,
  TabPillIcon: LiveScreenTabPillIcon,
  TabBody: LiveScreenBody,
  defaultState: () => ({ ...EMPTY }),
  hydrateState: (raw) => parseLiveScreenTabState(raw) ?? { ...EMPTY },
};

registerTabKind(plugin as unknown as TabKindPlugin, import.meta.hot);
