/**
 * DeviceNodePopover —— 点一台设备 / 这台电脑后的卡片(共享 Popover,不透明)。
 * ---------------------------------------------------------------------------
 * 拓扑图只管拓扑(用户裁决 2026-11-07):卡片只展示连接信息——名字、型号 / 系统 / 版本、状态、路径、
 * 消息、最近测得的往返、最后在线、谁在控制本机,能远程时给「远程桌面」;这台电脑的卡片是与中转的连接、
 * 连接问题与待机说明,「管理设备…」定位到上方「我的设备」的本机卡片(其它设备不再列在那里)。
 */

import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { DeviceLinkLinkStatus } from '@/hooks/useDeviceLinkSettings';

import { PlatformGlyph } from './PlatformGlyph';
import type { TopologyModel, TopologyNode } from './topologyModel';
import { flowLabel, formatRtt, pathLabel, platformLabel, protocolLabel, relativeTime } from './topologyPresentation';

/** 卡片里的「路径」只写怎么连;要处理的原因写在「状态」里。 */
function routeOf(node: TopologyNode): TopologyNode {
  return node.attention ? { ...node, attention: null } : node;
}

function Row({ label, value, valueClassName }: { label: string; value: string; valueClassName?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-12">
      <span className="shrink-0 text-[var(--text-tertiary)]">{label}</span>
      <span className={cn('min-w-0 truncate text-right', valueClassName ?? 'text-[var(--text-primary)]')} title={value}>
        {value}
      </span>
    </div>
  );
}

function Heading({
  name,
  sub,
  platform,
  isMobile,
}: {
  name: string;
  sub: string;
  platform: string | null;
  isMobile: boolean;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      {/* 与拓扑同一套外形:电脑方块,手机带「灵动岛」的竖条 */}
      <span className="flex size-8 shrink-0 items-center justify-center" aria-hidden>
        <span
          className={cn(
            'rcv2-tile relative flex items-center justify-center rounded-lg border',
            isMobile ? 'h-8 w-5' : 'size-8',
          )}
          data-form={isMobile ? 'phone' : undefined}
        >
          {isMobile ? <span className="rcv2-island" /> : null}
          <PlatformGlyph platform={platform} isMobile={isMobile} size={isMobile ? 12 : 15} />
        </span>
      </span>
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-13 font-medium text-[var(--text-primary)]" title={name}>
          {name}
        </span>
        {sub ? (
          <span className="truncate text-12 text-[var(--text-secondary)]" title={sub}>
            {sub}
          </span>
        ) : null}
      </div>
    </div>
  );
}

export function DeviceNodePopover({
  node,
  relayName,
  onRemoteDesktop,
}: {
  node: TopologyNode;
  relayName: string;
  onRemoteDesktop: (node: TopologyNode) => void;
}) {
  const { t } = useTranslation();
  const sub = [
    node.modelLabel,
    platformLabel(node.platform),
    node.appVersion?.trim() ? t('settings.remoteControl.v2.popover.version', { version: node.appVersion.trim() }) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  // 要处理的设备,「状态」直接写原因(红);拓扑上没有别处列问题,点开卡片就能看到(用户裁决 2026-11-07)。
  const statusText =
    node.status === 'offline'
      ? t('settings.remoteControl.v2.path.offline')
      : node.status === 'attention'
        ? pathLabel(node, relayName, t)
        : node.busy
          ? t('settings.devices.status.busy')
          : t('settings.devices.status.online');
  const statusClass =
    node.status === 'attention'
      ? 'text-[var(--error-fg)]'
      : node.status !== 'offline' && node.busy
        ? 'text-[var(--warning-accent)]'
        : undefined;
  const canRemoteDesktop =
    node.status !== 'offline' && !node.isMobile && node.remoteControlEnabled && node.controlEnabled;
  return (
    <div className="flex flex-col gap-3">
      <Heading name={node.name} sub={sub} platform={node.platform} isMobile={node.isMobile} />
      <div className="flex flex-col gap-1.5">
        {/* 与拓扑同一套颜色:要处理是红、忙碌是心动橙(卡片在 Popover 里,拿不到拓扑容器上的变量,直接用全局 token) */}
        <Row label={t('settings.remoteControl.v2.popover.status')} value={statusText} valueClassName={statusClass} />
        {node.status !== 'offline' ? (
          <Row label={t('settings.remoteControl.v2.popover.path')} value={[protocolLabel(node, t), pathLabel(routeOf(node), relayName, t)].filter(Boolean).join(' · ')} />
        ) : null}
        {node.flow ? (
          <Row label={t('settings.remoteControl.v2.popover.activity')} value={flowLabel(node.flowText ?? node.flow, t)} />
        ) : null}
        {node.rttMs !== null ? (
          <Row
            label={t('settings.remoteControl.v2.popover.latency')}
            value={`${formatRtt(node.rttMs, t)} · ${t('settings.remoteControl.v2.popover.rttNote')}`}
          />
        ) : null}
        {node.path ? (
          <Row label={t('settings.remoteControl.v2.popover.encryption')} value={t(node.encrypted === true
            ? 'settings.remoteControl.v2.popover.encrypted' : node.encrypted === false
              ? 'settings.remoteControl.v2.popover.legacyConnection' : 'settings.remoteControl.v2.popover.encryptionUnknown')} />
        ) : null}
        {node.path && node.encrypted === false ? (
          <p className="text-12 leading-[1.5] text-[var(--text-secondary)]">{t('settings.remoteControl.v2.popover.legacyEncryptionHint')}</p>
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
      {canRemoteDesktop ? (
        <div className="flex justify-end">
          <Button variant="primary" size="sm" compact onClick={() => onRemoteDesktop(node)}>
            {t('remoteDesktop.title')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function HubNodePopover({
  model,
  linkStatus,
  issue,
  standby,
  selfDeviceId,
  onManage,
}: {
  model: TopologyModel;
  linkStatus: DeviceLinkLinkStatus;
  /** 连接问题的说明;没有为 null */
  issue: string | null;
  /** 本机另一个 Cindy 实例占着远程连接 */
  standby: boolean;
  selfDeviceId: string | null;
  onManage: (deviceId: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-3">
      <Heading
        name={model.self?.name ?? t('settings.remoteControl.v2.node.thisComputer')}
        sub={platformLabel(model.self?.platform ?? null)}
        platform={model.self?.platform ?? null}
        isMobile={false}
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
        {issue ? <span className="text-12 text-[var(--error-fg)]">{issue}</span> : null}
        {standby ? <span className="text-12 text-[var(--text-tertiary)]">{t('settings.devices.standbyHint')}</span> : null}
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
