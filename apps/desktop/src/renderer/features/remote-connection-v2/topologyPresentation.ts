/**
 * topologyPresentation —— 拓扑状态到文案的映射(纯函数,拓扑图与浮层共用)。
 * 颜色只有三种(用户裁决 2026-11-06,不用黄色):绿 = 连着、蓝 = 正在收发、红 = 出错 / 要处理(DESIGN.md §2 本页登记)。
 */

import { relativeTime as relativeTimeOf } from '@/components/settings/deviceLabels';

import type { LinkTransport, TopologyFlow, TopologyModel, TopologyNode } from './topologyModel';

export { platformLabel, relativeTime } from '@/components/settings/deviceLabels';

type T = (key: string, options?: Record<string, unknown>) => string;

export type ProtocolKind = 'agent-net' | 'device-link';

/** Protocol of the actual path shown in the topology. */
export function protocolKind(node: TopologyNode): ProtocolKind | null {
  if (!node.path || node.status === 'offline' || node.encrypted === undefined) return null;
  return node.encrypted ? 'agent-net' : 'device-link';
}

export function protocolLabel(node: TopologyNode, t: T): string | null {
  return protocolKindLabel(protocolKind(node), t);
}

export function protocolKindLabel(kind: ProtocolKind | null | undefined, t: T): string | null {
  if (!kind) return null;
  return t(kind === 'agent-net' ? 'settings.remoteControl.v2.protocol.agentNet' : 'settings.remoteControl.v2.protocol.deviceLink');
}

export function selfProtocolKind(model: Pick<TopologyModel, 'relay'>, linkStatus: string): ProtocolKind | null {
  return linkStatus === 'online' ? model.relay.protocol ?? null : null;
}

/** 经中转的数据走中转的 UDP 还是 WebSocket:「UDP」/「WS」;不知道时为 null。 */
export function relayTransportLabel(relay: Pick<TopologyModel['relay'], 'transport'>, t: T): string | null {
  return linkTransportLabel(relay.transport, t);
}

/** 底层传输协议文案:「UDP」/「WS」/「WebRTC」;不知道时为 null。 */
export function linkTransportLabel(transport: LinkTransport | null | undefined, t: T): string | null {
  if (!transport) return null;
  if (transport === 'udp') return t('settings.remoteControl.v2.relayTransport.udp');
  if (transport === 'websocket') return t('settings.remoteControl.v2.relayTransport.websocket');
  return t('settings.remoteControl.v2.linkTransport.webrtc');
}

/**
 * 某台设备链接的底层传输协议:Agent-Net 直连是 UDP、经中转跟随本机中转走法(UDP / WS);
 * Device Link 直连是 WebRTC、经中转是 WS。buildTopology 已填好 node.transport;单测直接构造节点时按字段推导。
 */
export function peerTransport(node: Pick<TopologyNode, 'status' | 'path' | 'encrypted' | 'transport'>): LinkTransport | null {
  if (node.transport !== undefined) return node.transport;
  if (!node.path || node.status === 'offline' || node.encrypted === undefined) return null;
  if (node.encrypted) return node.path === 'direct' ? 'udp' : null;
  return node.path === 'direct' ? 'webrtc' : 'websocket';
}

export function peerTransportLabel(
  node: Pick<TopologyNode, 'status' | 'path' | 'encrypted' | 'transport'>,
  t: T,
): string | null {
  return linkTransportLabel(peerTransport(node), t);
}

/**
 * 中转点上写的连接方式:协议加上经中转的数据走哪条路，如「Agent-Net · UDP」「Agent-Net · WS」「Device Link · WS」
 * (用户要求 2026-11-18:看不出中转走的是 Agent-Net 的 UDP、WS 还是 Device Link)。没有协议时为 null。
 */
export function relayRouteLabel(relay: Pick<TopologyModel['relay'], 'protocol' | 'transport'>, t: T): string | null {
  const protocol = protocolKindLabel(relay.protocol, t);
  if (!protocol) return null;
  const transport = relayTransportLabel(relay, t);
  return transport ? `${protocol} · ${transport}` : protocol;
}

/** 一台设备「怎么连」的一句话:直连 / 经「X」中转 / 在线未建链 / 要处理原因 / 离线。 */
export function pathLabel(node: TopologyNode, relayName: string, t: T): string {
  if (node.status === 'offline') return t('settings.remoteControl.v2.path.offline');
  if (node.attention === 'unresponsive') return t('settings.remoteControl.v2.attention.unresponsive');
  if (node.attention === 'peer-control-off') return t('settings.remoteControl.myDevices.peerControlOff');
  if (node.path === 'direct') return t('settings.remoteControl.v2.path.direct');
  if (node.path === 'relay') return t('settings.remoteControl.v2.path.relay', { name: relayName });
  if (node.status === 'connecting') return t('settings.devices.linkStatus.connecting');
  return t('settings.remoteControl.v2.path.unlinked');
}

export function flowLabel(flow: TopologyFlow, t: T): string {
  return t(`settings.remoteControl.v2.flow.${flow}`);
}

export type RowSubtitleTone = 'muted' | 'error' | 'live';

/**
 * 拓扑行名字下面那行小字。系统用图标表示、路径由组名表示,这里不再重复(用户要求 2026-11-06)。
 * 先后:要处理写原因(红)→ 离线写最后在线 → 有消息在走写流向(蓝)→ 忙碌 / 型号;都没有就只显示名字。
 */
export function rowSubtitle(node: TopologyNode, t: T): { text: string; tone: RowSubtitleTone } {
  if (node.status === 'attention') return { text: pathLabel(node, '', t), tone: 'error' };
  if (node.status === 'connecting') return { text: pathLabel(node, '', t), tone: 'muted' };
  if (node.status === 'offline') {
    return { text: t('settings.devices.lastSeen', { time: relativeTimeOf(node.lastSeenAt, t) }), tone: 'muted' };
  }
  if (node.flow) return { text: flowLabel(node.flowText ?? node.flow, t), tone: 'live' };
  const parts = [node.busy ? t('settings.devices.status.busy') : null, node.modelLabel].filter(Boolean);
  return { text: parts.join(' · '), tone: 'muted' };
}

export function formatRtt(ms: number, t: T): string {
  return t('settings.remoteControl.v2.ms', { value: Math.round(ms) });
}
