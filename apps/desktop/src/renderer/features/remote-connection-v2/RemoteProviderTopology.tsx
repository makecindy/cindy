/**
 * RemoteProviderTopology —— Agent-Net「远程供应商」三栏拓扑视图。
 * ---------------------------------------------------------------------------
 * 展示本机活跃任务正在调用哪台远程供应商机器（同账号电脑、本机供应商组、跨账号分享），
 * 以及流量经由直连还是哪台中转站（自建中转、官方中转、分享方自建中转）。
 *
 * 性能与零干扰红线：
 * - 只读本机内存与已热缓存（useCCSessions 活跃桶、remoteProjectsStore 内存镜像、
 *   useLocalProviderGroups 本机设置、useProviderShareReceived 单例、usePeerLinks 主进程快照），
 *   绝不发任何额外远端 RPC、网络探测帧或新定时器；
 * - 只有切换到「远程供应商」标签时才挂载 RemoteProviderTopologyPanel，停在默认「设备连接」
 *   标签时零订阅、零计算开销；
 * - 对端主机图标严格复用设备连接拓扑的 PlatformGlyph + .rcv2-tile（同账号电脑）与 ShareAvatar
 *   （跨账号分享，永不暴露分享者原始电脑名）；
 * - 流动虚线直接复用 TopologyFlowLayer（纯 Web Animations 合成线程），绝不做 SVG 动画。
 */

import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, ChevronRight, Radio } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { SettingsCard } from '@/components/ui/settings-rows';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import {
  getRemoteSessionActivity,
  isRemoteSessionActivityActive,
  useRemoteSessionActivityRevision,
} from '@/features/device-link/remoteSessionActivityStore';
import { useLocalProviderGroups } from '@/features/provider-group/useLocalProviderGroups';
import { providerShareDisplayNames } from '@/features/provider-share/providerShareNames';
import { ShareAvatar } from '@/features/provider-share/ShareAvatar';
import { useProviderShareReceived } from '@/features/provider-share/providerShareStore';
import { useCCSessions } from '@/hooks/useCCSessions';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import type { Session } from '@/lib/ccAgent.types';
import { createLogger } from '@/lib/logger';
import { resolveSessionRoute } from '@/lib/orcaSessionIdentity';
import { cn } from '@/lib/utils';
import { makerChatStore } from '@/lib/makerChatStore';

import type { DeviceLinkPeerPathPreference } from '../../../shared/deviceLinkIpc';
import { AutoRouteInfoButton } from './AutoRouteInfoButton';
import { ConnectionTraffic } from './ConnectionTraffic';
import { PlatformGlyph } from './PlatformGlyph';
import { TopologyFlowLayer, type FlowLine } from './TopologyFlow';
import {
  buildProviderTopology,
  layoutProviderTopology,
  type IdleStandbyProvider,
  type ProviderGroupIdleMember,
  type ProviderMachineLayout,
  type ProviderRelayLayout,
  type ProviderTopologyModel,
  type ProviderTopologyRelay,
  type ProviderTopologyTask,
} from './providerTopologyModel';
import { formatRtt, platformLabel } from './topologyPresentation';

import './remote-connection-v2.css';

const log = createLogger('RemoteProviderTopology');

const FALLBACK_WIDTH = 720;

const LIVE_STYLE = {
  ['--rcv2-ok' as string]: 'var(--status-success)',
  ['--rcv2-live' as string]: 'var(--status-info)',
  ['--rcv2-error' as string]: 'var(--error-fg)',
} as CSSProperties;

type FocusTarget =
  | { kind: 'machine'; id: string }
  | { kind: 'relay'; id: string }
  | { kind: 'task'; id: string; machineId: string }
  | null;

function useMeasuredWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const read = () => setWidth(el.getBoundingClientRect().width);
    read();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

function transportBadge(transport: 'udp' | 'websocket' | null): string | null {
  if (transport === 'udp') return 'UDP';
  if (transport === 'websocket') return 'WS';
  return null;
}

function rttText(
  ms: number | null | undefined,
  t: Parameters<typeof formatRtt>[1],
): string | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
  return formatRtt(ms, t);
}

function providerIdDisplay(providerId: string): string {
  const key = providerId.trim().toLowerCase();
  if (key === 'claude' || key === 'claude-code' || key === 'anthropic') return 'Claude Code';
  if (key === 'codex' || key === 'openai') return 'Codex';
  if (key === 'gemini' || key === 'gemini-cli' || key === 'google') return 'Gemini CLI';
  return providerId;
}

function PopoverRow({
  label,
  value,
  valueClassName,
}: {
  label: string;
  value: string;
  valueClassName?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-3 text-12 leading-[1.45]">
      <span className="shrink-0 text-[var(--text-tertiary)]">{label}</span>
      <span className={cn('min-w-0 break-words text-right', valueClassName ?? 'text-[var(--text-primary)]')} title={value}>
        {value}
      </span>
    </div>
  );
}

/**
 * 与设备连接拓扑完全共用同一套对端主机图标：
 * - 同账号电脑：PlatformGlyph + .rcv2-tile（含绿/蓝/红状态描边、蓝光晕与右上角橙色忙碌圆点）
 * - 跨账号分享：ShareAvatar + 圆形 .rcv2-tile（遵守隐私边界，永不展示分享者电脑名）
 */
function PeerHostTile({
  kind,
  avatarLabel,
  platform,
  isMobile,
  avatarUrl,
  isLinked,
  isLive,
  isError,
  isDim,
  busy,
}: {
  kind: 'own' | 'share';
  avatarLabel: string;
  platform: string | null;
  isMobile: boolean;
  avatarUrl: string | null;
  isLinked: boolean;
  isLive: boolean;
  isError: boolean;
  isDim: boolean;
  busy: boolean;
}) {
  if (kind === 'share') {
    return (
      <span
        className="rcv2-tile relative inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border"
        data-linked={isLinked || undefined}
        data-live={isLive || undefined}
        data-error={isError || undefined}
        data-dim={isDim || undefined}
      >
        <ShareAvatar displayName={avatarLabel} avatarUrl={avatarUrl} size="sm" />
        <span
          className="rcv2-prov-host-badge inline-flex items-center justify-center"
          aria-hidden
        >
          <PlatformGlyph platform={platform} isMobile={false} size={9} />
        </span>
        {busy ? <span className="rcv2-busy session-status-breathing" aria-hidden /> : null}
      </span>
    );
  }

  return (
    <span
      className="rcv2-tile relative inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border"
      data-linked={isLinked || undefined}
      data-live={isLive || undefined}
      data-error={isError || undefined}
      data-dim={isDim || undefined}
    >
      <PlatformGlyph platform={platform} isMobile={isMobile} size={16} />
      {busy ? <span className="rcv2-busy session-status-breathing" aria-hidden /> : null}
    </span>
  );
}

/** 弹出层内的任务跳转行：无多余“跳转”文案，悬停高亮，点击直接定位对应任务会话。 */
function JumpableTaskList({
  tasks,
  onSelect,
  maxHeightClass = 'max-h-[260px]',
}: {
  tasks: readonly ProviderTopologyTask[];
  onSelect: (task: ProviderTopologyTask) => void;
  maxHeightClass?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-1 overflow-y-auto pr-0.5', maxHeightClass)}>
      {tasks.map((task) => (
        <button
          key={task.id}
          type="button"
          className="rcv2-prov-task-row flex w-full cursor-pointer items-center gap-2 px-2.5 py-2 text-left focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
          onClick={() => onSelect(task)}
          title={task.title}
        >
          <span
            className={cn(
              'h-1.5 w-1.5 shrink-0 rounded-full',
              task.running
                ? 'bg-[var(--warning-accent)] session-status-breathing'
                : 'bg-[var(--status-success)]',
            )}
            aria-hidden
          />
          <span className="min-w-0 flex-1 truncate text-12 font-medium text-[var(--text-primary)]">
            {task.title}
          </span>
          {task.model ? (
            <span className="max-w-[116px] shrink-0 truncate text-11 text-[var(--text-tertiary)]">
              {task.model}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

function MachinePopoverBody({
  ml,
  relay,
  onOpenTask,
  onPathPreferenceChange,
  onRemoteDesktop,
}: {
  ml: ProviderMachineLayout;
  relay: ProviderTopologyRelay | null;
  onOpenTask: (task: ProviderTopologyTask) => void;
  onPathPreferenceChange?: (deviceId: string, preference: DeviceLinkPeerPathPreference) => Promise<boolean | void> | void;
  onRemoteDesktop?: (deviceId: string, name: string) => void;
}) {
  const { t } = useTranslation();
  const { machine } = ml;
  const [pendingPref, setPendingPref] = useState<DeviceLinkPeerPathPreference | null>(null);

  const isLive = Boolean(ml.flow);
  const isError = machine.status === 'error';
  const isLinked = !isLive && !isError && (machine.status === 'direct' || machine.status === 'relay');
  const isDim = !machine.online && !isError;

  const statusText = useMemo(() => {
    if (machine.errorReason === 'unresponsive') return t('settings.remoteControl.v2.attention.unresponsive');
    if (machine.errorReason === 'paused') return t('settings.remoteControl.v2.providers.status.paused');
    if (machine.errorReason === 'offline' || !machine.online) return t('settings.remoteControl.v2.path.offline');
    if (machine.busy) return t('settings.remoteControl.v2.providers.status.busy');
    return t('settings.remoteControl.v2.providers.status.ready');
  }, [machine.busy, machine.errorReason, machine.online, t]);

  const pathText = useMemo(() => {
    const tr = transportBadge(machine.transport);
    const rtt = rttText(machine.rttMs, t);
    const suffix = [tr, rtt].filter(Boolean).join(' ');
    if (machine.routeMode === 'direct') {
      const base = t('settings.remoteControl.v2.path.direct');
      return suffix ? `${base} · ${suffix}` : base;
    }
    if (machine.routeMode === 'relay') {
      const base = t('settings.remoteControl.v2.path.relay', {
        name: relay?.name ?? t('settings.remoteControl.v2.relay.official'),
      });
      return suffix ? `${base} · ${suffix}` : base;
    }
    return machine.online
      ? t('settings.remoteControl.v2.path.unlinked')
      : t('settings.remoteControl.v2.path.offline');
  }, [machine.online, machine.routeMode, machine.rttMs, machine.transport, relay?.name, t]);

  const compareRtt = useMemo(() => {
    const parts: string[] = [];
    const d = rttText(machine.directRttMs, t);
    const r = rttText(machine.relayRttMs, t);
    if (d) parts.push(`${t('settings.remoteControl.v2.popover.routeDirect')} ${d}`);
    if (r) parts.push(`${t('settings.remoteControl.v2.popover.routeRelay')} ${r}`);
    return parts.join(' · ');
  }, [machine.directRttMs, machine.relayRttMs, t]);

  const currentPref: DeviceLinkPeerPathPreference = pendingPref ?? machine.pathPreference ?? 'auto';
  const showPathSwitch = machine.kind === 'own' && machine.online && Boolean(onPathPreferenceChange);

  const handlePrefChange = async (next: DeviceLinkPeerPathPreference) => {
    if (!onPathPreferenceChange || pendingPref || next === currentPref) return;
    setPendingPref(next);
    try {
      await onPathPreferenceChange(machine.targetId, next);
    } finally {
      setPendingPref(null);
    }
  };

  const subtitle =
    machine.kind === 'share'
      ? machine.shareGroupSize
        ? t('settings.remoteControl.v2.providers.badge.shareGroup', { count: machine.shareGroupSize })
        : t('settings.remoteControl.v2.providers.badge.share')
      : [machine.modelLabel, platformLabel(machine.platform)].filter(Boolean).join(' · ')
        || t('settings.remoteControl.v2.providers.badge.own');

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2.5">
        <PeerHostTile
          kind={machine.kind}
          avatarLabel={machine.avatarLabel}
          platform={machine.platform}
          isMobile={machine.isMobile}
          avatarUrl={machine.avatarUrl}
          isLinked={isLinked}
          isLive={isLive}
          isError={isError}
          isDim={isDim}
          busy={machine.busy}
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-13 font-medium text-[var(--text-primary)]" title={machine.name}>
            {machine.name}
          </div>
          <div className="truncate text-11 text-[var(--text-tertiary)]" title={subtitle}>
            {subtitle}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-1.5 border-t border-[var(--border-default)] pt-2.5">
        <PopoverRow
          label={t('settings.remoteControl.v2.popover.status')}
          value={statusText}
          valueClassName={
            isError
              ? 'text-[var(--error-fg)]'
              : machine.busy
                ? 'text-[var(--warning-accent)]'
                : machine.online
                  ? 'text-[var(--status-success)]'
                  : 'text-[var(--text-tertiary)]'
          }
        />
        <PopoverRow label={t('settings.remoteControl.v2.popover.path')} value={pathText} />
        {compareRtt ? (
          <PopoverRow label={t('settings.remoteControl.v2.popover.latency')} value={compareRtt} />
        ) : null}
        {machine.usedModels.length > 0 ? (
          <PopoverRow
            label={t('settings.remoteControl.v2.providers.popover.models')}
            value={machine.usedModels.join(' · ')}
          />
        ) : null}
      </div>

      {showPathSwitch ? (
        <div className="flex flex-col gap-1.5 border-t border-[var(--border-default)] pt-2.5">
          <div className="inline-flex items-center gap-1 text-11 font-medium text-[var(--text-tertiary)]">
            <span>{t('settings.remoteControl.v2.popover.routePreference')}</span>
            <AutoRouteInfoButton />
          </div>
          <SegmentedControl<DeviceLinkPeerPathPreference>
            value={currentPref}
            onValueChange={(v) => void handlePrefChange(v)}
            disabled={pendingPref !== null}
            aria-label={t('settings.remoteControl.v2.popover.routePreference')}
            height={28}
            optionHeight={24}
            fullWidth
            options={[
              { value: 'auto', label: t('settings.remoteControl.v2.popover.routeAuto') },
              { value: 'direct', label: t('settings.remoteControl.v2.popover.routeDirect') },
              { value: 'relay', label: t('settings.remoteControl.v2.popover.routeRelay') },
            ]}
          />
        </div>
      ) : null}

      <div className="flex flex-col gap-1.5 border-t border-[var(--border-default)] pt-2.5">
        <div className="flex items-center justify-between text-11 text-[var(--text-tertiary)]">
          <span>
            {t('settings.remoteControl.v2.providers.popover.tasksCount', {
              count: machine.visibleTasks.length,
            })}
          </span>
          <span>{t('settings.remoteControl.v2.providers.popover.clickToOpenHint')}</span>
        </div>
        <JumpableTaskList
          tasks={machine.visibleTasks}
          onSelect={onOpenTask}
          maxHeightClass="max-h-[176px]"
        />
      </div>

      {machine.kind === 'own' && machine.online && onRemoteDesktop ? (
        <div className="border-t border-[var(--border-default)] pt-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="w-full"
            onClick={() => onRemoteDesktop(machine.targetId, machine.name)}
          >
            {t('remoteDesktop.title')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function RelayPopoverBody({
  rl,
  machines,
}: {
  rl: ProviderRelayLayout;
  machines: readonly ProviderMachineLayout[];
}) {
  const { t } = useTranslation();
  const { relay } = rl;
  const connected = machines.filter((m) => m.machine.relayId === relay.id);
  const taskCount = connected.reduce((sum, m) => sum + m.machine.visibleTasks.length, 0);

  const roleText =
    relay.kind === 'self-hosted'
      ? t('settings.remoteControl.v2.providers.relayRole.selfHostedFull')
      : relay.kind === 'sharer-relay'
        ? t('settings.remoteControl.v2.providers.relayRole.sharerRelayFull')
        : t('settings.remoteControl.v2.providers.relayRole.officialFull');

  const hopText = [transportBadge(relay.transport), rttText(relay.hopRttMs, t)].filter(Boolean).join(' · ');

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2">
        <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[var(--surface-chip)] text-[var(--text-primary)]">
          <Radio size={14} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-13 font-medium text-[var(--text-primary)]" title={relay.name}>
            {relay.name}
          </div>
          <div className="truncate text-11 text-[var(--text-tertiary)]">{roleText}</div>
        </div>
      </div>

      <div className="flex flex-col gap-1.5 border-t border-[var(--border-default)] pt-2">
        {relay.host ? (
          <PopoverRow label={t('settings.remoteControl.v2.providers.popover.relayHost')} value={relay.host} />
        ) : null}
        {relay.region ? (
          <PopoverRow label={t('settings.remoteControl.v2.providers.popover.relayRegion')} value={relay.region} />
        ) : null}
        {hopText ? (
          <PopoverRow label={t('settings.remoteControl.v2.providers.popover.relayHop')} value={hopText} />
        ) : null}
        <PopoverRow
          label={t('settings.remoteControl.v2.providers.popover.relayLoad')}
          value={t('settings.remoteControl.v2.providers.popover.relayLoadValue', {
            machines: connected.length,
            tasks: taskCount,
          })}
        />
      </div>
    </div>
  );
}

function IdleGroupRow({
  member,
  style,
}: {
  member: ProviderGroupIdleMember;
  style: CSSProperties;
}) {
  const { t } = useTranslation();
  const rtt = rttText(member.rttMs, t);
  const statusText = member.paused
    ? t('settings.remoteControl.v2.providers.status.paused')
    : !member.online
      ? t('settings.remoteControl.v2.path.offline')
      : member.routeMode === 'direct'
        ? rtt
          ? `${t('settings.remoteControl.v2.path.direct')} · ${rtt}`
          : t('settings.remoteControl.v2.path.direct')
        : member.routeMode === 'relay'
          ? rtt
            ? `${t('settings.remoteControl.v2.popover.routeRelay')} · ${rtt}`
            : t('settings.remoteControl.v2.popover.routeRelay')
          : t('settings.remoteControl.v2.providers.status.idle');

  return (
    <div
      style={style}
      className="flex items-center gap-2 rounded-lg border border-[var(--border-default)] bg-[var(--settings-theme-card-bg)] px-2 text-11"
    >
      <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center text-[var(--text-secondary)]">
        {member.kind === 'share' ? (
          <ShareAvatar displayName={member.avatarLabel} avatarUrl={member.avatarUrl} size="xs" />
        ) : (
          <PlatformGlyph platform={member.platform} isMobile={false} size={13} />
        )}
      </span>
      <span className="min-w-0 flex-1 truncate text-[var(--text-secondary)]" title={member.name}>
        {member.name}
      </span>
      <span
        className={cn(
          'shrink-0 text-11',
          member.paused || !member.online ? 'text-[var(--text-tertiary)]' : 'text-[var(--status-success)]',
        )}
      >
        {statusText}
      </span>
    </div>
  );
}

function IdleStandbyPopoverBody({
  provider,
  onPathPreferenceChange,
  onRemoteDesktop,
}: {
  provider: IdleStandbyProvider;
  onPathPreferenceChange?: (deviceId: string, preference: DeviceLinkPeerPathPreference) => Promise<boolean | void> | void;
  onRemoteDesktop?: (deviceId: string, name: string) => void;
}) {
  const { t } = useTranslation();
  const [pendingPref, setPendingPref] = useState<DeviceLinkPeerPathPreference | null>(null);
  const isLinked = provider.routeMode === 'direct' || provider.routeMode === 'relay';

  const subtitle =
    provider.kind === 'share'
      ? [
          t('settings.remoteControl.v2.providers.badge.share'),
          provider.shareProviderId ? providerIdDisplay(provider.shareProviderId) : null,
        ]
          .filter(Boolean)
          .join(' · ')
      : [provider.modelLabel, platformLabel(provider.platform)].filter(Boolean).join(' · ')
        || t('settings.remoteControl.v2.providers.badge.own');

  const pathText = useMemo(() => {
    const tr = transportBadge(provider.transport);
    const rtt = rttText(provider.rttMs, t);
    const suffix = [tr, rtt].filter(Boolean).join(' ');
    if (provider.routeMode === 'direct') {
      const base = t('settings.remoteControl.v2.path.direct');
      return suffix ? `${base} · ${suffix}` : base;
    }
    if (provider.routeMode === 'relay') {
      const base = t('settings.remoteControl.v2.path.relay', {
        name: provider.relayName ?? t('settings.remoteControl.v2.relay.official'),
      });
      return suffix ? `${base} · ${suffix}` : base;
    }
    return t('settings.remoteControl.v2.providers.status.standby');
  }, [provider.relayName, provider.routeMode, provider.rttMs, provider.transport, t]);

  const compareRtt = useMemo(() => {
    const parts: string[] = [];
    const d = rttText(provider.directRttMs, t);
    const r = rttText(provider.relayRttMs, t);
    if (d) parts.push(`${t('settings.remoteControl.v2.popover.routeDirect')} ${d}`);
    if (r) parts.push(`${t('settings.remoteControl.v2.popover.routeRelay')} ${r}`);
    return parts.join(' · ');
  }, [provider.directRttMs, provider.relayRttMs, t]);

  const currentPref: DeviceLinkPeerPathPreference = pendingPref ?? provider.pathPreference ?? 'auto';
  const showPathSwitch = provider.kind === 'own' && Boolean(onPathPreferenceChange);

  const handlePrefChange = async (next: DeviceLinkPeerPathPreference) => {
    if (!onPathPreferenceChange || pendingPref || next === currentPref) return;
    setPendingPref(next);
    try {
      await onPathPreferenceChange(provider.targetId, next);
    } finally {
      setPendingPref(null);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2.5">
        <PeerHostTile
          kind={provider.kind}
          avatarLabel={provider.avatarLabel}
          platform={provider.platform}
          isMobile={false}
          avatarUrl={provider.avatarUrl}
          isLinked={isLinked}
          isLive={false}
          isError={false}
          isDim={false}
          busy={provider.busy}
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-13 font-medium text-[var(--text-primary)]" title={provider.name}>
            {provider.name}
          </div>
          <div className="truncate text-11 text-[var(--text-tertiary)]" title={subtitle}>
            {subtitle}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-1.5 border-t border-[var(--border-default)] pt-2.5">
        <PopoverRow
          label={t('settings.remoteControl.v2.popover.status')}
          value={
            provider.busy
              ? t('settings.remoteControl.v2.providers.status.busy')
              : t('settings.remoteControl.v2.providers.status.standby')
          }
          valueClassName={provider.busy ? 'text-[var(--warning-accent)]' : 'text-[var(--status-success)]'}
        />
        <PopoverRow label={t('settings.remoteControl.v2.popover.path')} value={pathText} />
        {compareRtt ? (
          <PopoverRow label={t('settings.remoteControl.v2.popover.latency')} value={compareRtt} />
        ) : null}
      </div>

      {showPathSwitch ? (
        <div className="flex flex-col gap-1.5 border-t border-[var(--border-default)] pt-2.5">
          <div className="inline-flex items-center gap-1 text-11 font-medium text-[var(--text-tertiary)]">
            <span>{t('settings.remoteControl.v2.popover.routePreference')}</span>
            <AutoRouteInfoButton />
          </div>
          <SegmentedControl<DeviceLinkPeerPathPreference>
            value={currentPref}
            onValueChange={(v) => void handlePrefChange(v)}
            disabled={pendingPref !== null}
            aria-label={t('settings.remoteControl.v2.popover.routePreference')}
            height={28}
            optionHeight={24}
            fullWidth
            options={[
              { value: 'auto', label: t('settings.remoteControl.v2.popover.routeAuto') },
              { value: 'direct', label: t('settings.remoteControl.v2.popover.routeDirect') },
              { value: 'relay', label: t('settings.remoteControl.v2.popover.routeRelay') },
            ]}
          />
        </div>
      ) : null}

      {provider.kind === 'own' && onRemoteDesktop ? (
        <div className="border-t border-[var(--border-default)] pt-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="w-full"
            onClick={() => onRemoteDesktop(provider.targetId, provider.name)}
          >
            {t('remoteDesktop.title')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function IdleStandbyStrip({
  providers,
  onPathPreferenceChange,
  onRemoteDesktop,
}: {
  providers: readonly IdleStandbyProvider[];
  onPathPreferenceChange?: (deviceId: string, preference: DeviceLinkPeerPathPreference) => Promise<boolean | void> | void;
  onRemoteDesktop?: (deviceId: string, name: string) => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  if (providers.length === 0) return null;

  return (
    <div className="border-t border-[var(--settings-theme-card-border)] px-3 py-2.5">
      <div className="flex items-center justify-between gap-2 text-12">
        <span className="text-[var(--text-tertiary)]">
          {t('settings.remoteControl.v2.providers.idleStrip.summary', { count: providers.length })}
        </span>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-12 text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          {expanded
            ? t('settings.remoteControl.v2.providers.idleStrip.hide')
            : t('settings.remoteControl.v2.providers.idleStrip.show')}
          {expanded ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
        </button>
      </div>
      {expanded ? (
        <div className="mt-2.5 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {providers.map((p) => {
            const isLinked = p.routeMode === 'direct' || p.routeMode === 'relay';
            const rtt = rttText(p.rttMs, t);
            const routeText =
              p.routeMode === 'direct'
                ? [t('settings.remoteControl.v2.path.direct'), rtt].filter(Boolean).join(' · ')
                : p.routeMode === 'relay'
                  ? [p.relayName ?? t('settings.remoteControl.v2.popover.routeRelay'), rtt].filter(Boolean).join(' · ')
                  : t('settings.remoteControl.v2.providers.status.standby');
            const kindBadge =
              p.kind === 'share'
                ? t('settings.remoteControl.v2.providers.badge.shareShort')
                : t('settings.remoteControl.v2.providers.badge.own');

            return (
              <Popover key={p.id}>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className="rcv2-prov-card flex h-[56px] w-full cursor-pointer items-center gap-2.5 px-2.5 text-left focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                  >
                    <PeerHostTile
                      kind={p.kind}
                      avatarLabel={p.avatarLabel}
                      platform={p.platform}
                      isMobile={false}
                      avatarUrl={p.avatarUrl}
                      isLinked={isLinked}
                      isLive={false}
                      isError={false}
                      isDim={false}
                      busy={p.busy}
                    />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5 overflow-hidden">
                      <span className="flex items-center gap-1.5">
                        <span
                          className="min-w-0 truncate text-12 font-medium leading-[1.3] text-[var(--text-primary)]"
                          title={p.name}
                        >
                          {p.name}
                        </span>
                        <span className="shrink-0 rounded bg-[var(--settings-theme-card-bg)] px-1.5 py-0.5 text-10 text-[var(--text-tertiary)]">
                          {kindBadge}
                        </span>
                      </span>
                      <span
                        className={cn(
                          'block truncate text-11 leading-[1.3] tabular-nums',
                          isLinked ? 'text-[var(--text-secondary)]' : 'text-[var(--text-tertiary)]',
                        )}
                        title={routeText}
                      >
                        {routeText}
                      </span>
                    </span>
                  </button>
                </PopoverTrigger>
                <PopoverContent side="top" align="center" className="w-[300px] p-3">
                  <IdleStandbyPopoverBody
                    provider={p}
                    onPathPreferenceChange={onPathPreferenceChange}
                    onRemoteDesktop={onRemoteDesktop}
                  />
                </PopoverContent>
              </Popover>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export interface RemoteProviderTopologyProps {
  model: ProviderTopologyModel;
  onOpenTask: (task: ProviderTopologyTask) => void;
  onPathPreferenceChange?: (deviceId: string, preference: DeviceLinkPeerPathPreference) => Promise<boolean | void> | void;
  onRemoteDesktop?: (deviceId: string, name: string) => void;
}

export function RemoteProviderTopology({
  model,
  onOpenTask,
  onPathPreferenceChange,
  onRemoteDesktop,
}: RemoteProviderTopologyProps) {
  const { t } = useTranslation();
  const reducedMotion = useReducedMotion();
  const [hostRef, measuredWidth] = useMeasuredWidth<HTMLDivElement>();
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(() => new Set());
  const [hoverTarget, setHoverTarget] = useState<FocusTarget>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);

  const toggleGroup = useCallback((groupId: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }, []);

  const openTarget: FocusTarget = useMemo(() => {
    if (!openKey) return null;
    if (openKey.startsWith('machine:')) return { kind: 'machine', id: openKey.slice(8) };
    if (openKey.startsWith('bundle:')) return { kind: 'machine', id: openKey.slice(7) };
    if (openKey.startsWith('relay:')) return { kind: 'relay', id: openKey.slice(6) };
    return null;
  }, [openKey]);

  const activeFocus = openTarget ?? hoverTarget;

  const canvasWidth = measuredWidth > 0 ? measuredWidth : FALLBACK_WIDTH;
  const layout = useMemo(
    () => layoutProviderTopology(model, canvasWidth, expandedGroups),
    [model, canvasWidth, expandedGroups],
  );

  const flowLines: FlowLine[] = useMemo(() => {
    if (reducedMotion) return [];
    return layout.lines
      .filter((line) => line.status === 'live' && line.flow)
      .map((line) => ({
        id: line.id,
        shape: line.shape,
        flow: line.flow!,
      }));
  }, [layout.lines, reducedMotion]);

  const isLineFocused = (line: (typeof layout.lines)[number]): boolean => {
    if (!activeFocus) return true;
    if (activeFocus.kind === 'machine') return line.machineId === activeFocus.id;
    if (activeFocus.kind === 'relay') return line.relayId === activeFocus.id;
    return line.machineId === activeFocus.machineId && (line.taskId === null || line.taskId === activeFocus.id);
  };

  const isMachineDimmed = (ml: ProviderMachineLayout): boolean => {
    if (!activeFocus) return false;
    if (activeFocus.kind === 'machine') return ml.machine.id !== activeFocus.id;
    if (activeFocus.kind === 'relay') return ml.machine.relayId !== activeFocus.id;
    return ml.machine.id !== activeFocus.machineId;
  };

  const isRelayDimmed = (rl: ProviderRelayLayout): boolean => {
    if (!activeFocus) return false;
    if (activeFocus.kind === 'relay') return rl.relay.id !== activeFocus.id;
    const focusedMachineId = activeFocus.kind === 'machine' ? activeFocus.id : activeFocus.machineId;
    const m = model.machines.find((x) => x.id === focusedMachineId);
    return m?.relayId !== rl.relay.id;
  };

  const handleSelectTask = useCallback(
    (task: ProviderTopologyTask) => {
      setOpenKey(null);
      onOpenTask(task);
    },
    [onOpenTask],
  );

  const narrow = layout.w < 720;

  return (
    <div style={LIVE_STYLE}>
      <div ref={hostRef} className="px-0 py-3">
        {model.machines.length === 0 ? (
          <p className="px-4 py-8 text-center text-13 text-[var(--text-secondary)]">
            {t('settings.remoteControl.v2.providers.empty')}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <div style={{ width: layout.w, minWidth: layout.w }} className="mx-auto">
              {/* 三栏标题 */}
              <div
                className="mb-1 flex items-center justify-between text-11 text-[var(--text-tertiary)]"
                style={{ paddingLeft: narrow ? 12 : 16, paddingRight: narrow ? 12 : 16 }}
              >
                <span style={{ width: layout.taskW }} className="truncate">
                  {t('settings.remoteControl.v2.providers.columns.tasks')}
                </span>
                <span className="truncate text-center">
                  {t('settings.remoteControl.v2.providers.columns.path')}
                </span>
                <span style={{ width: layout.machW }} className="truncate text-right">
                  {t('settings.remoteControl.v2.providers.columns.machines')}
                </span>
              </div>

              {/* 拓扑画布 */}
              <div className="relative select-none" style={{ width: layout.w, height: layout.h }}>
                {/* 底层连线 SVG（零动画，纯静态几何） */}
                <svg
                  width={layout.w}
                  height={layout.h}
                  viewBox={`0 0 ${layout.w} ${layout.h}`}
                  className="pointer-events-none absolute inset-0"
                  aria-hidden
                >
                  {layout.lines.map((line) => {
                    const focused = isLineFocused(line);
                    const stroke =
                      line.status === 'live'
                        ? 'var(--rcv2-live)'
                        : line.status === 'ok'
                          ? 'var(--rcv2-ok)'
                          : line.status === 'error'
                            ? 'var(--rcv2-error)'
                            : 'var(--text-tertiary)';
                    const dashed = line.status === 'error' || line.status === 'muted';
                    const baseWidth = line.status === 'live' ? (reducedMotion ? 2.5 : 1.75) : 1.5;
                    return (
                      <path
                        key={line.id}
                        d={line.d}
                        fill="none"
                        stroke={stroke}
                        strokeWidth={focused && activeFocus ? baseWidth + 0.5 : baseWidth}
                        strokeDasharray={dashed ? '3 4' : undefined}
                        strokeLinecap="round"
                        opacity={activeFocus ? (focused ? 1 : 0.2) : line.status === 'muted' ? 0.65 : 0.92}
                      />
                    );
                  })}
                  {layout.machines.map((ml) =>
                    ml.joinPoint ? (
                      <circle
                        key={`join:${ml.machine.id}`}
                        cx={ml.joinPoint.x}
                        cy={ml.joinPoint.y}
                        r={2.5}
                        fill={
                          ml.flow
                            ? 'var(--rcv2-live)'
                            : ml.machine.status === 'error'
                              ? 'var(--rcv2-error)'
                              : 'var(--rcv2-ok)'
                        }
                        opacity={activeFocus && isMachineDimmed(ml) ? 0.2 : 0.95}
                      />
                    ) : null,
                  )}
                </svg>

                {/* 流动蓝色虚线层（直接复用 TopologyFlowLayer，仅动 transform / opacity） */}
                {flowLines.length > 0 ? <TopologyFlowLayer lines={flowLines} /> : null}

                {/* 右栏：供应商组外框（先渲染，保证在机器卡片下方） */}
                {layout.groups.map((gl) => {
                  const onlineIdle = gl.block.idleMembers.filter((m) => m.online && !m.paused).length;
                  const offlineIdle = gl.block.idleMembers.length - onlineIdle;
                  return (
                    <div key={gl.block.id}>
                      <div
                        className="rcv2-prov-group-frame absolute"
                        style={{ left: gl.x, top: gl.top, width: gl.w, height: gl.h }}
                      >
                        <div className="flex h-[30px] items-center justify-between gap-2 px-2.5 text-11">
                          <span className="min-w-0 truncate font-medium text-[var(--text-secondary)]">
                            {t('settings.remoteControl.v2.providers.groupTitle', {
                              provider: providerIdDisplay(gl.block.providerId),
                            })}
                          </span>
                          <span className="shrink-0 text-[var(--text-tertiary)]">
                            {t('settings.remoteControl.v2.providers.groupCount', {
                              count: gl.block.totalCount,
                            })}
                          </span>
                        </div>

                        {gl.block.idleMembers.length > 0 ? (
                          <div
                            className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 border-t border-[var(--border-default)] px-2.5 text-11"
                            style={{ height: gl.footH }}
                          >
                            <span className="min-w-0 truncate text-[var(--text-tertiary)]">
                              {t('settings.remoteControl.v2.providers.groupIdleSummary', {
                                count: gl.block.idleMembers.length,
                                online: onlineIdle,
                                offline: offlineIdle,
                              })}
                            </span>
                            <button
                              type="button"
                              className="inline-flex shrink-0 items-center gap-0.5 text-11 text-[var(--text-secondary)] hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                              onClick={() => toggleGroup(gl.block.id)}
                              aria-expanded={gl.expanded}
                            >
                              {gl.expanded
                                ? t('settings.remoteControl.v2.providers.collapse')
                                : t('settings.remoteControl.v2.providers.expand')}
                              {gl.expanded ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
                            </button>
                          </div>
                        ) : null}
                      </div>

                      {gl.expanded
                        ? gl.idleRows.map((row) => (
                            <IdleGroupRow
                              key={row.member.key}
                              member={row.member}
                              style={{
                                position: 'absolute',
                                left: row.x,
                                top: row.top,
                                width: row.w,
                                height: row.h,
                              }}
                            />
                          ))
                        : null}
                    </div>
                  );
                })}

                {/* 左栏：单任务卡片（1–2 个任务）或自适应任务束卡片（≥ 3 个任务） */}
                {layout.machines.map((ml) => {
                  const dimmed = isMachineDimmed(ml);
                  const isLive = Boolean(ml.flow);
                  const isError = ml.machine.status === 'error';
                  const relay = ml.machine.relayId ? model.relayById.get(ml.machine.relayId) ?? null : null;

                  if (!ml.useBundle) {
                    return ml.taskBoxes.map((tb) => {
                      const taskDimmed =
                        activeFocus?.kind === 'task'
                          ? activeFocus.id !== tb.task.id
                          : dimmed;
                      const usageBadge =
                        tb.task.usageKind === 'remote-task'
                          ? t('settings.remoteControl.v2.providers.usage.remoteTask')
                          : t('settings.remoteControl.v2.providers.usage.remoteModel');
                      return (
                        <button
                          key={tb.task.id}
                          type="button"
                          style={{ left: tb.x, top: tb.top, width: tb.w, height: tb.h }}
                          className="rcv2-prov-card absolute flex cursor-pointer items-center gap-2 px-2.5 text-left focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                          data-live={(isLive && tb.task.running) || undefined}
                          data-error={isError || undefined}
                          data-dim={taskDimmed || undefined}
                          onMouseEnter={() => setHoverTarget({ kind: 'task', id: tb.task.id, machineId: ml.machine.id })}
                          onMouseLeave={() => setHoverTarget(null)}
                          onClick={() => handleSelectTask(tb.task)}
                          title={tb.task.title}
                        >
                          <span
                            className={cn(
                              'h-2 w-2 shrink-0 rounded-full',
                              isError
                                ? 'bg-[var(--rcv2-error)]'
                                : tb.task.running
                                  ? 'bg-[var(--warning-accent)] session-status-breathing'
                                  : 'bg-[var(--rcv2-ok)]',
                            )}
                            aria-hidden
                          />
                          <span className="flex min-w-0 flex-1 flex-col overflow-hidden">
                            <span className="block truncate text-12 font-medium leading-[1.35] text-[var(--text-primary)]">
                              {tb.task.title}
                            </span>
                            <span className="block truncate text-11 leading-[1.3] text-[var(--text-tertiary)]">
                              {tb.task.model || usageBadge}
                            </span>
                          </span>
                          {!narrow ? (
                            <span className="shrink-0 rounded bg-[var(--settings-theme-card-bg)] px-1.5 py-0.5 text-10 text-[var(--text-tertiary)]">
                              {usageBadge}
                            </span>
                          ) : null}
                        </button>
                      );
                    });
                  }

                  const bundleKey = `bundle:${ml.machine.id}`;
                  const runningCount = ml.machine.visibleTasks.filter((tk) => tk.running).length;
                  const readyCount = ml.machine.visibleTasks.length - runningCount;
                  const headline =
                    runningCount > 0 && readyCount > 0
                      ? t('settings.remoteControl.v2.providers.bundle.mixed', { running: runningCount, ready: readyCount })
                      : runningCount > 0
                        ? t('settings.remoteControl.v2.providers.bundle.runningOnly', { running: runningCount })
                        : t('settings.remoteControl.v2.providers.bundle.readyOnly', { ready: readyCount });
                  const previewNames = ml.machine.visibleTasks
                    .slice(0, 2)
                    .map((tk) => tk.title)
                    .join('、');

                  const routeBrief =
                    ml.machine.routeMode === 'direct'
                      ? [
                          t('settings.remoteControl.v2.path.direct'),
                          transportBadge(ml.machine.transport),
                          rttText(ml.machine.rttMs, t),
                        ]
                          .filter(Boolean)
                          .join(' · ')
                      : ml.machine.routeMode === 'relay'
                        ? [
                            t('settings.remoteControl.v2.path.relay', {
                              name: relay?.name ?? t('settings.remoteControl.v2.relay.official'),
                            }),
                            rttText(ml.machine.rttMs, t),
                          ]
                            .filter(Boolean)
                            .join(' · ')
                        : t('settings.remoteControl.v2.path.unlinked');

                  return (
                    <Popover
                      key={bundleKey}
                      open={openKey === bundleKey}
                      onOpenChange={(open) => setOpenKey(open ? bundleKey : null)}
                    >
                      <PopoverTrigger asChild>
                        <button
                          type="button"
                          style={{ left: ml.xTask, top: ml.leftTop, width: ml.wTask, height: ml.leftH }}
                          className="rcv2-prov-card absolute flex cursor-pointer items-center gap-2 px-2.5 text-left focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                          data-live={isLive || undefined}
                          data-error={isError || undefined}
                          data-dim={dimmed || undefined}
                          onMouseEnter={() => setHoverTarget({ kind: 'machine', id: ml.machine.id })}
                          onMouseLeave={() => setHoverTarget(null)}
                        >
                          <span
                            className={cn(
                              'h-2 w-2 shrink-0 rounded-full',
                              isError
                                ? 'bg-[var(--rcv2-error)]'
                                : runningCount > 0
                                  ? 'bg-[var(--warning-accent)] session-status-breathing'
                                  : 'bg-[var(--rcv2-ok)]',
                            )}
                            aria-hidden
                          />
                          <span className="flex min-w-0 flex-1 flex-col overflow-hidden">
                            <span className="flex items-center justify-between gap-1.5">
                              <span className="min-w-0 truncate text-12 font-medium leading-[1.35] text-[var(--text-primary)]">
                                {headline}
                              </span>
                              <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-[var(--settings-theme-card-bg)] px-1.5 py-0.5 text-10 font-medium text-[var(--text-secondary)]">
                                {t('settings.remoteControl.v2.providers.bundle.countBadge', {
                                  count: ml.machine.visibleTasks.length,
                                })}
                                <ChevronRight size={10} aria-hidden />
                              </span>
                            </span>
                            <span className="block truncate text-11 leading-[1.35] text-[var(--text-tertiary)]">
                              {previewNames}
                            </span>
                          </span>
                        </button>
                      </PopoverTrigger>
                      <PopoverContent side="bottom" align="start" className="w-[340px] p-3">
                        <div className="mb-2 flex flex-col gap-0.5">
                          <div className="truncate text-13 font-medium text-[var(--text-primary)]">
                            {t('settings.remoteControl.v2.providers.bundle.popoverTitle', {
                              name: ml.machine.name,
                              count: ml.machine.visibleTasks.length,
                            })}
                          </div>
                          <div className="truncate text-11 text-[var(--text-tertiary)]">
                            {routeBrief}
                          </div>
                        </div>
                        <JumpableTaskList tasks={ml.machine.visibleTasks} onSelect={handleSelectTask} />
                      </PopoverContent>
                    </Popover>
                  );
                })}

                {/* 中栏：直连徽章、中转站节点、中转分支延迟标签 */}
                {layout.machines.map((ml) => {
                  const dimmed = isMachineDimmed(ml);
                  const isLive = Boolean(ml.flow);
                  const isError = ml.machine.status === 'error';
                  const rtt = rttText(ml.machine.rttMs, t);

                  return (
                    <div key={`mid:${ml.machine.id}`}>
                      {ml.directPillPos ? (
                        <span
                          style={{
                            left: Math.round(ml.directPillPos.x - ml.directPillPos.w / 2),
                            top: Math.round(ml.directPillPos.y - 12),
                            width: ml.directPillPos.w,
                            height: 24,
                          }}
                          className="rcv2-prov-direct-pill pointer-events-none absolute inline-flex items-center justify-center px-2 text-11"
                          data-live={isLive || undefined}
                          data-error={isError || undefined}
                          data-dim={dimmed || undefined}
                        >
                          <span className="truncate">
                            {[
                              t('settings.remoteControl.v2.path.direct'),
                              [transportBadge(ml.machine.transport), rtt].filter(Boolean).join(' '),
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          </span>
                        </span>
                      ) : null}

                      {ml.branchRttPos && rtt ? (
                        <span
                          style={{
                            left: Math.round(ml.branchRttPos.x - ml.branchRttPos.w / 2),
                            top: Math.round(ml.branchRttPos.y - 10),
                            width: ml.branchRttPos.w,
                            height: 20,
                            opacity: dimmed ? 0.35 : 1,
                          }}
                          className="rcv2-prov-rtt-pill pointer-events-none absolute inline-flex items-center justify-center px-1.5 text-10"
                        >
                          {rtt}
                        </span>
                      ) : null}
                    </div>
                  );
                })}

                {layout.relays.map((rl) => {
                  const relayKey = `relay:${rl.relay.id}`;
                  const dimmed = isRelayDimmed(rl);
                  const isLive = Boolean(rl.flow);
                  const isError = rl.relay.status === 'error';
                  const roleShort =
                    rl.relay.kind === 'self-hosted'
                      ? t('settings.remoteControl.v2.providers.relayRole.selfHostedShort')
                      : rl.relay.kind === 'sharer-relay'
                        ? t('settings.remoteControl.v2.providers.relayRole.sharerRelayShort')
                        : t('settings.remoteControl.v2.providers.relayRole.officialShort');
                  const meta = [
                    roleShort,
                    [transportBadge(rl.relay.transport), rttText(rl.relay.hopRttMs, t)].filter(Boolean).join(' '),
                  ]
                    .filter(Boolean)
                    .join(' · ');

                  return (
                    <Popover
                      key={relayKey}
                      open={openKey === relayKey}
                      onOpenChange={(open) => setOpenKey(open ? relayKey : null)}
                    >
                      <PopoverTrigger asChild>
                        <button
                          type="button"
                          style={{ left: rl.x, top: rl.top, width: rl.w, height: rl.h }}
                          className="rcv2-prov-relay absolute flex cursor-pointer items-center gap-2 px-2.5 text-left focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                          data-live={isLive || undefined}
                          data-error={isError || undefined}
                          data-dim={dimmed || undefined}
                          onMouseEnter={() => setHoverTarget({ kind: 'relay', id: rl.relay.id })}
                          onMouseLeave={() => setHoverTarget(null)}
                          title={`${rl.relay.name} (${meta})`}
                        >
                          <span
                            className={cn(
                              'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-[var(--surface-chip)]',
                              isError
                                ? 'text-[var(--rcv2-error)]'
                                : isLive
                                  ? 'text-[var(--rcv2-live)]'
                                  : 'text-[var(--rcv2-ok)]',
                            )}
                          >
                            <Radio size={13} aria-hidden />
                          </span>
                          <span className="flex min-w-0 flex-1 flex-col overflow-hidden">
                            <span className="block truncate text-12 font-medium leading-[1.3] text-[var(--text-primary)]">
                              {rl.relay.name}
                            </span>
                            <span className="block truncate text-10 leading-[1.3] text-[var(--text-tertiary)]">
                              {meta}
                            </span>
                          </span>
                        </button>
                      </PopoverTrigger>
                      <PopoverContent side="bottom" align="center" className="w-72 p-3">
                        <RelayPopoverBody rl={rl} machines={layout.machines} />
                      </PopoverContent>
                    </Popover>
                  );
                })}

                {/* 右栏：远程供应商机器卡片 */}
                {layout.machines.map((ml) => {
                  const machineKey = `machine:${ml.machine.id}`;
                  const dimmed = isMachineDimmed(ml);
                  const isLive = Boolean(ml.flow);
                  const isError = ml.machine.status === 'error';
                  const isLinked = !isLive && !isError && (ml.machine.status === 'direct' || ml.machine.status === 'relay');
                  const isTileDim = !ml.machine.online && !isError;
                  const relay = ml.machine.relayId ? model.relayById.get(ml.machine.relayId) ?? null : null;

                  const kindBadge = ml.inGroup
                    ? t('settings.remoteControl.v2.providers.badge.groupMember')
                    : ml.machine.kind === 'share'
                      ? ml.machine.shareGroupSize
                        ? t('settings.remoteControl.v2.providers.badge.shareGroupShort', {
                            count: ml.machine.shareGroupSize,
                          })
                        : t('settings.remoteControl.v2.providers.badge.shareShort')
                      : t('settings.remoteControl.v2.providers.badge.own');

                  const modelsLine =
                    ml.machine.usedModels.length > 0
                      ? ml.machine.usedModels.join(' · ')
                      : ml.machine.shareProviderId
                        ? providerIdDisplay(ml.machine.shareProviderId)
                        : platformLabel(ml.machine.platform) ?? '';

                  const statusLine = isError
                    ? ml.machine.errorReason === 'paused'
                      ? t('settings.remoteControl.v2.providers.status.paused')
                      : t('settings.remoteControl.v2.attention.unresponsive')
                    : ml.flow
                      ? t('settings.remoteControl.v2.providers.machineLine.live', {
                          flow: t(`settings.remoteControl.v2.flow.${ml.flow}`),
                          count: ml.machine.visibleTasks.length,
                        })
                      : t('settings.remoteControl.v2.providers.machineLine.ready', {
                          count: ml.machine.visibleTasks.length,
                        });

                  return (
                    <Popover
                      key={machineKey}
                      open={openKey === machineKey}
                      onOpenChange={(open) => setOpenKey(open ? machineKey : null)}
                    >
                      <PopoverTrigger asChild>
                        <button
                          type="button"
                          style={{
                            left: ml.xMachCard,
                            top: ml.machTop,
                            width: ml.wMachCard,
                            height: ml.machH,
                          }}
                          className="rcv2-prov-card absolute flex cursor-pointer items-center gap-2.5 px-2.5 text-left focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                          data-live={isLive || undefined}
                          data-error={isError || undefined}
                          data-dim={dimmed || undefined}
                          onMouseEnter={() => setHoverTarget({ kind: 'machine', id: ml.machine.id })}
                          onMouseLeave={() => setHoverTarget(null)}
                        >
                          <PeerHostTile
                            kind={ml.machine.kind}
                            avatarLabel={ml.machine.avatarLabel}
                            platform={ml.machine.platform}
                            isMobile={ml.machine.isMobile}
                            avatarUrl={ml.machine.avatarUrl}
                            isLinked={isLinked}
                            isLive={isLive}
                            isError={isError}
                            isDim={isTileDim}
                            busy={ml.machine.busy}
                          />
                          <span className="flex min-w-0 flex-1 flex-col overflow-hidden">
                            <span className="flex items-center gap-1.5">
                              <span className="min-w-0 truncate text-12 font-medium leading-[1.3] text-[var(--text-primary)]">
                                {ml.machine.name}
                              </span>
                              <span className="shrink-0 rounded bg-[var(--settings-theme-card-bg)] px-1.5 py-0.5 text-10 text-[var(--text-tertiary)]">
                                {kindBadge}
                              </span>
                            </span>
                            {modelsLine ? (
                              <span className="block truncate text-11 leading-[1.3] text-[var(--text-tertiary)]">
                                {modelsLine}
                              </span>
                            ) : null}
                            <span
                              className={cn(
                                'block truncate text-11 leading-[1.3]',
                                isError
                                  ? 'text-[var(--rcv2-error)]'
                                  : isLive
                                    ? 'text-[var(--rcv2-live)]'
                                    : 'text-[var(--text-secondary)]',
                              )}
                            >
                              {statusLine}
                            </span>
                          </span>
                        </button>
                      </PopoverTrigger>
                      <PopoverContent side="left" align="center" className="w-[336px] p-3">
                        <MachinePopoverBody
                          ml={ml}
                          relay={relay}
                          onOpenTask={handleSelectTask}
                          onPathPreferenceChange={onPathPreferenceChange}
                          onRemoteDesktop={onRemoteDesktop}
                        />
                      </PopoverContent>
                    </Popover>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>

      <IdleStandbyStrip
        providers={model.idleProviders}
        onPathPreferenceChange={onPathPreferenceChange}
        onRemoteDesktop={onRemoteDesktop}
      />
    </div>
  );
}

function providerStatsLine(
  model: ProviderTopologyModel,
  t: (k: string, o?: Record<string, unknown>) => string,
): string {
  const { stats } = model;
  if (stats.totalTasks === 0) {
    return t('settings.remoteControl.v2.providers.stats.empty');
  }
  const parts: string[] = [
    t('settings.remoteControl.v2.providers.bundle.runningOnly', { running: stats.totalTasks }),
    stats.totalMachines > stats.activeMachines
      ? t('settings.remoteControl.v2.providers.stats.machinesWithTotal', {
          active: stats.activeMachines,
          total: stats.totalMachines,
        })
      : t('settings.remoteControl.v2.providers.stats.machines', { active: stats.activeMachines }),
  ];
  if (stats.directCount > 0) {
    parts.push(t('settings.remoteControl.v2.stats.direct', { count: stats.directCount }));
  }
  if (stats.relayCount > 0) {
    parts.push(t('settings.remoteControl.v2.providers.stats.relays', { count: stats.relayCount }));
  }
  if (stats.errorCount > 0) {
    parts.push(t('settings.remoteControl.v2.stats.attention', { count: stats.errorCount }));
  }
  return parts.join(' · ');
}

export interface RemoteProviderTopologyPanelProps {
  devices: readonly DeviceLinkDeviceView[];
  peerLinks: DeviceLinkPeerLinksSnapshot;
  primaryRelayName: string;
  primarySelfHosted: boolean;
  unresponsiveIds: ReadonlySet<string>;
  tabControl: ReactNode;
  statusRight: ReactNode;
  onPathPreferenceChange?: (deviceId: string, preference: DeviceLinkPeerPathPreference) => Promise<boolean | void> | void;
  onRemoteDesktop?: (deviceId: string, name: string) => void;
}

/**
 * 惰性挂载的「远程供应商」面板：仅在用户切到该标签时订阅本机已有内存与缓存，
 * 零远端请求、零额外定时器、零 Agent-Net 数据通路负担。
 */
export function RemoteProviderTopologyPanel({
  devices,
  peerLinks,
  primaryRelayName,
  primarySelfHosted,
  unresponsiveIds,
  tabControl,
  statusRight,
  onPathPreferenceChange,
  onRemoteDesktop,
}: RemoteProviderTopologyPanelProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { sessions: localSessions } = useCCSessions({ includeArchived: 'active' });
  const remoteSessions = useSyncExternalStore(
    remoteProjectsStore.subscribe,
    remoteProjectsStore.getMergedRemoteSessions,
  );
  const runningStatusMap = useSyncExternalStore(
    makerChatStore.subscribeAll,
    makerChatStore.getRunningSnapshot,
    makerChatStore.getRunningSnapshot,
  );
  const remoteActivityRevision = useRemoteSessionActivityRevision();
  const localGroups = useLocalProviderGroups();
  const { received: receivedShares } = useProviderShareReceived();

  const mergedSessions = useMemo<Session[]>(() => {
    const byId = new Map<string, Session>();
    for (const s of localSessions) {
      if (s.status === 'active') byId.set(s.id, s);
    }
    for (const s of remoteSessions) {
      if (s.status === 'active' && !byId.has(s.id)) byId.set(s.id, s);
    }
    return Array.from(byId.values());
  }, [localSessions, remoteSessions]);

  const runningSessionIds = useMemo<ReadonlySet<string>>(() => {
    const set = new Set<string>();
    for (const [id, info] of runningStatusMap) {
      if (info.isRunning) set.add(id);
    }
    void remoteActivityRevision;
    for (const s of mergedSessions) {
      if (!s.deviceLinkDeviceId) continue;
      if (isRemoteSessionActivityActive(getRemoteSessionActivity(s.id, s.deviceLinkDeviceId))) {
        set.add(s.id);
      }
    }
    return set;
  }, [runningStatusMap, remoteActivityRevision, mergedSessions]);

  const shareDisplayNames = useMemo(
    () => providerShareDisplayNames(receivedShares, t),
    [receivedShares, t],
  );

  const officialRelayLabel = t('settings.remoteControl.v2.relay.official');
  const unnamedSessionLabel = t('ccAgent.session.newChat', 'New task');

  const model = useMemo(
    () =>
      buildProviderTopology({
        sessions: mergedSessions,
        runningSessionIds,
        devices,
        peerLinks,
        localGroups,
        receivedShares,
        shareDisplayNames,
        primaryRelayName,
        primarySelfHosted,
        officialRelayLabel,
        unresponsiveIds,
        scope: 'running',
        query: '',
        unnamedSessionLabel,
      }),
    [
      mergedSessions,
      runningSessionIds,
      devices,
      peerLinks,
      localGroups,
      receivedShares,
      shareDisplayNames,
      primaryRelayName,
      primarySelfHosted,
      officialRelayLabel,
      unresponsiveIds,
      unnamedSessionLabel,
    ],
  );

  const handleOpenTask = useCallback(
    (task: ProviderTopologyTask) => {
      if (task.session.deviceLinkDeviceId) {
        remoteProjectsStore.pinSessionOrigin(task.session.deviceLinkDeviceId, task.id);
      }
      void resolveSessionRoute(task.id, task.session, { remote: task.isRemoteControlled })
        .then((route) => {
          navigate(route);
        })
        .catch((err: unknown) => {
          log.warn('resolveSessionRoute failed', err);
        });
    },
    [navigate],
  );

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 text-12">
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          {tabControl}
          <span className="text-[var(--text-secondary)]">{providerStatsLine(model, t)}</span>
        </span>
        {statusRight}
      </div>

      <SettingsCard>
        <RemoteProviderTopology
          model={model}
          onOpenTask={handleOpenTask}
          onPathPreferenceChange={onPathPreferenceChange}
          onRemoteDesktop={onRemoteDesktop}
        />
        <ConnectionTraffic traffic={peerLinks.traffic} />
      </SettingsCard>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-11 text-[var(--text-tertiary)]">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-0.5 w-3 rounded-full bg-[var(--status-info)]" aria-hidden />
          {t('settings.remoteControl.v2.providers.legend.live')}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-0.5 w-3 rounded-full bg-[var(--status-success)]" aria-hidden />
          {t('settings.remoteControl.v2.providers.legend.ready')}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--warning-accent)]" aria-hidden />
          {t('settings.remoteControl.v2.providers.legend.busy')}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-0.5 w-3 rounded-full bg-[var(--error-fg)]" aria-hidden />
          {t('settings.remoteControl.v2.providers.legend.error')}
        </span>
      </div>
    </>
  );
}
