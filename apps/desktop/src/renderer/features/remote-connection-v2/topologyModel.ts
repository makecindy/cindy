/**
 * topologyModel —— 远程连接 V2 拓扑的纯状态推导(可单测,不碰 DOM / IPC)。
 * ---------------------------------------------------------------------------
 * 输入:同账号设备清单(V1 目录)、本机已协商链路快照(路径 / 往返)、中转信息、正在控制本机的设备、
 * 无响应熔断中的设备。输出:每台设备一个节点(状态 / 路径 / 往返)、按「怎么连」分组并分到左右两边、
 * 离线多了折成一行、一组太多对半分,以及顶上那行数字。
 *
 * 状态只分五档,颜色各有一档(DESIGN.md §2 本页登记):直连 / 经中转(绿,在线)、在线但没建链(灰)、
 * 要处理(金:对方没开被控 / 无响应)、离线(红)。文字同时写明,颜色不是唯一信号。
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

export interface TopologyNode {
  id: string;
  name: string;
  platform: string | null;
  modelLabel: string | null;
  isMobile: boolean;
  status: TopologyStatus;
  /** 本机到它的数据路径;没建链 / 离线为 null。 */
  path: 'direct' | 'relay' | null;
  rttMs: number | null;
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
    rttMs: open ? link.rttMs : null,
    busy: d.busy,
    lastSeenAt: d.lastSeenAt,
    controlling: controlledBy.has(d.deviceId),
    attention,
    remoteControlEnabled: d.remoteControlEnabled,
    controlEnabled: d.controlEnabled,
    appVersion: d.appVersion,
  };
}

/** 组内排序:往返短的在前(没测到的靠后),再按名字。 */
export function compareNodes(a: TopologyNode, b: TopologyNode): number {
  const ra = a.rttMs ?? Number.POSITIVE_INFINITY;
  const rb = b.rttMs ?? Number.POSITIVE_INFINITY;
  if (ra !== rb) return ra - rb;
  return a.name.localeCompare(b.name);
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
    relay: { name: input.relayName, selfHosted: input.selfHosted, rttMs: input.relayRttMs },
    stats,
    dense: nodes.length >= DENSE_MIN,
  };
}

/** 往返快慢的三档:≤ 15 ms 快(绿)、≥ 80 ms 慢(金)、中间不上色。 */
export function rttTone(ms: number | null): 'fast' | 'slow' | 'plain' {
  if (ms === null) return 'plain';
  if (ms <= 15) return 'fast';
  if (ms >= 80) return 'slow';
  return 'plain';
}
