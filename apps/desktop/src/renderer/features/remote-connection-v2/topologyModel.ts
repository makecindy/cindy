/**
 * topologyModel —— 远程连接 V2 拓扑的纯状态推导(可单测,不碰 DOM / IPC)。
 * ---------------------------------------------------------------------------
 * 输入:同账号设备清单(V1 目录)、本机已协商链路快照(路径 / 往返 / 最近业务收发)、中转信息、
 * 正在控制本机的设备、无响应熔断中的设备。输出:每台设备一个节点(状态 / 路径 / 往返 / 消息流向)、
 * 按「怎么连」分组并分到左右两边、离线多了折成一行、一组太多对半分,以及顶上那行数字。
 *
 * 状态分五档:直连、经中转、在线但没建链、要处理(对方没开被控 / 无响应)、离线。颜色只有绿(连着、
 * 有消息时变流动虚线)和红(要处理),见 DESIGN.md §2 本页登记;状态同时靠位置、线型、组名和文字表达。
 * 组内按名字排,往返刷新不挪位置。
 */

import { isMobilePlatform } from '@cindy/maker-shared/device-list';

export type TopologyStatus = 'direct' | 'relay' | 'unlinked' | 'attention' | 'offline';
export type AttentionReason = 'peer-control-off' | 'unresponsive';
export type TopologyGroupKey = TopologyStatus;
export type TopologySide = 1 | -1;

export const GROUP_ORDER: readonly TopologyGroupKey[] = ['direct', 'relay', 'unlinked', 'attention', 'offline'];
/** 一组超过这么多台(且不经中转)就对半分到两边。 */
export const SPLIT_THRESHOLD = 6;
/** 离线设备达到这么多台就折成一行。 */
export const FOLD_OFFLINE_MIN = 2;
/** 其它设备超过这么多台进入紧凑模式(行高更小、显示组名)。 */
export const DENSE_MIN = 9;
/** 折叠离线行的虚拟节点 id。 */
export const OFFLINE_FOLD_ID = 'offgroup';
/**
 * 最近这么久内本机和它之间有业务消息,就算「消息在走」。渲染层每 2 秒取一次快照,
 * 持续收发时一直在窗口内;停下后最多再走几秒就静止。
 */
export const FLOW_WINDOW_MS = 4_000;
/**
 * 名字下面那行字的流向放宽:一个方向在 FLOW_WINDOW_MS 内有消息、另一个方向在这么久之内也有过,
 * 就写「收发中」。远程操作是一问一答,只按 4 秒看会在「发送中 / 收发中」之间来回跳,字一直在换
 * (用户反馈 2026-11-07:晃眼)。线上虚线的流向仍按 FLOW_WINDOW_MS。
 */
export const LABEL_HOLD_MS = 15_000;

/** 消息流向:out 本机发给它,in 它发给本机,both 双向都有。 */
export type TopologyFlow = 'out' | 'in' | 'both';

export interface TopologyNode {
  id: string;
  encrypted?: boolean;
  name: string;
  platform: string | null;
  modelLabel: string | null;
  isMobile: boolean;
  status: TopologyStatus;
  /** 本机到它的数据路径;没建链 / 离线为 null。 */
  path: 'direct' | 'relay' | null;
  rttMs: number | null;
  /** 最近有没有业务消息在这条链路上走、往哪边走;没有为 null。只有直连 / 经中转的设备会有。 */
  flow: TopologyFlow | null;
  /** 写给人看的流向(行字、卡片):在 flow 的基础上放宽,见 LABEL_HOLD_MS;flow 为 null 时也为 null */
  flowText: TopologyFlow | null;
  busy: boolean;
  lastSeenAt: string | null;
  /** 它正在控制这台电脑。 */
  controlling: boolean;
  attention: AttentionReason | null;
  remoteControlEnabled: boolean;
  controlEnabled: boolean;
  appVersion: string | null;
}

export interface TopologyGroup {
  key: TopologyGroupKey;
  /** 对半分时第二半是 `<key>#2`。 */
  id: string;
  side: TopologySide;
  ids: string[];
  /** 实际画出来的行;离线折叠时只有 OFFLINE_FOLD_ID。 */
  rows: string[];
  collapsed: boolean;
}

export interface TopologyRelay {
  name: string;
  selfHosted: boolean;
  rttMs: number | null;
  /** 经中转的设备里有消息在走时,这台电脑到中转站那一段也在走(各设备流向合起来)。 */
  flow: TopologyFlow | null;
}

export interface TopologyStats {
  total: number;
  online: number;
  direct: number;
  relay: number;
  unlinked: number;
  attention: number;
  offline: number;
}

export interface TopologyModel {
  self: { name: string; platform: string | null } | null;
  nodes: TopologyNode[];
  byId: Map<string, TopologyNode>;
  groups: TopologyGroup[];
  relay: TopologyRelay;
  stats: TopologyStats;
  dense: boolean;
}

export interface BuildTopologyInput {
  devices: readonly DeviceLinkDeviceView[];
  links: readonly DeviceLinkPeerLinkView[];
  relayRttMs: number | null;
  relayName: string;
  selfHosted: boolean;
  controlledBy: readonly string[];
  unresponsive: readonly string[];
  showOffline: boolean;
}

function deriveNode(
  d: DeviceLinkDeviceView,
  link: DeviceLinkPeerLinkView | undefined,
  controlledBy: ReadonlySet<string>,
  unresponsive: ReadonlySet<string>,
): TopologyNode {
  const isMobile = isMobilePlatform(d.platform);
  const open = !!link && link.open;
  const path = open ? link.path : null;
  let attention: AttentionReason | null = null;
  if (d.online && unresponsive.has(d.deviceId)) attention = 'unresponsive';
  // 手机 / 平板是控制端,没有被控能力,不算「没开被控」。
  else if (d.online && !isMobile && !d.remoteControlEnabled) attention = 'peer-control-off';
  const status: TopologyStatus = !d.online
    ? 'offline'
    : attention
      ? 'attention'
      : path === 'direct'
        ? 'direct'
        : path === 'relay'
          ? 'relay'
          : 'unlinked';
  return {
    id: d.deviceId,
    name: d.name,
    platform: d.platform,
    modelLabel: d.deviceInfo?.modelLabel?.trim() || null,
    isMobile,
    status,
    path,
    encrypted: open ? link.encrypted : undefined,
    rttMs: open ? link.rttMs : null,
    flow: open && (status === 'direct' || status === 'relay') ? flowOf(link) : null,
    flowText: open && (status === 'direct' || status === 'relay') ? flowTextOf(link) : null,
    busy: d.busy,
    lastSeenAt: d.lastSeenAt,
    controlling: controlledBy.has(d.deviceId),
    attention,
    remoteControlEnabled: d.remoteControlEnabled,
    controlEnabled: d.controlEnabled,
    appVersion: d.appVersion,
  };
}

/** 快照里的最近收发 → 流向;窗口外或从没收发为 null。纯函数,可单测。 */
export function flowOf(link: Pick<DeviceLinkPeerLinkView, 'sentAgoMs' | 'receivedAgoMs'>): TopologyFlow | null {
  const out = link.sentAgoMs !== null && link.sentAgoMs <= FLOW_WINDOW_MS;
  const inbound = link.receivedAgoMs !== null && link.receivedAgoMs <= FLOW_WINDOW_MS;
  if (out && inbound) return 'both';
  if (out) return 'out';
  return inbound ? 'in' : null;
}

/** 行字用的流向:正在走的方向之外,另一个方向在 LABEL_HOLD_MS 内也有过就算双向。纯函数,可单测。 */
export function flowTextOf(link: Pick<DeviceLinkPeerLinkView, 'sentAgoMs' | 'receivedAgoMs'>): TopologyFlow | null {
  const flow = flowOf(link);
  if (flow !== 'out' && flow !== 'in') return flow;
  const other = flow === 'out' ? link.receivedAgoMs : link.sentAgoMs;
  return other !== null && other <= LABEL_HOLD_MS ? 'both' : flow;
}

/** 几台设备的流向合在一起(中转站那一段用)。 */
export function mergeFlows(flows: ReadonlyArray<TopologyFlow | null>): TopologyFlow | null {
  let out = false;
  let inbound = false;
  for (const f of flows) {
    if (f === 'out' || f === 'both') out = true;
    if (f === 'in' || f === 'both') inbound = true;
  }
  if (out && inbound) return 'both';
  if (out) return 'out';
  return inbound ? 'in' : null;
}

/**
 * 组内排序:只按名字(数字按数值),同名再按 id。往返、流量这些会一直变的值不参与,
 * 否则延迟一刷新图块就换位置(用户反馈 2026-11-06)。
 */
export function compareNodes(a: TopologyNode, b: TopologyNode): number {
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) || a.id.localeCompare(b.id);
}

/** 哪边行少放哪边,右边优先;纯函数,可单测。 */
export function assignSides(groups: readonly { rows: string[] }[]): TopologySide[] {
  let right = 0;
  let left = 0;
  return groups.map((g) => {
    const side: TopologySide = right <= left ? 1 : -1;
    if (side === 1) right += g.rows.length;
    else left += g.rows.length;
    return side;
  });
}

export function buildTopology(input: BuildTopologyInput): TopologyModel {
  const self = input.devices.find((d) => d.isSelf) ?? null;
  const others = input.devices.filter((d) => !d.isSelf);
  const linkById = new Map(input.links.map((l) => [l.deviceId, l] as const));
  const controlledBy = new Set(input.controlledBy);
  const unresponsive = new Set(input.unresponsive);
  const nodes = others
    .map((d) => deriveNode(d, linkById.get(d.deviceId), controlledBy, unresponsive))
    .sort(compareNodes);
  const byId = new Map(nodes.map((n) => [n.id, n] as const));

  const byKey = new Map<TopologyGroupKey, string[]>();
  for (const n of nodes) {
    const list = byKey.get(n.status) ?? [];
    list.push(n.id);
    byKey.set(n.status, list);
  }

  const raw: Omit<TopologyGroup, 'side'>[] = [];
  for (const key of GROUP_ORDER) {
    const ids = byKey.get(key);
    if (!ids?.length) continue;
    if (key === 'offline' && ids.length >= FOLD_OFFLINE_MIN && !input.showOffline) {
      raw.push({ key, id: key, ids, rows: [OFFLINE_FOLD_ID], collapsed: true });
      continue;
    }
    // 经中转的一组共用一个中转站,不拆;其它组太多就对半分到两边。
    if (key !== 'relay' && ids.length > SPLIT_THRESHOLD) {
      const half = Math.ceil(ids.length / 2);
      raw.push({ key, id: key, ids: ids.slice(0, half), rows: ids.slice(0, half), collapsed: false });
      raw.push({ key, id: `${key}#2`, ids: ids.slice(half), rows: ids.slice(half), collapsed: false });
      continue;
    }
    raw.push({ key, id: key, ids, rows: ids, collapsed: false });
  }
  const sides = assignSides(raw);
  const groups: TopologyGroup[] = raw.map((g, i) => ({ ...g, side: sides[i] ?? 1 }));

  const count = (status: TopologyStatus) => nodes.filter((n) => n.status === status).length;
  const stats: TopologyStats = {
    total: nodes.length,
    online: nodes.filter((n) => n.status !== 'offline').length,
    direct: count('direct'),
    relay: count('relay'),
    unlinked: count('unlinked'),
    attention: count('attention'),
    offline: count('offline'),
  };

  return {
    self: self ? { name: self.selfName?.trim() || self.name, platform: self.platform } : null,
    nodes,
    byId,
    groups,
    relay: {
      name: input.relayName,
      selfHosted: input.selfHosted,
      rttMs: input.relayRttMs,
      flow: mergeFlows(nodes.filter((n) => n.status === 'relay').map((n) => n.flow)),
    },
    stats,
    dense: nodes.length >= DENSE_MIN,
  };
}
