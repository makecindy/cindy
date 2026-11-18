/**
 * topologyPresentation —— 拓扑状态到文案的映射(纯函数,拓扑图与浮层共用)。
 * 颜色只有三种(用户裁决 2026-11-06,不用黄色):绿 = 连着、蓝 = 正在收发、红 = 出错 / 要处理(DESIGN.md §2 本页登记)。
 */

import { relativeTime as relativeTimeOf } from '@/components/settings/deviceLabels';

import type { TopologyFlow, TopologyModel, TopologyNode } from './topologyModel';

export { platformLabel, relativeTime } from '@/components/settings/deviceLabels';

type T = (key: string, options?: Record<string, unknown>) => string;

export type ProtocolKind = 'agent-net' | 'device-link';

/** The negotiated link is authoritative; unknown or disconnected peers have no protocol. */
export function protocolKind(node: TopologyNode): ProtocolKind | null {
  if (!node.path || node.status === 'offline' || node.encrypted === undefined) return null;
  return node.encrypted ? 'agent-net' : 'device-link';
}

export function protocolName(kind: ProtocolKind, t: T): string {
  return t(kind === 'agent-net' ? 'settings.remoteControl.v2.protocol.agentNet' : 'settings.remoteControl.v2.protocol.deviceLink');
}

export function protocolLabel(node: TopologyNode, t: T): string | null {
  const kind = protocolKind(node);
  return kind ? protocolName(kind, t) : null;
}

/**
 * 这台电脑自己用的连接方式(用户要求 2026-11-18):以主进程实际装上的主连接为准，不看开关偏好。
 * 只在连着中转时写;连接中、已停或主进程没给(旧版 / 链路未起)都不写，免得把还没定下来的写成 Device Link。
 */
export function selfProtocolKind(model: Pick<TopologyModel, 'selfEncrypted'>, linkStatus: string): ProtocolKind | null {
  if (linkStatus !== 'online' || model.selfEncrypted === undefined) return null;
  return model.selfEncrypted ? 'agent-net' : 'device-link';
}

/** 一台设备「怎么连」的一句话:直连 / 经「X」中转 / 在线未建链 / 要处理原因 / 离线。 */
export function pathLabel(node: TopologyNode, relayName: string, t: T): string {
  if (node.status === 'offline') return t('settings.remoteControl.v2.path.offline');
  if (node.attention === 'unresponsive') return t('settings.remoteControl.v2.attention.unresponsive');
  if (node.attention === 'peer-control-off') return t('settings.remoteControl.myDevices.peerControlOff');
  if (node.path === 'direct') return t('settings.remoteControl.v2.path.direct');
  if (node.path === 'relay') return t('settings.remoteControl.v2.path.relay', { name: relayName });
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
