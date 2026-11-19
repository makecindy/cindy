/**
 * RemoteConnectionTopology —— 远程连接 V2 的拓扑图。
 * ---------------------------------------------------------------------------
 * 这台电脑在中间(圆盘 + 细环),其它设备按「怎么连」分组排在左右两列,每组上方一行组名;
 * 每条线从细环出发、拐到那一行后直着走到设备图块,经中转的设备中途经过中转站小圆点。
 * 线型只分三种:建了链的细实线、在线没建链 / 要处理的点线、离线的更淡点线。直的那一段贴往返延迟。
 * 图块里是单色系统标志;电脑是方块,手机是带「灵动岛」的竖条。线与几何由 topologyGeometry 算,
 * 状态由 topologyModel 算,这里只负责画和交互。拓扑图只管拓扑(用户裁决 2026-11-07):点开图块的卡片
 * 只展示连接信息;本机的配置直接使用上方「我的设备」的本机卡片。
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
import { deviceLabel } from '@/components/settings/deviceLabels';
import { MonitorOff, Radio } from 'lucide-react';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Spinner } from '@/components/ui/spinner';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { cn } from '@/lib/utils';
import type { DeviceLinkLinkStatus } from '@/hooks/useDeviceLinkSettings';

import type { RemoteSwitchEntry, RemoteSwitchTarget } from './agentNetRemoteSwitch';
import { DeviceNodePopover, HubNodePopover } from './DeviceNodePopover';
import { PlatformGlyph } from './PlatformGlyph';
import { TopologyFlowLayer, type FlowLine } from './TopologyFlow';
import { groupLines, layoutTopology, OFFLINE_FOLD_ID, type Point, type TopologyLayout } from './topologyGeometry';
import type { LinkTransport, TopologyModel, TopologyNode, TopologyStatus } from './topologyModel';
import { ProtocolMark } from './ProtocolMark';
import {
  formatRtt,
  linkTransportLabel,
  peerTransport,
  protocolKind,
  protocolKindLabel,
  protocolLabel,
  relayRouteLabel,
  relayTransportLabel,
  rowSubtitle,
  selfProtocolKind,
  type ProtocolKind,
} from './topologyPresentation';

import './remote-connection-v2.css';

const FALLBACK_WIDTH = 720;
const TILE = 36;
const HUB = 56;
/** 手机图块:竖着的窄条(intrinsic-geometry,见 CSS)。 */
const PHONE_W = 24;
const PHONE_H = 38;
/** 这台电脑的名字与下面那行连接方式:名字中心离细环的距离,两行的高度;最下沿离细环 HUB_TEXT_BOTTOM。 */
const HUB_NAME_GAP = 14;
const HUB_NAME_H = 18;
const HUB_PROTOCOL_H = 16;
const HUB_TEXT_W = 180;
const HUB_TEXT_BOTTOM = HUB_NAME_GAP + HUB_NAME_H + HUB_PROTOCOL_H / 2;
/**
 * 中转站的字从圆点中心朝扇出那一侧最多伸多远:扇出的线离开圆点后拐上去(或拐下去),
 * 在字那一高度离圆点中心都在 35px 以外(紧凑行高、上下各两行时最近),这里留几像素空。
 */
const RELAY_LABEL_OUTER = 32;
/** 中转站的字离圆点的空隙与一行的高度(text-11,行高 1.3)。 */
const RELAY_LABEL_GAP = 6;
const RELAY_LINE_H = 11 * 1.3;

/**
 * 中转站的字从圆点中心朝中间最多伸多远。往中间那段 S 形线从字的高度穿过时(字写在上面而线从上面下来,
 * 或反过来),停在它的拐点之前;否则停在中间细环之前，细环按离圆点最近的那行宽字(协议，没有时是名字)
 * 的高度取实际宽度，整个在细环上方或下方时不受细环限制。最下面「UDP / WS · 往返」那行较短、居中，不算。
 */
function relayReachTowardHub(m: TopologyLayout['m'], hub: Point, relay: Point, below: boolean, hasRouteLine: boolean): number {
  const dx = Math.abs(hub.x - relay.x);
  const edge = below ? relay.y + m.relayR + RELAY_LABEL_GAP : relay.y - m.relayR - RELAY_LABEL_GAP;
  if (below ? hub.y > edge : hub.y < edge) return Math.max(0, Math.floor((m.relayR + 3 + dx - m.ring) / 2 - 8));
  // 写在上面时自上而下是名字、协议、「UDP / WS · 往返」;写在下面时名字紧贴圆点、往下是协议和走法、往返。
  const nameEdge = below || !hasRouteLine ? edge : edge - RELAY_LINE_H;
  const dy = Math.abs(hub.y - nameEdge);
  const chord = dy < m.ring ? Math.sqrt(m.ring * m.ring - dy * dy) : 0;
  return Math.max(0, Math.floor(dx - chord - 4));
}
/** 拓扑容器上定义的颜色,子元素与 CSS 只引用 --rcv2-ok / --rcv2-live / --rcv2-error(忙碌直接读 --warning-accent)。 */
const LIVE_STYLE = {
  ['--rcv2-ok' as string]: 'var(--status-success)',
  ['--rcv2-live' as string]: 'var(--status-info)',
  ['--rcv2-error' as string]: 'var(--error-fg)',
} as CSSProperties;

export interface RemoteConnectionTopologyProps {
  model: TopologyModel;
  linkStatus: DeviceLinkLinkStatus;
  /** 连接问题的说明(这台电脑的卡片里显示);没有为 null */
  issue?: string | null;
  /** 本机另一个 Cindy 实例占着远程连接 */
  standby?: boolean;
  /** 点折叠的离线行:展开 / 收起离线设备(折叠与否由 model 决定)。 */
  onToggleOffline: () => void;
  onRemoteDesktop: (node: TopologyNode) => void;
  /** 深链要打开哪台设备的卡片;设备还没画出来(离线折叠)时等它出现 */
  focusDeviceId?: string | null;
  /** 同一台设备被再次请求时随之变化,每个值只打开一次 */
  focusRequestKey?: string | null;
  /** 首批数据(设备目录与第一份链路快照)是否都到了;到了之后图才算稳定,见 SETTLE_MS */
  ready?: boolean;
  /** 远程切换连接方式(原型):各设备的切换状态与发起切换。 */
  switches?: ReadonlyMap<string, RemoteSwitchEntry>;
  onSwitch?: (node: TopologyNode, target: RemoteSwitchTarget) => void;
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

const PILL_W = 116;
const PILL_H = 16;
const INLINE_PILL_MIN_W = 92;
const STACKED_PILL_MIN_W = 52;
const PILL_COLUMN_GAP = 4;
/** Keep at least 2px of the usual 14px clearance next to a computer tile. */
const PILL_MAX_SHIFT = 12;

/** 链路标签(底层传输协议 · 延迟):at 是靠图块的那条边,标签朝中间排开;同一边的标签因此贴着图块对齐成一列。 */
function LatencyPill({
  at,
  side,
  maxWidth,
  transport,
  ms,
  strong,
  animate,
}: {
  at: Point;
  side: 1 | -1;
  maxWidth: number;
  transport: LinkTransport | null;
  ms: number | null;
  strong: boolean;
  animate: boolean;
}) {
  const { t } = useTranslation();
  const transportLabel = linkTransportLabel(transport, t);
  const latency = ms === null ? null : formatRtt(ms, t);
  if (!transportLabel && !latency) return null;
  // WebRTC is wider than UDP or WS and needs more room beside the latency.
  const inlineWidth = transport === 'webrtc' ? PILL_W : INLINE_PILL_MIN_W;
  const compact = maxWidth < inlineWidth;
  const stacked = compact && transportLabel !== null && latency !== null;
  return (
    <div
      className={cn('pointer-events-none flex items-center', side === 1 ? 'justify-end' : 'justify-start')}
      style={placed(at.x - (side * PILL_W) / 2, at.y, PILL_W, PILL_H, animate)}
      aria-hidden
    >
      <span
        className={cn(
          'truncate rounded-full bg-[var(--settings-theme-card-bg)] py-0.5 text-11 leading-none tabular-nums',
          compact ? 'px-px' : 'px-1.5',
          stacked && 'flex flex-col items-center gap-0.5',
          strong ? 'text-[var(--text-secondary)]' : 'text-[var(--text-tertiary)]',
        )}
        style={{ maxWidth }}
      >
        {stacked ? (
          <>
            <span>{transportLabel}</span>
            <span className="max-w-full truncate">{latency}</span>
          </>
        ) : [transportLabel, latency].filter(Boolean).join(' · ')}
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
  hintKind,
  dim,
  animate,
}: {
  layout: TopologyLayout;
  at: Point;
  side: 1 | -1;
  name: string;
  hint?: string;
  /** 小字是协议名时给出协议，画成图标 + 名称(Agent-Net 紫色) */
  hintKind?: ProtocolKind | null;
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
      {hint && hintKind ? (
        <ProtocolMark kind={hintKind} label={hint} className="text-12 leading-[1.3] text-[var(--text-tertiary)]" />
      ) : hint ? (
        <span className="max-w-full truncate text-12 leading-[1.3] text-[var(--text-tertiary)]">{hint}</span>
      ) : null}
    </div>
  );
}

export function RemoteConnectionTopology({
  model,
  linkStatus,
  issue = null,
  standby = false,
  onToggleOffline,
  onRemoteDesktop,
  focusDeviceId = null,
  focusRequestKey = null,
  ready = true,
  switches,
  onSwitch,
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
  const relaySide = layout.groups.find((group) => group.relay)?.side;
  const selfName = model.self?.name ?? t('settings.remoteControl.v2.node.thisComputer');
  const selfProtocol = selfProtocolKind(model, linkStatus);
  const selfProtocolLabel = protocolKindLabel(selfProtocol, t);
  const selfDescription = selfProtocolLabel ? `${selfName} · ${selfProtocolLabel}` : selfName;
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
    // Keep the entire column outside the hub text and the relay caption on this side.
    const captionEdge = Math.max(HUB_TEXT_W / 2, group.side === relaySide ? m.relay + RELAY_LABEL_OUTER : 0);
    const { toRelay, rows } = groupLines(layout, group, (id) => (isPhone(id) ? PHONE_W / 2 : m.half));
    if (toRelay && g.relay) {
      const emphasis = emphasisFor(group.ids, model.relay.flow !== null);
      lines.push(
        <path key={`${group.id}:relay`} d={toRelay.d} fill="none" strokeLinecap="round" {...lineAttrs('linked', emphasis)} />,
      );
      if (model.relay.flow) {
        flowing.push({ id: `${group.id}:relay`, shape: toRelay.shape, flow: model.relay.flow });
      }
      const relayProtocol = protocolKindLabel(model.relay.protocol, t);
      const relayRtt = model.relay.rttMs === null ? null : formatRtt(model.relay.rttMs, t);
      // 最下面一行：经中转的数据走 UDP 还是 WS,紧跟那条路的往返，如「UDP · 25 ms」。
      const relayPath = [relayTransportLabel(model.relay, t), relayRtt].filter(Boolean).join(' · ');
      const relayDescription = [model.relay.name, relayRouteLabel(model.relay, t), relayRtt].filter(Boolean).join(' · ');
      const size = m.relayR * 2;
      // 中转站的名字、连接方式和往返写在小圆点正上方、居中(用户反馈 2026-11-18:原来写在圆点下面朝中间排开,
      // 和这台电脑的名字、连接方式挤成一团)。这台电脑的字总在圆盘下面,所以只有中转站整个落在那些字
      // 下面(直连多到拆成两组时才会)才写到圆点下面;此时往中间那段线从上面下来,下面反而是空的。
      // 圆点上方:往中间那段线几乎是平的,扇出的线要离开圆点 RELAY_LABEL_OUTER 以外才拐上来。
      // 名字太长时贴着扇出那一侧的边界朝中间伸(relayReachTowardHub);还放不下就折成两行(葡语
      // 「Retransmissor Cindy」、自建中转的长名字),再长才截断(悬停圆点与两张卡片里有全名)。
      // 名字下面写协议，再下面写经中转的数据走 UDP 还是 WS 和那条路的往返(用户要求 2026-11-18:这台电脑名字下面的
      // 「Agent-Net」看不出是在说中转，也分不出 Agent-Net 的 UDP、WS 和 Device Link)。协议和走法分两行：
      // 中转点离中间近时(fleet)「Agent-Net · WS」写在一行放不下。
      const labelBelow = g.relay.y + m.relayR + RELAY_LABEL_GAP >= hub.y + m.ring + HUB_TEXT_BOTTOM + 4;
      const towardHub = relayReachTowardHub(m, hub, g.relay, labelBelow, relayPath !== '');
      const leftRoom = group.side === -1 ? RELAY_LABEL_OUTER : towardHub;
      const rightRoom = group.side === -1 ? towardHub : RELAY_LABEL_OUTER;
      nodes.push(
        <div key={`${group.id}:station`} style={placed(g.relay.x, g.relay.y, size, size, animate)}>
          <span
            className="rcv2-relay flex h-full w-full items-center justify-center rounded-full border"
            role="img"
            aria-label={relayDescription}
            title={relayDescription}
          >
            <Radio size={14} strokeWidth={1.75} aria-hidden />
          </span>
        </div>,
        <div
          key={`${group.id}:station:label`}
          className="pointer-events-none flex flex-col items-center text-center text-11 leading-[1.3] text-[var(--text-tertiary)]"
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            maxWidth: leftRoom + rightRoom,
            // 先按自身宽度居中到圆点上,再夹在左右可用范围内(百分比是标签自己的宽度)。
            transform: `translate3d(${Math.round(g.relay.x)}px, ${Math.round(labelBelow ? g.relay.y + m.relayR + RELAY_LABEL_GAP : g.relay.y - m.relayR - RELAY_LABEL_GAP)}px, 0) translate(clamp(${-leftRoom}px, -50%, calc(${rightRoom}px - 100%)), ${labelBelow ? '0' : '-100%'})`,
            transition: animate ? 'transform var(--motion-base) var(--motion-ease-move)' : undefined,
          }}
          aria-hidden
        >
          <span className="line-clamp-2 max-w-full break-words rounded bg-[var(--settings-theme-card-bg)] px-1">{model.relay.name}</span>
          {model.relay.protocol && relayProtocol ? (
            <span className="flex max-w-full rounded bg-[var(--settings-theme-card-bg)] px-1">
              <ProtocolMark kind={model.relay.protocol} label={relayProtocol} className="text-11 leading-[1.3] text-[var(--text-tertiary)]" />
            </span>
          ) : null}
          {relayPath ? (
            <span
              className={cn(
                'whitespace-nowrap rounded bg-[var(--settings-theme-card-bg)] px-1 tabular-nums',
                emphasis !== 'rest' && emphasis !== 'dim' && 'text-[var(--text-secondary)]',
              )}
            >
              {relayPath}
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
        {t(group.key === 'connecting' ? 'settings.devices.linkStatus.connecting' : `settings.remoteControl.v2.group.${group.key}`)}
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
      const switchEntry = switches?.get(node.id) ?? null;
      // 对方切换后要重新连接:这段时间图块不再是「连着」的绿色，标志换成转圈；名字下面写正在切换。
      const running = switchEntry?.kind === 'running' ? switchEntry : null;
      const reconnecting = running !== null && running.step !== 'request';
      const protocol = running
        ? t(running.target === 'agent-net' ? 'settings.remoteControl.v2.peerSwitch.row.toAgentNet' : 'settings.remoteControl.v2.peerSwitch.row.toDeviceLink')
        : protocolLabel(node, t);
      const transport = reconnecting ? null : peerTransport(node);
      const displayName = deviceLabel(node, t);
      const description = [displayName, protocol, linkTransportLabel(transport, t), sub.text].filter(Boolean).join(' · ');
      const pillRoom = Math.abs(row.at.x - hub.x) - captionEdge - PILL_COLUMN_GAP;
      const shift = Math.min(PILL_MAX_SHIFT, Math.max(0, STACKED_PILL_MIN_W - pillRoom));
      pills.push(
        <LatencyPill
          key={`${row.id}:pill`}
          at={{ ...row.at, x: row.at.x + group.side * shift }}
          side={group.side}
          maxWidth={Math.min(PILL_W, pillRoom + shift)}
          transport={transport}
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
                data-linked={!reconnecting && (node.status === 'direct' || node.status === 'relay') ? 'true' : undefined}
                data-error={node.status === 'attention' ? 'true' : undefined}
              >
                {phone ? <span className="rcv2-island" aria-hidden /> : null}
                {reconnecting ? (
                  <Spinner size={phone ? 12 : 15} aria-hidden />
                ) : (
                  <PlatformGlyph platform={node.platform} isMobile={node.isMobile} size={phone ? 13 : 16} />
                )}
                {/* 忙碌:右上角心动橙的呼吸小圆点,与侧栏「运行中」同一套(DESIGN.md §15.14) */}
                {node.busy && node.status !== 'offline' ? <span className="rcv2-busy session-status-breathing" aria-hidden /> : null}
              </span>
            </button>
          </PopoverTrigger>
          <PopoverContent side={group.side === 1 ? 'right' : 'left'} align="center" className="w-64 p-3">
            <DeviceNodePopover
              node={node}
              relayName={model.relay.name}
              onRemoteDesktop={onRemoteDesktop}
              switchEntry={switchEntry}
              onSwitch={onSwitch}
            />
          </PopoverContent>
        </Popover>,
        <RowText
          key={`${row.id}:text`}
          layout={layout}
          at={p}
          side={group.side}
          name={displayName}
          hint={protocol ?? undefined}
          hintKind={running ? null : protocolKind(node)}
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
            aria-label={selfDescription}
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
          />
        </PopoverContent>
      </Popover>
      <div
        className="pointer-events-none flex items-center justify-center"
        style={placed(hub.x, hub.y + m.ring + HUB_NAME_GAP, HUB_TEXT_W, HUB_NAME_H, animate)}
        aria-hidden
      >
        <span className="max-w-full truncate rounded bg-[var(--settings-theme-card-bg)] px-1.5 text-12 font-medium leading-[1.5] text-[var(--text-primary)]">
          {selfName}
        </span>
      </div>
      {/* 这台电脑自己用的连接方式，与其它设备名字下面同一个图标 + 名称(用户要求 2026-11-18) */}
      {selfProtocol && selfProtocolLabel ? (
        <div
          className="pointer-events-none flex items-center justify-center"
          style={placed(hub.x, hub.y + m.ring + HUB_NAME_GAP + HUB_NAME_H, HUB_TEXT_W, HUB_PROTOCOL_H, animate)}
          aria-hidden
        >
          <span className="flex max-w-full rounded bg-[var(--settings-theme-card-bg)] px-1.5">
            <ProtocolMark
              kind={selfProtocol}
              label={selfProtocolLabel}
              className="text-12 leading-[1.3] text-[var(--text-tertiary)]"
            />
          </span>
        </div>
      ) : null}
    </div>
  );
}
