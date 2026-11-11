import { remoteControlSettings } from './RemoteControlSection.settings-search';
/**
 * RemoteControlSection —— 统一的「远程控制」设置页。
 *
 * 合并原「设备互联」(device-link)与「远端机器」(SSH)两个入口,两块功能在同一页内上下排列:
 *   1. 我的设备:同账号设备一处管理 —— 本机承载被控总开关 + relay 状态,其余设备逐台管
 *      「我控制它 / 允许它控制本机」+ 重命名 / 删除(MyDevicesPanel)
 *   2. SSH:原 RemoteSection 原样嵌入(showTitle=false,标题由本页统一给)
 * (Slack 连接子块已迁至「IM 机器人」页 Cindy 栏, 见 ImBotSection.tsx + HookConnectionsSection.tsx)
 *
 * 「Agent-Net (Beta)」开关(useRemoteConnectionV2,默认关，由主进程保存并切换这台电脑的传输):
 * 打开后「我的设备」只留本机卡片(改名、允许控制本机、远程桌面等),下面紧接拓扑图
 * (features/remote-connection-v2);其它设备不再列出,在拓扑里看(用户裁决 2026-11-07)。
 * 关闭时与原来完全一致。连接线路与 SSH 开不开都一样。设备深链在打开时:本机定位本机卡片,
 * 其它设备打开拓扑里那台设备的卡片(useRemoteDevicesDeepLink 给出聚焦目标)。
 *
 * 两个子块都是无上限列表,页面默认全部收起;收起态 header 右侧带状态摘要,
 * 各子块独立展开,状态不持久化(刷新回默认,与 PinnedSection 先例一致)。
 * 「我的设备」的本机卡(被控总开关 + relay 状态)是全页最常用控件,以 pinned
 * 形式常驻折叠区外,折叠只收其它设备列表。收起只做 CSS 隐藏、内容保持挂载:
 * 子组件的数据订阅与内联编辑状态不因折叠丢失,展开瞬间无重新加载跳变(规则 7)。
 *
 * device-link 数据(开关 / 设备列表 / controlledBy)由 useDeviceLinkSettings 取一份;
 * SSH 主机摘要由本组件自取轻量快照(list + onStatusChanged),不侵入 RemoteSection。
 */

import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';

import { useDeviceLinkSettings, type DeviceLinkSettings } from '@/hooks/useDeviceLinkSettings';
import { Switch } from '@/components/ui/switch';
import { MyDevicesPanel } from './MyDevicesPanel';
import { RelayServicePanel, useSelfHostedRelayState } from './RelayServicePanel';
import { RemoteDesktopSetting } from './RemoteDesktopSetting';
import { RemoteSection } from './RemoteSection';
import { CollapsibleSubSection } from './CollapsibleSubSection';
import { useRemoteDevicesDeepLink } from './useRemoteDevicesDeepLink';
import { useAuth } from '@/contexts/AuthContext';
import { useSettingsSearchNavigation } from './SettingsSearchNavigation';
import { useRemoteConnectionV2 } from '@/features/remote-connection-v2/useRemoteConnectionV2';
import { RemoteConnectionV2Section } from '@/features/remote-connection-v2/RemoteConnectionV2Section';
import { toast } from '@/lib/toast';
import { SETTINGS_SECTION_TITLE_CLASS, SettingsCard, SettingsPageHeader, SettingsRow } from '@/components/ui/settings-rows';

export { CollapsibleSubSection } from './CollapsibleSubSection';

/** SSH 状态 → 摘要状态点的优先级:有已连接给绿,其次进行中给橙,再次失败给红,否则灰。 */
const SSH_PROGRESS_STATUSES: ReadonlySet<RemoteHostSnapshot['status']> = new Set([
  'connecting',
  'authenticating',
  'reconnecting',
]);

/**
 * 「我的设备」收起态摘要:其它设备数量。本机卡常驻外层,relay 状态与被控开关
 * 在卡上直接可见,摘要不再重复;状态点也免了(本机卡自带)。
 */
function deviceSummary(
  s: DeviceLinkSettings,
  t: (k: string, o?: Record<string, unknown>) => string,
): string | null {
  if (s.devices === null) return null;
  const others = s.devices.filter((d) => !d.isSelf).length;
  return others === 0
    ? t('settings.remoteControl.summary.noOtherDevices')
    : t('settings.remoteControl.summary.otherDevices', { count: others });
}

/** 「SSH」收起态摘要:主机数 + 已连接数。 */
function sshSummary(
  hosts: RemoteHostSnapshot[] | null,
  t: (k: string, o?: Record<string, unknown>) => string,
): { text: string; dot: string } | null {
  if (hosts === null) return null;
  if (hosts.length === 0) {
    return {
      text: t('settings.remoteControl.summary.noHosts'),
      dot: 'var(--remote-status-disconnected)',
    };
  }
  const connected = hosts.filter((h) => h.status === 'ready').length;
  const inProgress = hosts.some((h) => SSH_PROGRESS_STATUSES.has(h.status));
  const failed = hosts.some((h) => h.status === 'failed');
  const parts = [t('settings.remoteControl.summary.hostCount', { count: hosts.length })];
  if (connected > 0) {
    parts.push(t('settings.remoteControl.summary.hostsConnected', { count: connected }));
  }
  const dot =
    connected > 0
      ? 'var(--remote-status-ready)'
      : inProgress
        ? 'var(--remote-status-progress)'
        : failed
          ? 'var(--remote-status-failed)'
          : 'var(--remote-status-disconnected)';
  return { text: parts.join(' · '), dot };
}

export function RemoteControlSection() {
  const { entry, activation } = useSettingsSearchNavigation();
  const { t } = useTranslation();
  const { mode } = useAuth();
  const deviceLinkAvailable = mode === 'cloud';
  const s = useDeviceLinkSettings(deviceLinkAvailable);
  const v2 = useRemoteConnectionV2();
  useEffect(() => {
    const report = (event: Event) => {
      const code = (event as CustomEvent<{ code: string }>).detail?.code;
      const known = ['NOT_SIGNED_IN', 'SECURE_STORAGE_UNAVAILABLE', 'PORT_IN_USE', 'START_FAILED', 'FAILED'].includes(code) ? code : 'FAILED';
      toast.error(t(`settings.remoteControl.relay.errors.${known}`));
    };
    window.addEventListener('agent-net-preference-error', report);
    return () => window.removeEventListener('agent-net-preference-error', report);
  }, [t]);
  const deepLink = useRemoteDevicesDeepLink();
  const relay = useSelfHostedRelayState(deviceLinkAvailable);
  const location = useLocation();
  const [sshOpen, setSshOpen] = useState(
    () => new URLSearchParams(location.search).get('section') === 'remoteControl.ssh',
  );

  // SSH 主机轻量快照 —— 只为收起态摘要服务。RemoteSection 内部自管自己的一份;
  // 这里不外提它的状态是有意的(979 行组件不为一行摘要重构)。
  const [hosts, setHosts] = useState<RemoteHostSnapshot[] | null>(null);

  useLayoutEffect(() => {
    if (entry?.targetId === 'settings-search-target-remote-ssh') setSshOpen(true);
  }, [entry, activation]);

  const refreshHosts = useCallback(async () => {
    try {
      const res = await window.electronAPI.remoteSsh.list();
      setHosts(res.hosts);
    } catch {
      // 摘要是 best-effort:失败保持 null 不显示;真实错误由展开后的 RemoteSection 呈现
    }
  }, []);

  useEffect(() => {
    void refreshHosts();
    const off = window.electronAPI.remoteSsh.onStatusChanged((snap) => {
      setHosts((prev) => {
        if (!prev) return prev;
        const idx = prev.findIndex((h) => h.config.id === snap.config.id);
        if (idx < 0) return [...prev, snap];
        const copy = prev.slice();
        copy[idx] = snap;
        return copy;
      });
    });
    const offHosts = window.electronAPI.remoteSsh.onHostsChanged?.((result) => setHosts(result.hosts));
    return () => {
      off();
      offHosts?.();
    };
  }, [refreshHosts]);

  // 每次开合都重拉一次快照:RemoteSection 里的添加 / 删除不广播列表变更,
  // 收起瞬间重新同步,避免摘要计数漂移。
  const toggleSsh = useCallback(() => {
    setSshOpen((v) => !v);
    void refreshHosts();
  }, [refreshHosts]);

  const devSumText = deviceSummary(s, t);
  const sshSum = sshSummary(hosts, t);

  return (
    <div className="flex flex-col gap-2">
      <SettingsPageHeader
        title={t('settings.remoteControl.title')}
        description={t('settings.remoteControl.description')}
      />

      <div className="mt-4 flex flex-col gap-6">
        {deviceLinkAvailable ? (
          <SettingsCard id={remoteControlSettings.v2.targetId}>
            <SettingsRow
              title={t(remoteControlSettings.v2.titleKey)}
              hint={t(remoteControlSettings.v2.descriptionKey)}
              trailing={
                <Switch
                  data-setting-id={remoteControlSettings.v2.id}
                  checked={v2.enabled}
                  onCheckedChange={v2.setEnabled}
                  aria-label={t(remoteControlSettings.v2.titleKey)}
                />
              }
            />
            {v2.enabled ? (
              <SettingsRow
                id={remoteControlSettings.onlyEncrypted.targetId}
                title={t(remoteControlSettings.onlyEncrypted.titleKey)}
                hint={t(remoteControlSettings.onlyEncrypted.descriptionKey)}
                trailing={<Switch data-setting-id={remoteControlSettings.onlyEncrypted.id} checked={v2.onlyEncrypted} onCheckedChange={v2.setOnlyEncrypted} aria-label={t(remoteControlSettings.onlyEncrypted.titleKey)} />}
              />
            ) : null}
          </SettingsCard>
        ) : null}

        {deviceLinkAvailable && v2.enabled ? (
          <>
            {/* Agent-Net:「我的设备」只留本机卡片,其它设备在下面的拓扑里看 */}
            <section id={remoteControlSettings.devices.targetId} className="flex flex-col gap-3">
              <h3 className="text-14 font-medium text-[var(--text-primary)]">{t(remoteControlSettings.devices.titleKey)}</h3>
              <MyDevicesPanel
                s={s}
                variant="self"
                selfSettings={<RemoteDesktopSetting />}
                focusDeviceId={deepLink.focusDeviceId}
                focusRequestKey={deepLink.focusRequestKey}
              />
            </section>
            <RemoteConnectionV2Section s={s} relay={relay} deepLink={deepLink} />
          </>
        ) : null}

        {deviceLinkAvailable ? (
          <>
            {v2.enabled ? null : (
              <CollapsibleSubSection
                id={remoteControlSettings.devices.targetId}
                title={t(remoteControlSettings.devices.titleKey)}
                summary={devSumText}
                dotColor={null}
                open={deepLink.devicesOpen}
                onToggle={deepLink.toggleDevices}
                pinned={
                  <MyDevicesPanel
                    s={s}
                    variant="self"
                    selfSettings={<RemoteDesktopSetting />}
                    focusDeviceId={deepLink.focusDeviceId}
                    focusRequestKey={deepLink.focusRequestKey}
                  />
                }
              >
                <MyDevicesPanel
                  s={s}
                  variant="others"
                  focusDeviceId={deepLink.focusDeviceId}
                  focusRequestKey={deepLink.focusRequestKey}
                />
              </CollapsibleSubSection>
            )}
            {/* 设备之间经哪条线路连接:紧跟在「我的设备」下面直接展示,当前线路一眼可见,不再单独占一个入口。 */}
            <section id={remoteControlSettings.relay.targetId} className="flex flex-col gap-3">
              <div className="flex flex-col gap-0.5">
                <h3 className={SETTINGS_SECTION_TITLE_CLASS}>
                  {t(remoteControlSettings.relay.titleKey)}
                </h3>
                <p className="text-12 leading-[1.5] text-[var(--text-tertiary)]">
                  {t('settings.remoteControl.relay.route.hint')}
                </p>
              </div>
              <RelayServicePanel controller={relay} />
            </section>
            <div className="h-px w-full bg-[var(--border-default)]" />
          </>
        ) : null}

        <CollapsibleSubSection
          id={remoteControlSettings.ssh.targetId}
          title={t(remoteControlSettings.ssh.titleKey)}
          summary={sshSum?.text ?? null}
          dotColor={sshSum?.dot ?? null}
          open={sshOpen}
          onToggle={toggleSsh}
        >
          <RemoteSection showTitle={false} />
        </CollapsibleSubSection>
      </div>
    </div>
  );
}
