/**
 * RemoteConnectionTopology —— 远程连接 V2 的拓扑图。
 * ---------------------------------------------------------------------------
 * 这台电脑在中间,其它设备按「怎么连」分组排在左右两列;每条线从中间出发、拐到那一行后直着走到
 * 设备图块,实线是直连、虚线是经中转(中途经过中转站图块)、淡点线是在线但没建链、红点线是离线。
 * 直的那一段中间贴往返延迟。线与几何由 topologyGeometry 算,状态由 topologyModel 算,
 * 这里只负责画和交互(点图块出浮层)。
 *
 * 动效:只有位置变化(transform)带 --motion-base 过渡,系统减弱动效时关闭;线不做动画。
 * 颜色:状态 token 见 DESIGN.md §2 本页登记;文字同时写明状态,颜色不是唯一信号。
 */

import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { Laptop, Monitor, MonitorOff, Radio, Smartphone } from 'lucide-react';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { cn } from '@/lib/utils';
import type { DeviceLinkLinkStatus } from '@/hooks/useDeviceLinkSettings';

import { DeviceNodePopover, HubNodePopover } from './DeviceNodePopover';
import { groupLines, layoutTopology, OFFLINE_FOLD_ID, type Point, type TopologyLayout } from './topologyGeometry';
import { rttTone, type TopologyModel, type TopologyNode, type TopologyStatus } from './topologyModel';
import { formatRtt, RELAY_TONE, rowSubtitle, STATUS_TONE } from './topologyPresentation';

import './remote-connection-v2.css';

const FALLBACK_WIDTH = 720;
const TILE = 36;
const HUB = 56;

export interface RemoteConnectionTopologyProps {
  model: TopologyModel;
  linkStatus: DeviceLinkLinkStatus;
  controlEnabled: boolean;
  onControlEnabledChange: (next: boolean) => void;
  selfDeviceId: string | null;
  /** 点折叠的离线行:展开 / 收起离线设备(折叠与否由 model 决定)。 */
  onToggleOffline: () => void;
  onRemoteDesktop: (node: TopologyNode) => void;
  onManage: (deviceId: string) => void;
}

function useMeasuredWidth(): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const read = () => setWidth(Math.round(el.getBoundingClientRect().width));
    read();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

function DeviceIcon({ platform, isMobile, size = 18 }: { platform: string | null; isMobile: boolean; size?: number }) {
  if (isMobile) return <Smartphone size={size} strokeWidth={1.75} aria-hidden />;
  if (platform === 'darwin') return <Laptop size={size} strokeWidth={1.75} aria-hidden />;
  return <Monitor size={size} strokeWidth={1.75} aria-hidden />;
}

/** 绝对定位 + transform:位置变化才能走过渡。 */
function placed(x: number, y: number, w: number, h: number, animate: boolean): CSSProperties {
  return {
    position: 'absolute',
    left: 0,
    top: 0,
    width: w,
    height: h,
    transform: `translate3d(${Math.round(x - w / 2)}px, ${Math.round(y - h / 2)}px, 0)`,
    transition: animate ? 'transform var(--motion-base) var(--motion-ease-move)' : undefined,
  };
}

function LatencyPill({ at, ms, animate }: { at: Point; ms: number | null; animate: boolean }) {
  const { t } = useTranslation();
  if (ms === null) return null;
  const tone = rttTone(ms);
  return (
    <div className="pointer-events-none flex items-center justify-center" style={placed(at.x, at.y, 96, 16, animate)} aria-hidden>
      <span
        className={cn(
          'rounded-full bg-[var(--settings-theme-card-bg)] px-1.5 py-0.5 text-11 leading-none',
          tone === 'fast' && 'text-[var(--status-success)]',
          tone === 'slow' && 'text-[var(--warning-fg)]',
          tone === 'plain' && 'text-[var(--text-secondary)]',
        )}
      >
        {formatRtt(ms, t)}
      </span>
    </div>
  );
}

function lineStyle(status: TopologyStatus | 'to-relay'): { stroke: string; dash?: string; opacity: number } {
  switch (status) {
    case 'direct':
      return { stroke: STATUS_TONE.direct, opacity: 0.55 };
    case 'relay':
      return { stroke: STATUS_TONE.relay, dash: '4 3', opacity: 0.55 };
    case 'to-relay':
      return { stroke: RELAY_TONE, opacity: 0.55 };
    case 'attention':
      return { stroke: STATUS_TONE.attention, dash: '2 3', opacity: 0.6 };
    case 'offline':
      return { stroke: STATUS_TONE.offline, dash: '1 3', opacity: 0.4 };
    default:
      return { stroke: 'var(--border-default)', dash: '1 3', opacity: 1 };
  }
}

function TileButton({
  tone,
  dim,
  label,
  style,
  children,
}: {
  tone: string;
  dim?: boolean;
  label: string;
  style: CSSProperties;
  children: ReactNode;
}) {
  return (
    <PopoverTrigger asChild>
      <button
        type="button"
        className="rcv2-tile flex items-center justify-center rounded-lg border"
        style={{ ...style, ['--rcv2-tone' as string]: tone }}
        data-dim={dim ? 'true' : undefined}
        aria-label={label}
      >
        {children}
      </button>
    </PopoverTrigger>
  );
}

function RowText({
  layout,
  at,
  side,
  name,
  sub,
  animate,
}: {
  layout: TopologyLayout;
  at: Point;
  side: 1 | -1;
  name: string;
  sub: string;
  animate: boolean;
}) {
  const { m } = layout;
  const inner = at.x + side * (m.half + 10);
  const left = side === 1 ? inner : 8;
  const width = Math.max(40, side === 1 ? layout.w - inner - 8 : inner - 8);
  return (
    <div
      className="pointer-events-none flex flex-col justify-center"
      style={{
        ...placed(left + width / 2, at.y, width, m.rowH, animate),
        alignItems: side === 1 ? 'flex-start' : 'flex-end',
        textAlign: side === 1 ? 'left' : 'right',
      }}
    >
      <span className="max-w-full truncate text-13 font-medium leading-[1.3] text-[var(--text-primary)]" title={name}>
        {name}
      </span>
      <span className="max-w-full truncate text-12 leading-[1.3] text-[var(--text-secondary)]" title={sub}>
        {sub}
      </span>
    </div>
  );
}

export function RemoteConnectionTopology({
  model,
  linkStatus,
  controlEnabled,
  onControlEnabledChange,
  selfDeviceId,
  onToggleOffline,
  onRemoteDesktop,
  onManage,
}: RemoteConnectionTopologyProps) {
  const { t } = useTranslation();
  const reduced = useReducedMotion();
  const [ref, measured] = useMeasuredWidth();
  const width = measured || FALLBACK_WIDTH;
  const animate = !reduced && measured > 0;
  const layout = layoutTopology(model.groups, width, model.dense);
  const { m, hub } = layout;
  const selfName = model.self?.name ?? t('settings.remoteControl.v2.node.thisComputer');

  const lines: ReactNode[] = [];
  const pills: ReactNode[] = [];
  const nodes: ReactNode[] = [];

  for (const group of model.groups) {
    const g = layout.groups.find((x) => x.id === group.id);
    if (!g) continue;
    const { toRelay, rows } = groupLines(layout, group);
    if (toRelay && g.relay) {
      const s = lineStyle('to-relay');
      lines.push(
        <path key={`${group.id}:relay`} d={toRelay.d} fill="none" stroke={s.stroke} strokeWidth={1.5} strokeOpacity={s.opacity} strokeLinecap="round" />,
      );
      pills.push(<LatencyPill key={`${group.id}:relay:pill`} at={toRelay.at} ms={model.relay.rttMs} animate={animate} />);
      nodes.push(
        <div key={`${group.id}:station`} style={placed(g.relay.x, g.relay.y, TILE, TILE, animate)}>
          <span
            className="rcv2-tile flex h-full w-full items-center justify-center rounded-lg border"
            style={{ ['--rcv2-tone' as string]: RELAY_TONE }}
            role="img"
            aria-label={model.relay.name}
          >
            <Radio size={18} strokeWidth={1.75} aria-hidden />
          </span>
          <span
            className="pointer-events-none absolute left-1/2 top-full mt-1 -translate-x-1/2 whitespace-nowrap text-11 leading-none text-[var(--text-tertiary)]"
            aria-hidden
          >
            {model.relay.name}
          </span>
        </div>,
      );
    }
    if (model.dense) {
      // 组名贴在这一组名字那一列的上方(与名字同一左 / 右边线),不压在线上。
      nodes.push(
        <span
          key={`${group.id}:caption`}
          className="pointer-events-none whitespace-nowrap text-11 leading-none text-[var(--text-tertiary)]"
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            transform: `translate3d(${Math.round(g.caption.x)}px, ${Math.round(g.caption.y - 11)}px, 0) translateX(${g.side === 1 ? '0' : '-100%'})`,
            transition: animate ? 'transform var(--motion-base) var(--motion-ease-move)' : undefined,
          }}
          aria-hidden
        >
          {t(`settings.remoteControl.v2.group.${group.key}`)}
        </span>,
      );
    }
    for (const row of rows) {
      const p = layout.rows.get(row.id);
      if (!p) continue;
      const s = lineStyle(group.key);
      lines.push(
        <path
          key={`${group.id}:${row.id}`}
          d={row.d}
          fill="none"
          stroke={s.stroke}
          strokeWidth={1.5}
          strokeOpacity={s.opacity}
          strokeDasharray={s.dash}
          strokeLinecap="round"
        />,
      );
      if (row.id === OFFLINE_FOLD_ID) {
        const count = group.ids.length;
        nodes.push(
          <button
            key="offline-fold"
            type="button"
            className="rcv2-tile flex items-center justify-center rounded-lg border"
            style={{ ...placed(p.x, p.y, TILE, TILE, animate), ['--rcv2-tone' as string]: STATUS_TONE.offline }}
            data-dim="true"
            onClick={onToggleOffline}
            aria-label={t('settings.remoteControl.v2.offlineShow')}
          >
            <MonitorOff size={18} strokeWidth={1.75} aria-hidden />
          </button>,
          <RowText
            key="offline-fold:text"
            layout={layout}
            at={p}
            side={group.side}
            name={t('settings.remoteControl.v2.offlineFold', { count })}
            sub={t('settings.remoteControl.v2.offlineShow')}
            animate={animate}
          />,
        );
        continue;
      }
      const node = model.byId.get(row.id);
      if (!node) continue;
      const sub = rowSubtitle(node, t);
      pills.push(<LatencyPill key={`${row.id}:pill`} at={row.at} ms={node.rttMs} animate={animate} />);
      nodes.push(
        <Popover key={row.id}>
          <TileButton
            tone={STATUS_TONE[node.status]}
            dim={node.status === 'offline'}
            label={`${node.name} · ${sub}`}
            style={placed(p.x, p.y, TILE, TILE, animate)}
          >
            <DeviceIcon platform={node.platform} isMobile={node.isMobile} />
          </TileButton>
          <PopoverContent side={group.side === 1 ? 'right' : 'left'} align="center" className="w-64 p-3">
            <DeviceNodePopover node={node} relayName={model.relay.name} onRemoteDesktop={onRemoteDesktop} onManage={onManage} />
          </PopoverContent>
        </Popover>,
        <RowText key={`${row.id}:text`} layout={layout} at={p} side={group.side} name={node.name} sub={sub} animate={animate} />,
      );
    }
  }

  return (
    <div ref={ref} className="relative w-full select-none" style={{ height: layout.h }}>
      <svg className="pointer-events-none absolute inset-0" width={layout.w} height={layout.h} aria-hidden>
        {lines}
      </svg>
      {pills}
      {nodes}
      {/* design: intrinsic-geometry —— 中间这台电脑是圆盘(56px),它是拓扑的中心而不是一张卡 */}
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(
              'flex items-center justify-center rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] text-[var(--text-primary)]',
              'hover:border-[var(--text-tertiary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
            )}
            style={placed(hub.x, hub.y, HUB, HUB, animate)}
            aria-label={selfName}
          >
            <DeviceIcon platform={model.self?.platform ?? null} isMobile={false} size={22} />
          </button>
        </PopoverTrigger>
        <PopoverContent side="bottom" align="center" className="w-64 p-3">
          <HubNodePopover
            model={model}
            linkStatus={linkStatus}
            enabled={controlEnabled}
            onEnabledChange={onControlEnabledChange}
            selfDeviceId={selfDeviceId}
            onManage={onManage}
          />
        </PopoverContent>
      </Popover>
      <div
        className="pointer-events-none flex items-center justify-center"
        style={placed(hub.x, hub.y + m.R + 14, 160, 18, animate)}
        aria-hidden
      >
        <span className="max-w-full truncate rounded bg-[var(--settings-theme-card-bg)] px-1.5 text-12 leading-[1.5] text-[var(--text-secondary)]">
          {selfName}
        </span>
      </div>
    </div>
  );
}
