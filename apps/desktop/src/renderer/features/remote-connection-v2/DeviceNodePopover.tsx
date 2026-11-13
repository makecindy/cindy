/**
 * DeviceNodePopover —— 点一台设备 / 这台电脑后的卡片(共享 Popover,不透明)。
 * ---------------------------------------------------------------------------
 * 拓扑图只管拓扑(用户裁决 2026-11-07):卡片只展示连接信息——名字、型号 / 系统 / 版本、状态、路径、
 * 消息、最近测得的往返、最后在线、谁在控制本机,能远程时给「远程桌面」;这台电脑的卡片是与中转的连接、
 * 连接问题与待机说明。本机设置直接使用同页上方「我的设备」的本机卡片。
 * 原型(规则见 agent-net.md「远程切换其他电脑的连接方式」):设备卡片底部可以远程切换对方的连接方式
 * (切到 Agent-Net / 切回 Device Link)。打开卡片先问对方能不能切；切换中列出三步，没连回来时写已自动退回；
 * 切不了的写原因。见 agentNetRemoteSwitch.ts。
 */

import { useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import type { DeviceLinkLinkStatus } from '@/hooks/useDeviceLinkSettings';

import {
  probePeer,
  remoteSwitchAvailability,
  remoteSwitchStore,
  switchProbeKind,
  type PeerProbe,
  type RemoteSwitchEntry,
  type RemoteSwitchStep,
  type RemoteSwitchTarget,
} from './agentNetRemoteSwitch';
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

const STEPS: readonly RemoteSwitchStep[] = ['request', 'reconnect', 'confirm'];

function stepText(step: RemoteSwitchStep, target: RemoteSwitchTarget, t: (k: string) => string): string {
  const to = target === 'agent-net' ? 'agentNet' : 'deviceLink';
  if (step === 'request') return t(`settings.remoteControl.v2.peerSwitch.steps.request.${to}`);
  if (step === 'confirm') return t(`settings.remoteControl.v2.peerSwitch.steps.confirm.${to}`);
  return t(`settings.remoteControl.v2.peerSwitch.steps.${step}`);
}

/** 切换中:三步，做完的打勾、正在做的转圈；没连回来时第三步换成「正在退回」(红)。 */
function SwitchSteps({ entry }: { entry: Extract<RemoteSwitchEntry, { kind: 'running' }> }) {
  const { t } = useTranslation();
  const current = entry.step === 'revert' ? 2 : STEPS.indexOf(entry.step);
  return (
    <>
      <ol className="flex flex-col gap-1.5 text-12">
        {STEPS.map((step, i) => {
          const reverting = i === 2 && entry.step === 'revert';
          const state = i < current ? 'done' : i === current ? 'now' : 'todo';
          return (
            <li
              key={step}
              className={cn(
                'flex items-center gap-2',
                reverting
                  ? 'text-[var(--error-fg)]'
                  : state === 'done'
                    ? 'text-[var(--text-secondary)]'
                    : state === 'now'
                      ? 'text-[var(--text-primary)]'
                      : 'text-[var(--text-tertiary)]',
              )}
            >
              <span className="flex size-3.5 shrink-0 items-center justify-center" aria-hidden>
                {state === 'done' ? (
                  <Check size={12} />
                ) : state === 'now' ? (
                  <Spinner size={12} />
                ) : (
                  <span className="size-1 rounded-full bg-current" />
                )}
              </span>
              {reverting ? t('settings.remoteControl.v2.peerSwitch.steps.revert') : stepText(step, entry.target, t)}
            </li>
          );
        })}
      </ol>
      <p className="text-12 leading-[1.5] text-[var(--text-tertiary)]">{t('settings.remoteControl.v2.peerSwitch.closeHint')}</p>
    </>
  );
}

const CHECKING: PeerProbe = { kind: 'checking' };
const selectProbes = () => remoteSwitchStore.getSnapshot().probes;

/**
 * 卡片底部切换区的说明文字与按钮;没有可说的就都为 null。打开卡片时先问对方一次(probePeer):
 * 旧版 Cindy 写「需要更新」，打不开 Agent-Net 写原因，都不给按钮。
 */
function useSwitchArea(
  node: TopologyNode,
  entry: RemoteSwitchEntry | null,
  onSwitch: ((node: TopologyNode, target: RemoteSwitchTarget) => void) | undefined,
): { body: ReactNode; action: ReactNode } {
  const { t } = useTranslation();
  const probes = useSyncExternalStore(remoteSwitchStore.subscribe, selectProbes);
  const availability = remoteSwitchAvailability(node);
  const shouldAsk = !!onSwitch && availability.visible && availability.block === null && entry?.kind !== 'running';
  useEffect(() => {
    if (shouldAsk) void probePeer(node.id);
  }, [shouldAsk, node.id]);
  // 切换中对方会短暂断开(图块落到「未建链」)，步骤照常显示。
  if (onSwitch && entry?.kind === 'running') return { body: <SwitchSteps entry={entry} />, action: null };
  if (!onSwitch || !availability.visible) return { body: null, action: null };
  const hint = (text: string, tone?: 'error' | 'success') => (
    <p
      className={cn(
        'text-12 leading-[1.5]',
        tone === 'error' ? 'text-[var(--error-fg)]' : tone === 'success' ? 'text-[var(--status-success)]' : 'text-[var(--text-secondary)]',
      )}
    >
      {text}
    </p>
  );
  const button = (target: RemoteSwitchTarget, label: string, variant: 'primary' | 'secondary') => (
    <Button variant={variant} size="sm" compact onClick={() => onSwitch(node, target)}>
      {label}
    </Button>
  );
  const onAgentNet = node.encrypted === true;
  if (availability.block) {
    // 已经在用 Agent-Net 又切不了的设备不必解释。
    return { body: onAgentNet ? null : hint(t(`settings.remoteControl.v2.peerSwitch.blocked.${availability.block}`)), action: null };
  }
  const probe = probes.get(node.id) ?? CHECKING;
  if (probe.kind === 'checking') {
    return {
      body: (
        <p className="flex items-center gap-2 text-12 leading-[1.5] text-[var(--text-tertiary)]">
          <Spinner size={12} aria-hidden />
          {t('settings.remoteControl.v2.peerSwitch.checking')}
        </p>
      ),
      action: null,
    };
  }
  if (probe.kind === 'unsupported') return { body: hint(t('settings.remoteControl.v2.peerSwitch.unsupported')), action: null };
  if (probe.kind === 'unreachable') return { body: hint(t('settings.remoteControl.v2.peerSwitch.unreachable')), action: null };
  const disableBlock = switchProbeKind(probe, onAgentNet ? 'device-link' : 'agent-net');
  if (disableBlock === 'encryption-required' || disableBlock === 'controller-encryption-required' || disableBlock === 'agent-net-only-relay') {
    return { body: hint(t(disableBlock === 'encryption-required' ? 'settings.remoteControl.v2.peerSwitch.encryptionRequired' : `settings.remoteControl.v2.peerSwitch.disableBlocked.${disableBlock}`)), action: null };
  }
  if (probe.kind === 'not-ready' && !onAgentNet) {
    return { body: hint(t(`settings.remoteControl.v2.peerSwitch.notReady.${probe.reason}`)), action: null };
  }
  if (entry?.kind === 'reverted') {
    return {
      body: hint(t('settings.remoteControl.v2.peerSwitch.reverted'), 'error'),
      action: button('agent-net', t('settings.remoteControl.v2.peerSwitch.retry'), 'primary'),
    };
  }
  const justDone = entry?.kind === 'done' && (entry.target === 'agent-net') === onAgentNet;
  if (onAgentNet) {
    return {
      body: justDone ? hint(t('settings.remoteControl.v2.peerSwitch.done.toAgentNet'), 'success') : null,
      action: button('device-link', t('settings.remoteControl.v2.peerSwitch.toDeviceLink'), 'secondary'),
    };
  }
  return {
    body: hint(justDone ? t('settings.remoteControl.v2.peerSwitch.done.toDeviceLink') : t('settings.remoteControl.v2.peerSwitch.hint'), justDone ? 'success' : undefined),
    action: button('agent-net', t('settings.remoteControl.v2.peerSwitch.toAgentNet'), 'primary'),
  };
}

export function DeviceNodePopover({
  node,
  relayName,
  onRemoteDesktop,
  switchEntry = null,
  onSwitch,
}: {
  node: TopologyNode;
  relayName: string;
  onRemoteDesktop: (node: TopologyNode) => void;
  switchEntry?: RemoteSwitchEntry | null;
  onSwitch?: (node: TopologyNode, target: RemoteSwitchTarget) => void;
}) {
  const { t } = useTranslation();
  const switchArea = useSwitchArea(node, switchEntry, onSwitch);
  const running = switchEntry?.kind === 'running' ? switchEntry : null;
  const reconnecting = running !== null && running.step !== 'request';
  const sub = [
    node.modelLabel,
    platformLabel(node.platform),
    node.appVersion?.trim() ? t('settings.remoteControl.v2.popover.version', { version: node.appVersion.trim() }) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  // 要处理的设备,「状态」直接写原因(红);拓扑上没有别处列问题,点开卡片就能看到(用户裁决 2026-11-07)。
  const statusText =
    running
      ? t(running.target === 'agent-net' ? 'settings.remoteControl.v2.peerSwitch.status.toAgentNet' : 'settings.remoteControl.v2.peerSwitch.status.toDeviceLink')
      : node.status === 'offline'
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
    node.status !== 'offline' && !node.isMobile && node.remoteControlEnabled && node.controlEnabled && !running;
  return (
    <div className="flex flex-col gap-3">
      <Heading name={node.name} sub={sub} platform={node.platform} isMobile={node.isMobile} />
      <div className="flex flex-col gap-1.5">
        {/* 与拓扑同一套颜色:要处理是红、忙碌是心动橙(卡片在 Popover 里,拿不到拓扑容器上的变量,直接用全局 token) */}
        <Row label={t('settings.remoteControl.v2.popover.status')} value={statusText} valueClassName={statusClass} />
        {node.status !== 'offline' ? (
          <Row
            label={t('settings.remoteControl.v2.popover.path')}
            value={reconnecting ? t('settings.remoteControl.v2.peerSwitch.reconnecting') : [protocolLabel(node, t), pathLabel(routeOf(node), relayName, t)].filter(Boolean).join(' · ')}
          />
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
        {node.path && !reconnecting ? (
          <Row label={t('settings.remoteControl.v2.popover.encryption')} value={t(node.encrypted === true
            ? 'settings.remoteControl.v2.popover.encrypted' : node.encrypted === false
              ? 'settings.remoteControl.v2.popover.legacyConnection' : 'settings.remoteControl.v2.popover.encryptionUnknown')} />
        ) : null}
        {node.path && node.encrypted === false && !reconnecting ? (
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
      {switchArea.body ? (
        <div className="flex flex-col gap-2 border-t border-[var(--border-default)] pt-3">{switchArea.body}</div>
      ) : null}
      {canRemoteDesktop || switchArea.action ? (
        <div className="flex justify-end gap-2">
          {canRemoteDesktop ? (
            <Button variant={switchArea.action ? 'secondary' : 'primary'} size="sm" compact onClick={() => onRemoteDesktop(node)}>
              {t('remoteDesktop.title')}
            </Button>
          ) : null}
          {switchArea.action}
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
}: {
  model: TopologyModel;
  linkStatus: DeviceLinkLinkStatus;
  /** 连接问题的说明;没有为 null */
  issue: string | null;
  /** 本机另一个 Cindy 实例占着远程连接 */
  standby: boolean;
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
    </div>
  );
}
