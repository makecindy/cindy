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

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { isCindyApp } from '@cindy/maker-shared/device-list';
import { appLabel, deviceLabel } from '@/components/settings/deviceLabels';
import { ArrowUpCircle, Check, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { DeviceLinkLinkStatus } from '@/hooks/useDeviceLinkSettings';
import type { DeviceLinkPeerPathPreference } from '../../../shared/deviceLinkIpc';

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
import {
  canProbePeerUpdate,
  isNonDevAppVersion,
  peerUpdateStore,
  probePeerUpdate,
  SELF_UPDATE_TARGET_ID,
  syncPeerUpdateVersion,
  type PeerUpdateConfirmTarget,
  type PeerUpdateEntry,
} from './peerAppUpdate';
import { RouteChoicePanel } from './RouteChoicePanel';
import { DeviceCardHeading } from './DeviceCardHeading';
import type { LinkTransport, TopologyModel, TopologyNode } from './topologyModel';
import { ProtocolMark } from './ProtocolMark';
import {
  flowLabel,
  formatRtt,
  linkTransportLabel,
  pathLabel,
  peerTransportLabel,
  platformLabel,
  protocolKind,
  protocolKindLabel,
  protocolLabel,
  relativeTime,
  relayTransportLabel,
  selfProtocolKind,
} from './topologyPresentation';

/** 卡片里的「路径」只写怎么连;要处理的原因写在「状态」里。 */
function routeOf(node: TopologyNode): TopologyNode {
  return node.attention ? { ...node, attention: null } : node;
}

function Row({
  label,
  value,
  valueClassName,
  children,
}: {
  label: string;
  /** 纯文字值，也用作悬停提示;给了 children 时只作提示 */
  value: string;
  valueClassName?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 text-12 leading-[1.45]">
      <span className="shrink-0 text-[var(--text-tertiary)]">{label}</span>
      <span className={cn('min-w-0 break-words text-right', valueClassName ?? 'text-[var(--text-primary)]')} title={value}>
        {children ?? value}
      </span>
    </div>
  );
}

/**
 * 连接方式:「协议 · 底层传输协议」(如 Agent-Net · UDP),与路径拆开避免长中转名把信息截断。经中转的 Agent-Net 两段
 * 各走各的，写成「本机 WS · 对方 UDP」(2026-11-27,和拓扑图上两段线一致);对方是旧版没说时只写本机那段。
 */
function ConnectionRow({ node, selfRelayTransport }: { node: TopologyNode; selfRelayTransport: LinkTransport | null }) {
  const { t } = useTranslation();
  const kind = protocolKind(node);
  const protocol = protocolLabel(node, t);
  if (!kind || !protocol) return null;
  const selfLeg = linkTransportLabel(selfRelayTransport, t);
  const peerLeg = peerTransportLabel(node, t);
  const transport = node.path === 'relay' && node.encrypted === true
    ? [
        selfLeg ? t('settings.remoteControl.v2.popover.relayLegSelf', { transport: selfLeg }) : null,
        peerLeg ? t('settings.remoteControl.v2.popover.relayLegPeer', { transport: peerLeg }) : null,
      ].filter(Boolean).join(' · ') || null
    : peerLeg;
  const text = [protocol, transport].filter(Boolean).join(' · ');
  return (
    <Row label={t('settings.remoteControl.v2.popover.protocol')} value={text}>
      <span className="inline-flex flex-wrap items-center justify-end gap-1">
        <ProtocolMark kind={kind} label={protocol} className="shrink-0" />
        {transport ? <span className="shrink-0 text-[var(--text-secondary)]">· {transport}</span> : null}
      </span>
    </Row>
  );
}


const selectPeerUpdates = () => peerUpdateStore.getSnapshot().entries;

function VersionUpdateAction({
  targetId,
  isSelf,
  deviceName,
  observedVersion,
  busyFallback,
  platformFallback,
  enabled,
  onUpdate,
}: {
  targetId: string;
  isSelf: boolean;
  deviceName: string;
  observedVersion: string | null | undefined;
  busyFallback: boolean;
  platformFallback: string | null;
  enabled: boolean;
  onUpdate?: (target: PeerUpdateConfirmTarget) => void;
}) {
  const { t } = useTranslation();
  const updateEntries = useSyncExternalStore(peerUpdateStore.subscribe, selectPeerUpdates);

  useEffect(() => {
    syncPeerUpdateVersion(targetId, observedVersion);
  }, [targetId, observedVersion]);

  useEffect(() => {
    if (enabled && onUpdate) {
      void probePeerUpdate(targetId, { observedVersion });
    }
  }, [enabled, onUpdate, targetId, observedVersion]);

  if (!enabled || !onUpdate) return null;
  const entry: PeerUpdateEntry | undefined = updateEntries.get(targetId);
  if (!entry) return null;

  if (entry.kind === 'updating') {
    const tipText = t(
      entry.phase === 'relaunching'
        ? 'settings.remoteControl.v2.peerUpdate.relaunching'
        : 'settings.remoteControl.v2.peerUpdate.downloading',
      { version: entry.targetVersion },
    );
    return (
      <Tip text={tipText} side="top">
        <span
          className="inline-flex size-4 shrink-0 items-center justify-center text-[var(--status-info)]"
          aria-label={tipText}
        >
          <Spinner size={12} aria-hidden />
        </span>
      </Tip>
    );
  }

  if (entry.kind !== 'available') return null;

  const tipText = t('settings.remoteControl.v2.peerUpdate.availableTip', { version: entry.targetVersion });
  return (
    <Tip text={tipText} side="top">
      <button
        type="button"
        className="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-[var(--status-info)] transition-colors hover:bg-[var(--bg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
        aria-label={tipText}
        onClick={() =>
          onUpdate({
            targetId,
            isSelf,
            deviceName,
            currentVersion: entry.currentVersion,
            targetVersion: entry.targetVersion,
            busy: entry.busy || busyFallback,
            platform: entry.platform ?? platformFallback ?? undefined,
          })
        }
      >
        <ArrowUpCircle size={13} aria-hidden />
      </button>
    </Tip>
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
  selfRelayTransport = null,
  onDelete,
  onRemoteDesktop,
  switchEntry = null,
  onSwitch,
  onPathPreferenceChange,
  onUpdate,
}: {
  node: TopologyNode;
  relayName: string;
  /** 这台电脑到中转那一段走 UDP 还是 WS(拓扑中转点那一段),经中转的 Agent-Net 设备在「连接方式」里和对方那段一起写。 */
  selfRelayTransport?: LinkTransport | null;
  onDelete?: () => void;
  onRemoteDesktop: (node: TopologyNode) => void;
  switchEntry?: RemoteSwitchEntry | null;
  onSwitch?: (node: TopologyNode, target: RemoteSwitchTarget) => void;
  onPathPreferenceChange?: (node: TopologyNode, preference: DeviceLinkPeerPathPreference) => Promise<boolean | void> | void;
  onUpdate?: (target: PeerUpdateConfirmTarget) => void;
}) {
  const { t } = useTranslation();
  const [optimisticPref, setOptimisticPref] = useState<{ id: string; value: DeviceLinkPeerPathPreference; seq: number } | null>(null);
  const prefSeqRef = useRef(0);
  const switchArea = useSwitchArea(node, switchEntry, onSwitch);
  const running = switchEntry?.kind === 'running' ? switchEntry : null;
  const reconnecting = running !== null && running.step !== 'request';
  const serverPref: DeviceLinkPeerPathPreference = node.pathPreference ?? 'auto';
  const selectedPref: DeviceLinkPeerPathPreference =
    optimisticPref && optimisticPref.id === node.id ? optimisticPref.value : serverPref;
  useEffect(() => {
    if (optimisticPref && (optimisticPref.id !== node.id || optimisticPref.value === serverPref)) {
      setOptimisticPref(null);
    }
  }, [optimisticPref, node.id, serverPref]);
  const showRoutePanel =
    node.encrypted === true &&
    node.status !== 'offline' &&
    !reconnecting &&
    node.path !== null;
  const directRttMs = node.directRttMs ?? (node.path === 'direct' ? node.rttMs : null);
  const relayRttMs = node.relayRttMs ?? (node.path === 'relay' ? node.rttMs : null);
  const sub = [
    node.modelLabel,
    platformLabel(node.platform),
    node.appVersion?.trim() ? `${appLabel(node.app, t)} ${node.appVersion.trim()}` : null,
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
  const canDelete = node.status === 'offline' && !running && !!onDelete;
  const canRemoteDesktop =
    node.status !== 'offline' && isCindyApp(node.app) && !node.isMobile && node.remoteControlEnabled && node.controlEnabled && !running;
  const displayName = deviceLabel(node, t);
  const canUpdate = canProbePeerUpdate(node) && !running;
  return (
    <div className="flex flex-col gap-3">
      <DeviceCardHeading
        name={displayName}
        sub={sub}
        subAccessory={
          <VersionUpdateAction
            targetId={node.id}
            isSelf={false}
            deviceName={displayName}
            observedVersion={node.appVersion}
            busyFallback={node.busy}
            platformFallback={node.platform}
            enabled={canUpdate}
            onUpdate={onUpdate}
          />
        }
        platform={node.platform}
        isMobile={node.isMobile}
      />
      <div className="flex flex-col gap-1.5">
        {/* 与拓扑同一套颜色:要处理是红、忙碌是心动橙(卡片在 Popover 里,拿不到拓扑容器上的变量,直接用全局 token) */}
        <Row label={t('settings.remoteControl.v2.popover.status')} value={statusText} valueClassName={statusClass} />
        {node.status !== 'offline' && !reconnecting ? <ConnectionRow node={node} selfRelayTransport={selfRelayTransport} /> : null}
        {node.status !== 'offline' && !showRoutePanel ? (
          <Row
            label={t('settings.remoteControl.v2.popover.path')}
            value={reconnecting ? t('settings.remoteControl.v2.peerSwitch.reconnecting') : pathLabel(routeOf(node), relayName, t)}
          />
        ) : null}
        {node.flow ? (
          <Row label={t('settings.remoteControl.v2.popover.activity')} value={flowLabel(node.flowText ?? node.flow, t)} />
        ) : null}
        {!showRoutePanel && node.rttMs !== null ? (
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
      {showRoutePanel ? (
        <RouteChoicePanel
          activePath={node.path}
          directRttMs={directRttMs}
          relayRttMs={relayRttMs}
          relayName={relayName}
          value={selectedPref}
          onValueChange={
            onPathPreferenceChange
              ? (next) => {
                  const seq = ++prefSeqRef.current;
                  setOptimisticPref({ id: node.id, value: next, seq });
                  Promise.resolve(onPathPreferenceChange(node, next)).then(
                    (ok) => {
                      if (ok === false) {
                        setOptimisticPref((cur) => (cur && cur.seq === seq ? null : cur));
                      }
                    },
                    () => {
                      setOptimisticPref((cur) => (cur && cur.seq === seq ? null : cur));
                    },
                  );
                }
              : undefined
          }
        />
      ) : null}
      {switchArea.body ? (
        <div className="flex flex-col gap-2 border-t border-[var(--border-default)] pt-3">{switchArea.body}</div>
      ) : null}
      {canDelete || canRemoteDesktop || switchArea.action ? (
        <div className="flex flex-wrap justify-end gap-2">
          {canDelete ? (
            <Button tone="danger-surface" size="sm" compact onClick={onDelete}>
              <Trash2 size={14} aria-hidden />
              {t('settings.devices.delete')}
            </Button>
          ) : null}
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
  onUpdate,
}: {
  model: TopologyModel;
  linkStatus: DeviceLinkLinkStatus;
  /** 连接问题的说明;没有为 null */
  issue: string | null;
  /** 本机另一个 Cindy 实例占着远程连接 */
  standby: boolean;
  onUpdate?: (target: PeerUpdateConfirmTarget) => void;
}) {
  const { t } = useTranslation();
  // 这台电脑用的连接方式单独一行，与拓扑里名字下面同一个图标 + 名称(用户要求 2026-11-18)。
  const kind = selfProtocolKind(model, linkStatus);
  const protocol = protocolKindLabel(kind, t);
  // 与中转的连接：在线时写经中转的数据走 UDP 还是 WS,往返是那条路的(用户要求 2026-11-18)。
  const online = linkStatus === 'online';
  const relayStatus = [
    t(`settings.devices.linkStatus.${linkStatus}`),
    online ? relayTransportLabel(model.relay, t) : null,
    online && model.relay.rttMs !== null ? formatRtt(model.relay.rttMs, t) : null,
  ].filter(Boolean).join(' · ');
  const selfName = model.self?.name || t('settings.devices.thisDevice');
  const selfVersion = model.self?.appVersion?.trim() || null;
  const selfSub = [
    platformLabel(model.self?.platform ?? null),
    selfVersion ? `${appLabel('cindy', t)} ${selfVersion}` : null,
  ].filter(Boolean).join(' · ');
  return (
    <div className="flex flex-col gap-3">
      <DeviceCardHeading
        name={selfName}
        sub={selfSub}
        subAccessory={
          <VersionUpdateAction
            targetId={SELF_UPDATE_TARGET_ID}
            isSelf
            deviceName={selfName}
            observedVersion={selfVersion}
            busyFallback={false}
            platformFallback={model.self?.platform ?? null}
            enabled={isNonDevAppVersion(selfVersion)}
            onUpdate={onUpdate}
          />
        }
        platform={model.self?.platform ?? null}
        isMobile={false}
      />
      <div className="flex flex-col gap-1.5">
        {kind && protocol ? (
          <Row label={t('settings.remoteControl.v2.popover.protocol')} value={protocol}>
            <ProtocolMark kind={kind} label={protocol} className="justify-end" />
          </Row>
        ) : null}
        <Row label={t('settings.remoteControl.v2.popover.linkStatus', { name: model.relay.name })} value={relayStatus} />
        {issue ? <span className="text-12 text-[var(--error-fg)]">{issue}</span> : null}
        {standby ? <span className="text-12 text-[var(--text-tertiary)]">{t('settings.devices.standbyHint')}</span> : null}
      </div>
    </div>
  );
}
