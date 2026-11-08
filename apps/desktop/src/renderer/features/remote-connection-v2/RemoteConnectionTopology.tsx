/**
 * RemoteConnectionTopology —— 远程连接 V2 的拓扑图。
 * ---------------------------------------------------------------------------
 * 这台电脑在中间(圆盘 + 细环),其它设备按「怎么连」分组排在左右两列,每组上方一行组名;
 * 每条线从细环出发、拐到那一行后直着走到设备图块,经中转的设备中途经过中转站小圆点。
 * 线型只分三种:建了链的细实线、在线没建链 / 要处理的点线、离线的更淡点线。直的那一段贴往返延迟。
 * 图块里是单色系统标志;电脑是方块,手机是带「灵动岛」的竖条。线与几何由 topologyGeometry 算,
 * 状态由 topologyModel 算,这里只负责画和交互。拓扑图只管拓扑(用户裁决 2026-11-07):点开图块的卡片
 * 只展示连接信息;本机的配置在上方「我的设备」的本机卡片,这台电脑的卡片上「管理设备…」定位过去。
 * 设备深链指向某台设备时直接打开它的卡片。
 *
 * 状态只用颜色表达,名字下面不写状态字(用户裁决 2026-11-07;文字状态在卡片、悬停提示与读屏标签里):
 * 绿 --rcv2-ok 是连着但没消息:实线、图块描边与图标都是绿;蓝 --rcv2-live 是有消息在走:这条线变成朝消息方向
 * 流动的蓝色虚线,图块描边与图标变蓝并带一圈蓝色柔光(用户裁决 2026-11-07);
 * 心动橙 --warning-accent(应用里「运行中」的颜色,DESIGN.md §2 登记)是设备忙碌:图块右上角一个呼吸的小圆点;
 * 红 --rcv2-error 是出错 / 要处理(图块和它的点线)。灰色只留给离线和未建链。
 * 强调只有两种:有消息在走的线(TopologyFlow:绿色虚线朝消息方向流)和
 * 悬停 / 打开浮层的那台设备(它的线加深、其它线退后)。状态变了线和图块都淡过去,不跳变。
 * 系统减弱动效时没有动画和过渡,流量由加粗的绿线表达(文字在卡片、悬停提示与读屏标签里)。
 */

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { MonitorOff, Radio } from 'lucide-react';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { cn } from '@/lib/utils';
import type { DeviceLinkLinkStatus } from '@/hooks/useDeviceLinkSettings';

import { DeviceNodePopover, HubNodePopover } from './DeviceNodePopover';
import { PlatformGlyph } from './PlatformGlyph';
import { TopologyFlowLayer, type FlowLine } from './TopologyFlow';
import { groupLines, layoutTopology, OFFLINE_FOLD_ID, type Point, type TopologyLayout } from './topologyGeometry';
import type { TopologyModel, TopologyNode, TopologyStatus } from './topologyModel';
import { formatRtt, protocolLabel, rowSubtitle } from './topologyPresentation';

import './remote-connection-v2.css';

const FALLBACK_WIDTH = 720;
const TILE = 36;
const HUB = 56;
/** 手机图块:竖着的窄条(intrinsic-geometry,见 CSS)。 */
const PHONE_W = 24;
const PHONE_H = 38;
/** 拓扑容器上定义的颜色,子元素与 CSS 只引用 --rcv2-ok / --rcv2-live / --rcv2-error(忙碌直接读 --warning-accent)。 */
const LIVE_STYLE = {
  ['--rcv2-ok' as string]: 'var(--status-success)',
  ['--rcv2-live' as string]: 'var(--status-info)',
  ['--rcv2-error' as string]: 'var(--error-fg)',
} as CSSProperties;

export interface RemoteConnectionTopologyProps {
  model: TopologyModel;
  linkStatus: DeviceLinkLinkStatus;
  /** 本机设备 id;这台电脑的卡片用它定位「我的设备」里的本机那一行 */
  selfDeviceId: string | null;
  /** 连接问题的说明(这台电脑的卡片里显示);没有为 null */
  issue?: string | null;
  /** 本机另一个 Cindy 实例占着远程连接 */
  standby?: boolean;
  /** 点折叠的离线行:展开 / 收起离线设备(折叠与否由 model 决定)。 */
  onToggleOffline: () => void;
  onRemoteDesktop: (node: TopologyNode) => void;
  /** 这台电脑卡片上的「管理设备…」:定位到「我的设备」的本机卡片 */
  onManage: (deviceId: string) => void;
  /** 深链要打开哪台设备的卡片;设备还没画出来(离线折叠)时等它出现 */
  focusDeviceId?: string | null;
  /** 同一台设备被再次请求时随之变化,每个值只打开一次 */
  focusRequestKey?: string | null;
  /** 首批数据(设备目录与第一份链路快照)是否都到了;到了之后图才算稳定,见 SETTLE_MS */
  ready?: boolean;
}

/**
 * 打开页面时先量宽度、设备目录和第一份链路快照陆续回来,图会重排几次。这段时间不做位置过渡和消息动效,
 * 直接落到最终位置(用户反馈 2026-11-07:打开时中间那台电脑会滑一下);数据到齐后再等 SETTLE_MS 才打开,
 * 数据迟迟不到(例如没有链路接口)时最多等 SETTLE_MAX_MS。
 */
const SETTLE_MS = 600;
const SETTLE_MAX_MS = 2_000;

/** openId 里代表「这台电脑的卡」的值(设备 id 不会是它)。 */
const HUB_CARD = '\u0000hub';

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

type LineKind = 'linked' | 'unlinked' | 'attention' | 'offline';
type LineEmphasis = 'rest' | 'live' | 'focus' | 'dim';

function lineKind(status: TopologyStatus): LineKind {
  if (status === 'direct' || status === 'relay') return 'linked';
  if (status === 'attention' || status === 'offline' || status === 'unlinked') return status;
  return 'unlinked';
}

/** 状态变了线的颜色、粗细、透明度一起淡过去(减弱动效时动效时长为 0,直接换)。 */
const LINE_TRANSITION =
  'stroke var(--motion-enter) linear, stroke-opacity var(--motion-enter) linear, stroke-width var(--motion-enter) linear';

/**
 * 线的样子:建了链是绿色实线,要处理是红色点线,没建链灰点线,离线更淡的灰点线;
 * 有消息在走时绿线略粗一点(流动的虚线画在上面,见 TopologyFlow),聚焦的那台最深,其它线保持各自颜色但退后。
 * 彩色线一律不透明(用户反馈 2026-11-06:叠透明度后颜色发灰),只有灰线和「退后」用透明度。
 * 颜色走 style 而不是属性,状态变了才能淡过去。
 */
function lineAttrs(kind: LineKind, emphasis: LineEmphasis) {
  const rest = {
    linked: { stroke: 'var(--rcv2-ok)', strokeOpacity: 1, strokeWidth: 1.5 },
    attention: { stroke: 'var(--rcv2-error)', strokeOpacity: 1, strokeWidth: 2 },
    unlinked: { stroke: 'var(--text-tertiary)', strokeOpacity: 0.5, strokeWidth: 1.5 },
    offline: { stroke: 'var(--text-tertiary)', strokeOpacity: 0.28, strokeWidth: 1.5 },
  }[kind];
  const dash = kind === 'linked' ? undefined : '0.5 4';
  const look =
    emphasis === 'focus'
      ? { stroke: 'var(--text-primary)', strokeOpacity: 0.8, strokeWidth: 2 }
      : emphasis === 'live'
        ? { stroke: 'var(--rcv2-live)', strokeOpacity: 1, strokeWidth: 2 }
        : emphasis === 'dim'
          ? { ...rest, strokeOpacity: rest.strokeOpacity * 0.3 }
          : rest;
  return { strokeDasharray: dash, style: { ...look, transition: LINE_TRANSITION } };
}

const PILL_W = 72;

/** 延迟标签:at 是靠图块的那条边,标签朝中间排开;同一边的标签因此贴着图块对齐成一列。 */
function LatencyPill({
  at,
  side,
  ms,
  strong,
  animate,
}: {
  at: Point;
  side: 1 | -1;
  ms: number | null;
  strong: boolean;
  animate: boolean;
}) {
  const { t } = useTranslation();
  if (ms === null) return null;
  return (
    <div
      className={cn('pointer-events-none flex items-center', side === 1 ? 'justify-end' : 'justify-start')}
      style={placed(at.x - (side * PILL_W) / 2, at.y, PILL_W, 16, animate)}
      aria-hidden
    >
      <span
        className={cn(
          'rounded-full bg-[var(--settings-theme-card-bg)] px-1.5 py-0.5 text-11 leading-none tabular-nums',
          strong ? 'text-[var(--text-secondary)]' : 'text-[var(--text-tertiary)]',
        )}
      >
        {formatRtt(ms, t)}
      </span>
    </div>
  );
}

/**
 * 图块旁边的名字和实际链路协议,状态靠颜色(见文件头);折叠的离线行在名字下面
 * 写一句「显示离线设备」,那是操作提示,不是状态。
 */
function RowText({
  layout,
  at,
  side,
  name,
  hint,
  dim,
  animate,
}: {
  layout: TopologyLayout;
  at: Point;
  side: 1 | -1;
  name: string;
  hint?: string;
  dim?: boolean;
  animate: boolean;
}) {
  const { m } = layout;
  const inner = at.x + side * (m.half + 12);
  const left = side === 1 ? inner : 8;
  const width = Math.max(40, side === 1 ? layout.w - inner - 8 : inner - 8);
  return (
    <div
      className="pointer-events-none flex flex-col justify-center gap-0.5"
      style={{
        ...placed(left + width / 2, at.y, width, m.rowH, animate),
        alignItems: side === 1 ? 'flex-start' : 'flex-end',
        textAlign: side === 1 ? 'left' : 'right',
      }}
    >
      <span
        className={cn(
          'max-w-full truncate text-13 font-medium leading-[1.3]',
          dim ? 'text-[var(--text-secondary)]' : 'text-[var(--text-primary)]',
        )}
        title={name}
      >
        {name}
      </span>
      {hint ? <span className="max-w-full truncate text-12 leading-[1.3] text-[var(--text-tertiary)]">{hint}</span> : null}
    </div>
  );
}

export function RemoteConnectionTopology({
  model,
  linkStatus,
  selfDeviceId,
  issue = null,
  standby = false,
  onToggleOffline,
  onRemoteDesktop,
  onManage,
  focusDeviceId = null,
  focusRequestKey = null,
  ready = true,
}: RemoteConnectionTopologyProps) {
  const { t } = useTranslation();
  const reduced = useReducedMotion();
  const [ref, measured] = useMeasuredWidth();
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  // 深链打开卡片前要滚到的图块(看得见的那一层)。
  const tiles = useRef(new Map<string, HTMLElement>());
  const tileRef = (id: string) => (el: HTMLElement | null) => {
    if (el) tiles.current.set(id, el);
    else tiles.current.delete(id);
  };
  const width = measured || FALLBACK_WIDTH;
  const [settled, setSettled] = useState(false);
  const measuredOnce = measured > 0;
  useEffect(() => {
    if (settled || !measuredOnce) return undefined;
    const timer = window.setTimeout(() => setSettled(true), ready ? SETTLE_MS : SETTLE_MAX_MS);
    return () => window.clearTimeout(timer);
  }, [settled, measuredOnce, ready]);
  // 位置过渡与流动虚线都等图稳定之后。
  const animate = !reduced && settled;
  const layout = layoutTopology(model.groups, width, model.dense);
  const { m, hub } = layout;
  const selfName = model.self?.name ?? t('settings.remoteControl.v2.node.thisComputer');
  // 悬停优先于打开的浮层:鼠标移到别的设备上时跟着它走。
  const focusId = hoverId ?? openId;
  const setCardOpen = (id: string) => (open: boolean) => setOpenId((cur) => (open ? id : cur === id ? null : cur));

  // 深链打开某台设备的卡片:等它画出来,滚进视野再打开;每个请求只处理一次。等两帧,排在设置页
  // 自己的分区深链滚动之后。
  const handledFocus = useRef<string | null>(null);
  const focusTarget = focusDeviceId && layout.rows.has(focusDeviceId) ? focusDeviceId : null;
  useEffect(() => {
    if (!focusTarget || !focusRequestKey || handledFocus.current === focusRequestKey) return undefined;
    let second = 0;
    const first = window.requestAnimationFrame(() => {
      second = window.requestAnimationFrame(() => {
        handledFocus.current = focusRequestKey;
        const smooth = !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        tiles.current.get(focusTarget)?.scrollIntoView?.({ block: 'center', behavior: smooth ? 'smooth' : 'auto' });
        setOpenId(focusTarget);
      });
    });
    return () => {
      window.cancelAnimationFrame(first);
      window.cancelAnimationFrame(second);
    };
  }, [focusTarget, focusRequestKey]);
  const focusNode = focusId ? model.byId.get(focusId) ?? null : null;

  const emphasisFor = (ids: readonly string[], live: boolean): LineEmphasis => {
    if (focusNode) return ids.includes(focusNode.id) ? 'focus' : 'dim';
    return live ? 'live' : 'rest';
  };

  const lines: ReactNode[] = [];
  const pills: ReactNode[] = [];
  const nodes: ReactNode[] = [];
  const flowing: FlowLine[] = [];
  const isPhone = (id: string) => model.byId.get(id)?.isMobile === true;

  for (const group of model.groups) {
    const g = layout.groups.find((x) => x.id === group.id);
    if (!g) continue;
    const { toRelay, rows } = groupLines(layout, group, (id) => (isPhone(id) ? PHONE_W / 2 : m.half));
    if (toRelay && g.relay) {
      const emphasis = emphasisFor(group.ids, model.relay.flow !== null);
      lines.push(
        <path key={`${group.id}:relay`} d={toRelay.d} fill="none" strokeLinecap="round" {...lineAttrs('linked', emphasis)} />,
      );
      if (model.relay.flow) {
        flowing.push({ id: `${group.id}:relay`, shape: toRelay.shape, flow: model.relay.flow });
      }
      const size = m.relayR * 2;
      // 中转站的名字和它的往返写在小圆点旁边:贴着圆点朝中间那一侧排开(扇出的线都在另一侧),
      // 中间来的那段线从下面上来就放上面,反之放下面,不和线打架。
      const labelAbove = hub.y > g.relay.y + 1;
      const labelX = g.relay.x + group.side * m.relayR;
      nodes.push(
        <div key={`${group.id}:station`} style={placed(g.relay.x, g.relay.y, size, size, animate)}>
          <span
            className="rcv2-relay flex h-full w-full items-center justify-center rounded-full border"
            role="img"
            aria-label={model.relay.name}
          >
            <Radio size={14} strokeWidth={1.75} aria-hidden />
          </span>
        </div>,
        <div
          key={`${group.id}:station:label`}
          className="pointer-events-none flex flex-col whitespace-nowrap text-11 leading-[1.3] text-[var(--text-tertiary)]"
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            alignItems: group.side === 1 ? 'flex-end' : 'flex-start',
            transform: `translate3d(${Math.round(labelX)}px, ${Math.round(labelAbove ? g.relay.y - m.relayR - 6 : g.relay.y + m.relayR + 6)}px, 0) translate(${group.side === 1 ? '-100%' : '0'}, ${labelAbove ? '-100%' : '0'})`,
            transition: animate ? 'transform var(--motion-base) var(--motion-ease-move)' : undefined,
          }}
          aria-hidden
        >
          <span>{model.relay.name}</span>
          {model.relay.rttMs !== null ? (
            <span
              className={cn(
                'tabular-nums',
                emphasis !== 'rest' && emphasis !== 'dim' && 'text-[var(--text-secondary)]',
              )}
            >
              {formatRtt(model.relay.rttMs, t)}
            </span>
          ) : null}
        </div>,
      );
    }
    // 组名贴在这一组名字那一列的上方(与名字同一左 / 右边线),不压在线上。
    nodes.push(
      <span
        key={`${group.id}:caption`}
        className="pointer-events-none whitespace-nowrap text-11 font-medium leading-none tracking-[0.02em] text-[var(--text-tertiary)]"
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
    for (const row of rows) {
      const p = layout.rows.get(row.id);
      if (!p) continue;
      if (row.id === OFFLINE_FOLD_ID) {
        lines.push(
          <path key={`${group.id}:${row.id}`} d={row.d} fill="none" strokeLinecap="round" {...lineAttrs('offline', focusNode ? 'dim' : 'rest')} />,
        );
        const count = group.ids.length;
        nodes.push(
          <button
            key="offline-fold"
            type="button"
            className="rcv2-hit rounded-lg"
            style={placed(p.x, p.y, TILE, TILE, animate)}
            onClick={onToggleOffline}
            aria-label={t('settings.remoteControl.v2.offlineShow')}
          >
            <span className="rcv2-tile flex h-full w-full items-center justify-center rounded-lg border" data-dim="true">
              <MonitorOff size={16} strokeWidth={1.75} aria-hidden />
            </span>
          </button>,
          <RowText
            key="offline-fold:text"
            layout={layout}
            at={p}
            side={group.side}
            name={t('settings.remoteControl.v2.offlineFold', { count })}
            hint={t('settings.remoteControl.v2.offlineShow')}
            dim
            animate={animate}
          />,
        );
        continue;
      }
      const node = model.byId.get(row.id);
      if (!node) continue;
      const emphasis = emphasisFor([node.id], node.flow !== null);
      lines.push(
        <path key={`${group.id}:${row.id}`} d={row.d} fill="none" strokeLinecap="round" {...lineAttrs(lineKind(node.status), emphasis)} />,
      );
      if (node.flow) {
        flowing.push({ id: row.id, shape: row.shape, flow: node.flow });
      }
      const phone = node.isMobile;
      const sub = rowSubtitle(node, t);
      const protocol = protocolLabel(node, t);
      const description = [node.name, protocol, sub.text].filter(Boolean).join(' · ');
      pills.push(
        <LatencyPill
          key={`${row.id}:pill`}
          at={row.at}
          side={group.side}
          ms={node.rttMs}
          strong={emphasis !== 'rest' && emphasis !== 'dim'}
          animate={animate}
        />,
      );
      nodes.push(
        <Popover key={row.id} open={openId === node.id} onOpenChange={setCardOpen(node.id)}>
          <PopoverTrigger asChild>
            {/* 外层按钮只管位置与点击(定位用 transform),里层是看得见的图块 */}
            <button
              type="button"
              // design: intrinsic-geometry — 手机图块是竖着的窄条,外层点击区与看得见的那层(.rcv2-tile[data-form=phone])同一外形
              className={cn('rcv2-hit', phone ? 'rounded-[7px]' : 'rounded-lg')}
              style={placed(p.x, p.y, phone ? PHONE_W : TILE, phone ? PHONE_H : TILE, animate)}
              aria-label={description}
              title={description}
              onPointerEnter={() => setHoverId(node.id)}
              onPointerLeave={() => setHoverId((cur) => (cur === node.id ? null : cur))}
            >
              <span
                ref={tileRef(node.id)}
                className="rcv2-tile relative flex h-full w-full items-center justify-center rounded-lg border"
                data-form={phone ? 'phone' : undefined}
                data-dim={node.status === 'offline' ? 'true' : undefined}
                data-live={node.flow ? 'true' : undefined}
                data-linked={node.status === 'direct' || node.status === 'relay' ? 'true' : undefined}
                data-error={node.status === 'attention' ? 'true' : undefined}
              >
                {phone ? <span className="rcv2-island" aria-hidden /> : null}
                <PlatformGlyph platform={node.platform} isMobile={node.isMobile} size={phone ? 13 : 16} />
                {/* 忙碌:右上角心动橙的呼吸小圆点,与侧栏「运行中」同一套(DESIGN.md §15.14) */}
                {node.busy && node.status !== 'offline' ? <span className="rcv2-busy session-status-breathing" aria-hidden /> : null}
              </span>
            </button>
          </PopoverTrigger>
          <PopoverContent side={group.side === 1 ? 'right' : 'left'} align="center" className="w-64 p-3">
            <DeviceNodePopover node={node} relayName={model.relay.name} onRemoteDesktop={onRemoteDesktop} />
          </PopoverContent>
        </Popover>,
        <RowText
          key={`${row.id}:text`}
          layout={layout}
          at={p}
          side={group.side}
          name={node.name}
          hint={protocol ?? undefined}
          dim={node.status === 'offline'}
          animate={animate}
        />,
      );
    }
  }

  return (
    <div ref={ref} className="relative w-full select-none" style={{ ...LIVE_STYLE, height: layout.h }}>
      <svg className="pointer-events-none absolute inset-0" width={layout.w} height={layout.h} aria-hidden>
        {lines}
      </svg>
      {animate ? <TopologyFlowLayer lines={flowing} /> : null}
      {pills}
      {nodes}
      {/* design: intrinsic-geometry —— 圆盘外的细环,线都从这里出发;与圆盘一起移动。和中转连着时是绿色 */}
      <div
        className={cn(
          'pointer-events-none rounded-full border transition-[border-color] duration-[var(--motion-enter)] ease-linear',
          linkStatus === 'online' ? 'border-[var(--rcv2-ok)]' : 'border-[var(--border-default)]',
        )}
        style={placed(hub.x, hub.y, m.ring * 2, m.ring * 2, animate)}
        aria-hidden
      />
      <Popover open={openId === HUB_CARD} onOpenChange={setCardOpen(HUB_CARD)}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="rcv2-hub flex items-center justify-center rounded-full border"
            style={placed(hub.x, hub.y, HUB, HUB, animate)}
            aria-label={selfName}
          >
            <PlatformGlyph platform={model.self?.platform ?? null} isMobile={false} size={22} />
          </button>
        </PopoverTrigger>
        <PopoverContent side="bottom" align="center" className="w-64 p-3">
          <HubNodePopover
            model={model}
            linkStatus={linkStatus}
            issue={issue}
            standby={standby}
            selfDeviceId={selfDeviceId}
            onManage={onManage}
          />
        </PopoverContent>
      </Popover>
      <div
        className="pointer-events-none flex items-center justify-center"
        style={placed(hub.x, hub.y + m.ring + 14, 180, 18, animate)}
        aria-hidden
      >
        <span className="max-w-full truncate rounded bg-[var(--settings-theme-card-bg)] px-1.5 text-12 font-medium leading-[1.5] text-[var(--text-primary)]">
          {selfName}
        </span>
      </div>
    </div>
  );
}
