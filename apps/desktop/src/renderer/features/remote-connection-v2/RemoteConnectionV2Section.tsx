/**
 * RemoteConnectionV2Section —— 「远程连接」页打开「Agent-Net (Beta)」后多出来的拓扑区块。
 * ---------------------------------------------------------------------------
 * 自上而下:一行数字(几台在线、几台直连 / 经中转 / 要处理 / 离线)+ 右边与中转的连接状态和「最近活动」
 * 图标(点开是最近上下线的弹出层)→ 拓扑图(离线多时底下一行显示 / 收起离线设备)。没有单独的「需要处理」
 * 卡片(用户裁决 2026-11-07):有问题的设备在拓扑里是红色,点开卡片就写着原因;总开关和连接问题在上方本机卡片。
 * 拓扑图只管拓扑(用户裁决 2026-11-07):外层页面在它上面放「我的设备」的本机卡片(改名、开关、远程桌面),
 * 其它设备不再列出。设备深链(消息上的设备标签等)指向
 * 其它设备时,在这里打开那台设备的卡片,离线折叠着就先展开。
 *
 * 数据:设备目录与开关来自 useDeviceLinkSettings(与「我的设备」同一份);本机已建链对端的路径 / 往返 /
 * 最近业务收发来自 usePeerLinks(新 IPC);中转名来自 useSelfHostedRelayState;无响应熔断来自
 * unresponsiveDevicesStore。拓扑只画真实存在的数据:消息流动只在这台电脑与那台设备之间真有业务消息时出现,
 * 没有的(流量大小、第三方之间的链路)不画。
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { History } from 'lucide-react';
import { deviceLabel } from '@/components/settings/deviceLabels';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { SettingsCard } from '@/components/ui/settings-rows';
import type { SelfHostedRelayController } from '@/components/settings/RelayServicePanel';
import { resolveActiveConnectionIssue } from '@/components/settings/myDevicesModel';
import type { RemoteDevicesDeepLink } from '@/components/settings/useRemoteDevicesDeepLink';
import type { DeviceLinkSettings } from '@/hooks/useDeviceLinkSettings';
import { unresponsiveDevicesStore } from '@/features/device-link/unresponsiveDevicesStore';
import { toast } from '@/lib/toast';
import { createLogger } from '@/lib/logger';

import { remoteSwitchStore, startRemoteSwitch, type RemoteSwitchTarget } from './agentNetRemoteSwitch';
import { RemoteConnectionTopology } from './RemoteConnectionTopology';
import { RemoteSwitchBatch } from './RemoteSwitchBatch';
import { buildTopology, type TopologyModel, type TopologyNode } from './topologyModel';
import { relativeTime } from './topologyPresentation';
import { usePeerLinks } from './usePeerLinks';
import { useRecentPresence, type PresenceEvent } from './useRecentPresence';

const log = createLogger('RemoteConnectionV2Section');

function statsLine(model: TopologyModel, t: (k: string, o?: Record<string, unknown>) => string): string {
  const { stats } = model;
  const parts = [t('settings.remoteControl.v2.stats.online', { online: stats.online, total: stats.total })];
  if (stats.direct) parts.push(t('settings.remoteControl.v2.stats.direct', { count: stats.direct }));
  if (stats.relay) parts.push(t('settings.remoteControl.v2.stats.relay', { count: stats.relay }));
  if (stats.unlinked) parts.push(t('settings.remoteControl.v2.stats.unlinked', { count: stats.unlinked }));
  if (stats.attention) parts.push(t('settings.remoteControl.v2.stats.attention', { count: stats.attention }));
  if (stats.offline) parts.push(t('settings.remoteControl.v2.stats.offline', { count: stats.offline }));
  return parts.join(' · ');
}

/** 拓扑右上角的「最近活动」:一个图标,点开是最近上下线的弹出层(用户要求 2026-11-07:不必单独一张卡片)。 */
function RecentActivity({ events }: { events: readonly PresenceEvent[] }) {
  const { t } = useTranslation();
  const label = t('settings.remoteControl.v2.recent.title');
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex size-6 items-center justify-center rounded-lg text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-primary)] data-[state=open]:text-[var(--text-primary)]"
          aria-label={label}
          title={label}
        >
          <History size={14} aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end" className="w-72 p-0">
        <div className="px-3 pb-1 pt-2.5 text-12 font-medium text-[var(--text-secondary)]">{label}</div>
        {events.length ? (
          <ul className="max-h-72 overflow-y-auto pb-1.5">
            {events.map((e) => {
              const title = t(e.online ? 'settings.remoteControl.v2.recent.online' : 'settings.remoteControl.v2.recent.offline', { name: deviceLabel(e, t) });
              return (
                <li key={`${e.deviceId}:${e.at}`} className="flex items-baseline justify-between gap-3 px-3 py-1.5 text-12">
                  <span className="min-w-0 truncate text-[var(--text-primary)]" title={title}>
                    {title}
                  </span>
                  <span className="shrink-0 text-[var(--text-tertiary)]">{relativeTime(new Date(e.at).toISOString(), t)}</span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="px-3 pb-3 text-12 text-[var(--text-tertiary)]">{t('settings.remoteControl.v2.recent.empty')}</p>
        )}
      </PopoverContent>
    </Popover>
  );
}

export function RemoteConnectionV2Section({
  s,
  relay,
  deepLink,
}: {
  s: DeviceLinkSettings;
  relay: SelfHostedRelayController;
  deepLink: RemoteDevicesDeepLink;
}) {
  const { t } = useTranslation();
  const peerLinks = usePeerLinks(true);
  const recent = useRecentPresence(true);
  const unresponsive = useSyncExternalStore(unresponsiveDevicesStore.subscribe, unresponsiveDevicesStore.getSnapshot);
  const [showOffline, setShowOffline] = useState(false);
  const remoteSwitch = useSyncExternalStore(remoteSwitchStore.subscribe, remoteSwitchStore.getSnapshot);

  const relayName =
    relay.state?.mode === 'self-hosted' && relay.state.relay?.name
      ? relay.state.relay.name
      : t('settings.remoteControl.v2.relay.official');

  const model = useMemo(
    () =>
      buildTopology({
        devices: s.devices ?? [],
        links: peerLinks.links,
        relayRttMs: peerLinks.relayRttMs,
        relayName,
        selfHosted: relay.state?.mode === 'self-hosted',
        controlledBy: s.controlledBy.map((c) => c.deviceId),
        unresponsive: Array.from(unresponsive),
        showOffline,
      }),
    [s.devices, s.controlledBy, peerLinks, relayName, relay.state?.mode, unresponsive, showOffline],
  );

  const self = (s.devices ?? []).find((d) => d.isSelf) ?? null;
  const activeIssue = resolveActiveConnectionIssue(s.linkStatus, s.connectionIssue);

  // 深链指向其它设备:打开它在拓扑里的卡片;离线折叠着就先展开。本机由上面的本机卡片接住。
  const focusDeviceId =
    deepLink.focusDeviceId && deepLink.focusDeviceId !== self?.deviceId ? deepLink.focusDeviceId : null;
  const focusOffline = focusDeviceId ? model.byId.get(focusDeviceId)?.status === 'offline' : false;
  useEffect(() => {
    if (focusOffline) setShowOffline(true);
  }, [focusOffline, deepLink.focusRequestKey]);

  const onRemoteDesktop = useCallback((node: TopologyNode) => {
    window.electronAPI.openRemoteDesktop({ deviceId: node.id, name: node.name }).catch((err: unknown) => {
      log.warn('openRemoteDesktop failed', err);
      toast.error(t('settings.remoteControl.v2.popover.remoteDesktopFailed'));
    });
  }, [t]);

  const onSwitch = useCallback((node: TopologyNode, target: RemoteSwitchTarget) => {
    void startRemoteSwitch(node.id, target).then((result) => {
      const name = { name: node.name };
      if (result === 'done') {
        toast.success(t(target === 'agent-net' ? 'settings.remoteControl.v2.peerSwitch.toast.toAgentNet' : 'settings.remoteControl.v2.peerSwitch.toast.toDeviceLink', name));
      } else {
        toast.error(t(`settings.remoteControl.v2.peerSwitch.toast.${result}`, name));
      }
    });
  }, [t]);

  const linkStatusText = t(`settings.devices.linkStatus.${s.linkStatus}`);
  const offlineToggleVisible = model.stats.offline >= 2;

  return (
    <>
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-12">
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-[var(--text-secondary)]">{statsLine(model, t)}</span>
            <RemoteSwitchBatch nodes={model.nodes} entries={remoteSwitch.entries} />
          </span>
          <span className="flex items-center gap-1.5">
            {/* 与中转的连接:连着绿、出问题红、其它(连接中 / 已停)灰,和拓扑同一套颜色 */}
            <span
              className={
                s.connectionIssue
                  ? 'text-[var(--error-fg)]'
                  : s.linkStatus === 'online'
                    ? 'text-[var(--status-success)]'
                    : 'text-[var(--text-tertiary)]'
              }
            >
              {linkStatusText}
            </span>
            <RecentActivity events={recent} />
          </span>
        </div>
        <SettingsCard>
          <div className="px-2 py-3">
            {model.nodes.length === 0 ? (
              <p className="px-2 py-6 text-center text-13 text-[var(--text-secondary)]">
                {t('settings.remoteControl.v2.empty')}
              </p>
            ) : null}
            <RemoteConnectionTopology
              model={model}
              linkStatus={s.linkStatus}
              issue={activeIssue ? t(`settings.devices.connectionIssue.${activeIssue.kind}`) : null}
              standby={s.standby}
              onToggleOffline={() => setShowOffline((v) => !v)}
              onRemoteDesktop={onRemoteDesktop}
              focusDeviceId={focusDeviceId}
              focusRequestKey={deepLink.focusRequestKey}
              ready={s.devices !== null && peerLinks.takenAt > 0}
              switches={remoteSwitch.entries}
              onSwitch={onSwitch}
            />
          </div>
          {offlineToggleVisible ? (
            <div className="flex justify-end border-t border-[var(--settings-theme-card-border)] px-3 py-1.5">
              <button
                type="button"
                className="text-12 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                onClick={() => setShowOffline((v) => !v)}
              >
                {showOffline
                  ? t('settings.remoteControl.v2.offlineHide')
                  : t('settings.remoteControl.v2.offlineShow')}
              </button>
            </div>
          ) : null}
        </SettingsCard>
      </section>
    </>
  );
}
