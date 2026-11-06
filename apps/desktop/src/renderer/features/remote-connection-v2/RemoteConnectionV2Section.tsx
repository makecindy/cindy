/**
 * RemoteConnectionV2Section —— 「远程连接」页打开「新版连接」后的同账号设备部分。
 * ---------------------------------------------------------------------------
 * 自上而下:一行数字(几台在线、几台直连 / 经中转 / 要处理 / 离线)+ 与中转的连接状态 →
 * 拓扑图 → 「需要处理 / 最近」两个标签 → 连接线路(RelayServicePanel,原样)→
 * 可折叠的设备列表(MyDevicesPanel,本机常驻、其它设备在折叠区)。SSH 由外层页面继续负责。
 *
 * 数据:设备目录与开关来自 useDeviceLinkSettings(与旧版同一份);本机已建链对端的路径 / 往返
 * 来自 usePeerLinks(新 IPC);中转名来自 useSelfHostedRelayState;无响应熔断来自
 * unresponsiveDevicesStore。拓扑只画真实存在的数据,没有的(流量、第三方链路)不画。
 */

import { useCallback, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { SegmentedControl } from '@/components/ui/segmented-control';
import { Switch } from '@/components/ui/switch';
import { SETTINGS_CARD_CLASS } from '@/components/settings/settingsRowClasses';
import { MyDevicesPanel } from '@/components/settings/MyDevicesPanel';
import { RelayServicePanel, type SelfHostedRelayController } from '@/components/settings/RelayServicePanel';
import { CollapsibleSubSection } from '@/components/settings/CollapsibleSubSection';
import type { RemoteDevicesDeepLink } from '@/components/settings/useRemoteDevicesDeepLink';
import type { DeviceLinkSettings } from '@/hooks/useDeviceLinkSettings';
import { unresponsiveDevicesStore } from '@/features/device-link/unresponsiveDevicesStore';
import { toast } from '@/lib/toast';
import { createLogger } from '@/lib/logger';

import { RemoteConnectionTopology } from './RemoteConnectionTopology';
import { buildTopology, type TopologyModel, type TopologyNode } from './topologyModel';
import { pathLabel, relativeTime } from './topologyPresentation';
import { usePeerLinks } from './usePeerLinks';
import { useRecentPresence } from './useRecentPresence';

const log = createLogger('RemoteConnectionV2Section');

type Tab = 'todo' | 'recent';

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

function ListCard({ children }: { children: ReactNode }) {
  return <div className={SETTINGS_CARD_CLASS}>{children}</div>;
}

function ListRow({ title, sub, trailing }: { title: string; sub?: string | null; trailing?: ReactNode }) {
  return (
    <li className="flex items-center justify-between gap-3 px-4 py-2.5">
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-13 text-[var(--text-primary)]" title={title}>
          {title}
        </span>
        {sub ? (
          <span className="truncate text-12 text-[var(--text-secondary)]" title={sub}>
            {sub}
          </span>
        ) : null}
      </div>
      {trailing}
    </li>
  );
}

function EmptyRow({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex flex-col px-4 py-3">
      <span className="text-13 text-[var(--text-secondary)]">{title}</span>
      {hint ? <span className="text-12 text-[var(--text-tertiary)]">{hint}</span> : null}
    </div>
  );
}

export function RemoteConnectionV2Section({
  s,
  relay,
  deepLink,
  selfSettings,
}: {
  s: DeviceLinkSettings;
  relay: SelfHostedRelayController;
  deepLink: RemoteDevicesDeepLink;
  /** 本机卡上的附加设置(远程桌面),与旧版页面同一份。 */
  selfSettings?: ReactNode;
}) {
  const { t } = useTranslation();
  const peerLinks = usePeerLinks(true);
  const recent = useRecentPresence(true);
  const unresponsive = useSyncExternalStore(unresponsiveDevicesStore.subscribe, unresponsiveDevicesStore.getSnapshot);
  const [showOffline, setShowOffline] = useState(false);
  const [tab, setTab] = useState<Tab>('todo');

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

  const onRemoteDesktop = useCallback((node: TopologyNode) => {
    window.electronAPI.openRemoteDesktop({ deviceId: node.id, name: node.name }).catch((err: unknown) => {
      log.warn('openRemoteDesktop failed', err);
      toast.error(t('settings.remoteControl.v2.popover.remoteDesktopFailed'));
    });
  }, [t]);

  const todo: Array<{ key: string; title: string; sub: string | null; trailing?: ReactNode }> = [];
  if (!s.enabled) {
    todo.push({
      key: 'master-off',
      title: t('settings.remoteControl.v2.attention.masterOff'),
      sub: t('settings.devices.allowControl'),
      trailing: (
        <Switch checked={s.enabled} onCheckedChange={(next) => void s.setEnabled(next)} aria-label={t('settings.devices.allowControl')} />
      ),
    });
  }
  if (s.connectionIssue) {
    todo.push({
      key: 'connection-issue',
      title: t('settings.remoteControl.v2.attention.connectionIssue'),
      sub: t(`settings.devices.linkStatus.${s.linkStatus}`),
    });
  }
  for (const node of model.nodes) {
    if (node.status !== 'attention') continue;
    todo.push({ key: node.id, title: node.name, sub: pathLabel(node, relayName, t) });
  }

  const linkStatusText = t(`settings.devices.linkStatus.${s.linkStatus}`);
  const offlineToggleVisible = model.stats.offline >= 2;

  return (
    <>
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-12">
          <span className="text-[var(--text-secondary)]">{statsLine(model, t)}</span>
          <span className="text-[var(--text-tertiary)]">{linkStatusText}</span>
        </div>
        <div className={SETTINGS_CARD_CLASS}>
          <div className="px-2 py-3">
            {model.nodes.length === 0 ? (
              <p className="px-2 py-6 text-center text-13 text-[var(--text-secondary)]">
                {t('settings.remoteControl.v2.empty')}
              </p>
            ) : null}
            <RemoteConnectionTopology
              model={model}
              linkStatus={s.linkStatus}
              controlEnabled={s.enabled}
              onControlEnabledChange={(next) => void s.setEnabled(next)}
              selfDeviceId={self?.deviceId ?? null}
              onToggleOffline={() => setShowOffline((v) => !v)}
              onRemoteDesktop={onRemoteDesktop}
              onManage={deepLink.openDevice}
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
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <SegmentedControl<Tab>
          value={tab}
          onValueChange={setTab}
          role="tablist"
          aria-label={t('settings.remoteControl.v2.tabs.aria')}
          height={28}
          optionHeight={24}
          options={[
            { value: 'todo', label: todo.length ? `${t('settings.remoteControl.v2.tabs.todo')} · ${todo.length}` : t('settings.remoteControl.v2.tabs.todo') },
            { value: 'recent', label: t('settings.remoteControl.v2.tabs.recent') },
          ]}
        />
        <ListCard>
          {tab === 'todo' ? (
            todo.length ? (
              <ul className="flex flex-col divide-y divide-[var(--settings-theme-card-border)]">
                {todo.map((item) => (
                  <ListRow key={item.key} title={item.title} sub={item.sub} trailing={item.trailing} />
                ))}
              </ul>
            ) : (
              <EmptyRow title={t('settings.remoteControl.v2.todo.empty')} hint={t('settings.remoteControl.v2.todo.emptyHint')} />
            )
          ) : recent.length ? (
            <ul className="flex flex-col divide-y divide-[var(--settings-theme-card-border)]">
              {recent.map((e) => (
                <ListRow
                  key={`${e.deviceId}:${e.at}`}
                  title={t(e.online ? 'settings.remoteControl.v2.recent.online' : 'settings.remoteControl.v2.recent.offline', { name: e.name })}
                  sub={relativeTime(new Date(e.at).toISOString(), t)}
                />
              ))}
            </ul>
          ) : (
            <EmptyRow title={t('settings.remoteControl.v2.recent.empty')} />
          )}
        </ListCard>
      </section>

      <section id="settings-search-target-remote-relay" className="flex flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <h3 className="text-14 font-medium text-[var(--text-primary)]">
            {t('settings.remoteControl.relay.route.title')}
          </h3>
          <p className="text-12 leading-[1.5] text-[var(--text-tertiary)]">
            {t('settings.remoteControl.relay.route.hint')}
          </p>
        </div>
        <RelayServicePanel controller={relay} />
      </section>

      <CollapsibleSubSection
        id="settings-search-target-remote-devices"
        title={t('settings.remoteControl.v2.sections.devicesList')}
        summary={
          s.devices === null
            ? null
            : model.stats.total === 0
              ? t('settings.remoteControl.summary.noOtherDevices')
              : t('settings.remoteControl.summary.otherDevices', { count: model.stats.total })
        }
        dotColor={null}
        open={deepLink.devicesOpen}
        onToggle={deepLink.toggleDevices}
        pinned={
          <MyDevicesPanel
            s={s}
            variant="self"
            selfSettings={selfSettings}
            focusDeviceId={deepLink.focusDeviceId}
            focusRequestKey={deepLink.focusRequestKey}
          />
        }
      >
        <MyDevicesPanel s={s} variant="others" focusDeviceId={deepLink.focusDeviceId} focusRequestKey={deepLink.focusRequestKey} />
      </CollapsibleSubSection>
      <div className="h-px w-full bg-[var(--border-default)]" />
    </>
  );
}
