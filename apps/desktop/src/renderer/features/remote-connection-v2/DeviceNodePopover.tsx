/**
 * DeviceNodePopover —— 点一台设备 / 这台电脑后的浮层内容(共享 Popover,不透明)。
 * 只展示现有数据:名字、型号 / 系统 / 版本、状态、路径、最近测得的往返、最后在线、
 * 谁在控制本机;动作只有「远程桌面」和「管理设备…」(展开下方列表并定位那一行)。
 */

import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import type { DeviceLinkLinkStatus } from '@/hooks/useDeviceLinkSettings';

import type { TopologyModel, TopologyNode } from './topologyModel';
import { formatRtt, pathLabel, platformLabel, relativeTime } from './topologyPresentation';

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-12">
      <span className="shrink-0 text-[var(--text-tertiary)]">{label}</span>
      <span className="min-w-0 truncate text-right text-[var(--text-primary)]" title={value}>
        {value}
      </span>
    </div>
  );
}

function Heading({ name, sub }: { name: string; sub: string }) {
  return (
    <div className="flex min-w-0 flex-col">
      <span className="truncate text-13 font-medium text-[var(--text-primary)]" title={name}>
        {name}
      </span>
      <span className="truncate text-12 text-[var(--text-secondary)]" title={sub}>
        {sub}
      </span>
    </div>
  );
}

export function DeviceNodePopover({
  node,
  relayName,
  onRemoteDesktop,
  onManage,
}: {
  node: TopologyNode;
  relayName: string;
  onRemoteDesktop: (node: TopologyNode) => void;
  onManage: (deviceId: string) => void;
}) {
  const { t } = useTranslation();
  const sub = [
    node.modelLabel,
    platformLabel(node.platform),
    node.appVersion?.trim() ? t('settings.remoteControl.v2.popover.version', { version: node.appVersion.trim() }) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const statusText =
    node.status === 'offline'
      ? t('settings.remoteControl.v2.path.offline')
      : node.busy
        ? t('settings.devices.status.busy')
        : t('settings.devices.status.online');
  const canRemoteDesktop =
    node.status !== 'offline' && !node.isMobile && node.remoteControlEnabled && node.controlEnabled;
  return (
    <div className="flex flex-col gap-3">
      <Heading name={node.name} sub={sub} />
      <div className="flex flex-col gap-1.5">
        <Row label={t('settings.remoteControl.v2.popover.status')} value={statusText} />
        {node.status !== 'offline' ? (
          <Row label={t('settings.remoteControl.v2.popover.path')} value={pathLabel(node, relayName, t)} />
        ) : null}
        {node.rttMs !== null ? (
          <Row
            label={t('settings.remoteControl.v2.popover.latency')}
            value={`${formatRtt(node.rttMs, t)} · ${t('settings.remoteControl.v2.popover.rttNote')}`}
          />
        ) : null}
        {node.status === 'offline' ? (
          <Row label={t('settings.remoteControl.v2.popover.lastSeen')} value={relativeTime(node.lastSeenAt, t)} />
        ) : null}
        {node.controlling ? (
          <span className="text-12 text-[var(--text-secondary)]">
            {t('settings.remoteControl.v2.popover.controlling')}
          </span>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button variant="secondary" size="sm" compact onClick={() => onManage(node.id)}>
          {t('settings.remoteControl.v2.popover.manage')}
        </Button>
        {canRemoteDesktop ? (
          <Button variant="primary" size="sm" compact onClick={() => onRemoteDesktop(node)}>
            {t('remoteDesktop.title')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function HubNodePopover({
  model,
  linkStatus,
  enabled,
  onEnabledChange,
  selfDeviceId,
  onManage,
}: {
  model: TopologyModel;
  linkStatus: DeviceLinkLinkStatus;
  enabled: boolean;
  onEnabledChange: (next: boolean) => void;
  selfDeviceId: string | null;
  onManage: (deviceId: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-3">
      <Heading
        name={model.self?.name ?? t('settings.remoteControl.v2.node.thisComputer')}
        sub={platformLabel(model.self?.platform ?? null)}
      />
      <div className="flex flex-col gap-1.5">
        <Row
          label={t('settings.remoteControl.v2.popover.linkStatus', { name: model.relay.name })}
          value={
            model.relay.rttMs !== null && linkStatus === 'online'
              ? `${t(`settings.devices.linkStatus.${linkStatus}`)} · ${formatRtt(model.relay.rttMs, t)}`
              : t(`settings.devices.linkStatus.${linkStatus}`)
          }
        />
        <label className="flex items-center justify-between gap-3 text-12">
          <span className="text-[var(--text-primary)]">{t('settings.devices.allowControl')}</span>
          <Switch checked={enabled} onCheckedChange={onEnabledChange} aria-label={t('settings.devices.allowControl')} />
        </label>
      </div>
      {selfDeviceId ? (
        <div className="flex justify-end">
          <Button variant="secondary" size="sm" compact onClick={() => onManage(selfDeviceId)}>
            {t('settings.remoteControl.v2.popover.manage')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
