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
 * 本机连接流量来自同一份快照。第三方之间的链路不画。
 */

import { Suspense, lazy, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { History } from 'lucide-react';
import { useDeleteDeviceDialog } from '@/components/settings/useDeleteDeviceDialog';
import { deviceLabel } from '@/components/settings/deviceLabels';

import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { SettingsCard } from '@/components/ui/settings-rows';
import type { SelfHostedRelayController } from '@/components/settings/RelayServicePanel';
import { resolveActiveConnectionIssue } from '@/components/settings/myDevicesModel';
import type { RemoteDevicesDeepLink } from '@/components/settings/useRemoteDevicesDeepLink';
import type { DeviceLinkSettings } from '@/hooks/useDeviceLinkSettings';
import { unresponsiveDevicesStore } from '@/features/device-link/unresponsiveDevicesStore';
import { toast } from '@/lib/toast';
import { createLogger } from '@/lib/logger';

import { remoteSwitchStore, startRemoteSwitch, type RemoteSwitchTarget } from './agentNetRemoteSwitch';
import { startPeerUpdate, type PeerUpdateConfirmTarget } from './peerAppUpdate';
import { RemoteConnectionTopology } from './RemoteConnectionTopology';
import { ConnectionTraffic } from './ConnectionTraffic';
import { RemoteSwitchBatch } from './RemoteSwitchBatch';
import { buildTopology, type TopologyModel, type TopologyNode } from './topologyModel';
import { relativeTime } from './topologyPresentation';
import { usePeerLinks } from './usePeerLinks';
import { useRecentPresence, type PresenceEvent } from './useRecentPresence';

const LazyRemoteProviderTopologyPanel = lazy(() =>
  import('./RemoteProviderTopology').then((m) => ({ default: m.RemoteProviderTopologyPanel })),
);

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
  const { requestDelete, dialog } = useDeleteDeviceDialog(s.remove);
  const peerLinks = usePeerLinks(true);
  const recent = useRecentPresence(true);
  const unresponsive = useSyncExternalStore(unresponsiveDevicesStore.subscribe, unresponsiveDevicesStore.getSnapshot);
  const [showOffline, setShowOffline] = useState(false);
  const [activeTab, setActiveTab] = useState<'devices' | 'providers'>('devices');
  const [updateTarget, setUpdateTarget] = useState<PeerUpdateConfirmTarget | null>(null);
  const [updateSubmitting, setUpdateSubmitting] = useState(false);
  const remoteSwitch = useSyncExternalStore(remoteSwitchStore.subscribe, remoteSwitchStore.getSnapshot);
  const providerTabEnabled = peerLinks.relayProtocol !== 'device-link';
  const effectiveTab = providerTabEnabled ? activeTab : 'devices';

  const relayName =
    relay.state?.mode === 'self-hosted' && relay.state.relay?.name
      ? relay.state.relay.name
      : t('settings.remoteControl.v2.relay.official');

  const model = useMemo(
    () =>
      buildTopology({
        devices: s.devices ?? [],
        links: peerLinks.links,
        agentNetRoutes: peerLinks.agentNetRoutes,
        relayRttMs: peerLinks.relayRttMs,
        relayProtocol: peerLinks.relayProtocol,
        relayTransport: peerLinks.relayTransport,
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

  // 深链指向其它设备:切回设备连接视图并打开它在拓扑里的卡片;离线折叠着就先展开。本机由上面的本机卡片接住。
  const focusDeviceId =
    deepLink.focusDeviceId && deepLink.focusDeviceId !== self?.deviceId ? deepLink.focusDeviceId : null;
  const focusOffline = focusDeviceId ? model.byId.get(focusDeviceId)?.status === 'offline' : false;
  useEffect(() => {
    if (focusDeviceId) setActiveTab('devices');
    if (focusOffline) setShowOffline(true);
  }, [focusDeviceId, focusOffline, deepLink.focusRequestKey]);

  const handleRemoteDesktopById = useCallback((deviceId: string, name: string) => {
    window.electronAPI.openRemoteDesktop({ deviceId, name }).catch((err: unknown) => {
      log.warn('openRemoteDesktop failed', err);
      toast.error(t('settings.remoteControl.v2.popover.remoteDesktopFailed'));
    });
  }, [t]);

  const onRemoteDesktop = useCallback((node: TopologyNode) => {
    handleRemoteDesktopById(node.id, node.name);
  }, [handleRemoteDesktopById]);

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

  const handlePathPreferenceById = useCallback(async (deviceId: string, preference: 'auto' | 'direct' | 'relay') => {
    const setPref = window.electronAPI?.deviceLink?.setPeerPathPreference;
    if (!setPref) return false;
    try {
      await setPref(deviceId, preference);
      return true;
    } catch (err) {
      log.warn('setPeerPathPreference failed', err);
      toast.error(t('settings.remoteControl.v2.popover.routePreferenceFailed'));
      return false;
    }
  }, [t]);

  const onPathPreferenceChange = useCallback(
    (node: TopologyNode, preference: 'auto' | 'direct' | 'relay') => handlePathPreferenceById(node.id, preference),
    [handlePathPreferenceById],
  );

  const onConfirmUpdate = useCallback(async () => {
    if (!updateTarget || updateSubmitting) return;
    const target = updateTarget;
    setUpdateSubmitting(true);
    try {
      const result = await startPeerUpdate(
        target.targetId,
        target.targetVersion,
        target.currentVersion,
        (errorCode) => {
          toast.error(
            t(
              errorCode === 'version_changed'
                ? 'settings.remoteControl.v2.peerUpdate.toast.versionChanged'
                : 'settings.remoteControl.v2.peerUpdate.toast.failed',
              { name: target.deviceName },
            ),
          );
        },
      );
      if (result.ok) {
        setUpdateTarget(null);
        toast.success(
          t(
            result.state === 'relaunching'
              ? 'settings.remoteControl.v2.peerUpdate.toast.relaunching'
              : 'settings.remoteControl.v2.peerUpdate.toast.started',
            { name: target.deviceName, version: result.targetVersion },
          ),
        );
      } else {
        setUpdateTarget(null);
        toast.error(
          t(
            result.code === 'PEER_APP_UPDATE_VERSION_CHANGED'
              ? 'settings.remoteControl.v2.peerUpdate.toast.versionChanged'
              : result.code === 'PEER_APP_UPDATE_NO_UPDATE'
                ? 'settings.remoteControl.v2.peerUpdate.toast.noUpdate'
                : result.code === 'PEER_APP_UPDATE_BUSY'
                  ? 'settings.remoteControl.v2.peerUpdate.toast.busy'
                  : 'settings.remoteControl.v2.peerUpdate.toast.failed',
            { name: target.deviceName },
          ),
        );
      }
    } finally {
      setUpdateSubmitting(false);
    }
  }, [t, updateSubmitting, updateTarget]);

  const linkStatusText = t(`settings.devices.linkStatus.${s.linkStatus}`);
  const offlineToggleVisible = model.stats.offline >= 2;

  const tabControl = providerTabEnabled ? (
    <SegmentedControl<'devices' | 'providers'>
      role="tablist"
      value={effectiveTab}
      onValueChange={setActiveTab}
      aria-label={t('settings.remoteControl.v2.tabs.aria')}
      density="sm"
      options={[
        { value: 'devices', label: t('settings.remoteControl.v2.tabs.devices') },
        { value: 'providers', label: t('settings.remoteControl.v2.tabs.providers') },
      ]}
    />
  ) : null;

  const statusRight = (
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
  );

  return (
    <>
      <section className="flex flex-col gap-3">
        {effectiveTab === 'providers' ? (
          <Suspense
            fallback={
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 text-12">
                <span className="flex flex-wrap items-center gap-x-3 gap-y-1.5">{tabControl}</span>
                {statusRight}
              </div>
            }
          >
            <LazyRemoteProviderTopologyPanel
              devices={s.devices ?? []}
              peerLinks={peerLinks}
              primaryRelayName={relayName}
              primarySelfHosted={relay.state?.mode === 'self-hosted'}
              unresponsiveIds={unresponsive}
              tabControl={tabControl}
              statusRight={statusRight}
              onPathPreferenceChange={handlePathPreferenceById}
              onRemoteDesktop={handleRemoteDesktopById}
            />
          </Suspense>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 text-12">
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                {tabControl}
                <span className="text-[var(--text-secondary)]">{statsLine(model, t)}</span>
                <RemoteSwitchBatch nodes={model.nodes} entries={remoteSwitch.entries} />
              </span>
              {statusRight}
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
                  onDelete={(node, restoreFocus) => requestDelete({ deviceId: node.id, name: deviceLabel(node, t) }, restoreFocus)}
                  focusDeviceId={focusDeviceId}
                  focusRequestKey={deepLink.focusRequestKey}
                  ready={s.devices !== null && peerLinks.takenAt > 0}
                  switches={remoteSwitch.entries}
                  onSwitch={onSwitch}
                  onPathPreferenceChange={onPathPreferenceChange}
                  onUpdate={setUpdateTarget}
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
              <ConnectionTraffic traffic={peerLinks.traffic} />
            </SettingsCard>
          </>
        )}
      </section>
      {dialog}
      <ConfirmDialog
        open={updateTarget !== null}
        onOpenChange={(open) => {
          if (!open && !updateSubmitting) setUpdateTarget(null);
        }}
        title={t(
          updateTarget?.isSelf
            ? 'settings.remoteControl.v2.peerUpdate.confirm.selfTitle'
            : 'settings.remoteControl.v2.peerUpdate.confirm.title',
          { name: updateTarget?.deviceName ?? '' },
        )}
        description={t(
          updateTarget?.isSelf
            ? 'settings.remoteControl.v2.peerUpdate.confirm.selfDescription'
            : 'settings.remoteControl.v2.peerUpdate.confirm.description',
          {
            from: updateTarget?.currentVersion ?? '',
            to: updateTarget?.targetVersion ?? '',
          },
        )}
        content={
          updateTarget && (updateTarget.busy || updateTarget.platform === 'linux' || updateTarget.platform === 'win32') ? (
            <div className="flex flex-col gap-1.5 text-12 leading-[1.5]">
              {updateTarget.busy ? (
                <p className="text-[var(--warning-fg)]">
                  {t(
                    updateTarget.isSelf
                      ? 'settings.remoteControl.v2.peerUpdate.confirm.selfBusyWarning'
                      : 'settings.remoteControl.v2.peerUpdate.confirm.busyWarning',
                  )}
                </p>
              ) : null}
              {updateTarget.platform === 'linux' ? (
                <p className="text-[var(--text-secondary)]">
                  {t('settings.remoteControl.v2.peerUpdate.confirm.linuxPermissionHint')}
                </p>
              ) : updateTarget.platform === 'win32' && !updateTarget.isSelf ? (
                <p className="text-[var(--text-secondary)]">
                  {t('settings.remoteControl.v2.peerUpdate.confirm.windowsPermissionHint')}
                </p>
              ) : null}
            </div>
          ) : undefined
        }
        confirmText={t('settings.remoteControl.v2.peerUpdate.confirm.action')}
        loading={updateSubmitting}
        onConfirm={() => void onConfirmUpdate()}
      />
    </>
  );
}
