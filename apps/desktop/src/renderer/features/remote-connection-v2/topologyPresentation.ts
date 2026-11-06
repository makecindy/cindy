/**
 * topologyPresentation —— 拓扑状态到 token / 文案 key 的映射(纯函数,拓扑图与浮层共用)。
 * 颜色登记:DESIGN.md §2「Remote connection V2 topology status colors」。
 */

import {
  platformLabel as platformLabelOf,
  relativeTime as relativeTimeOf,
} from '@/components/settings/deviceLabels';

import type { TopologyNode, TopologyStatus } from './topologyModel';

export { platformLabel, relativeTime } from '@/components/settings/deviceLabels';

export const STATUS_TONE: Record<TopologyStatus, string> = {
  direct: 'var(--status-success)',
  relay: 'var(--status-success)',
  unlinked: 'var(--text-tertiary)',
  attention: 'var(--warning-fg)',
  offline: 'var(--error-fg)',
};

/** 中转站图块:信息蓝,它不是在线 / 离线状态。 */
export const RELAY_TONE = 'var(--status-info)';

type T = (key: string, options?: Record<string, unknown>) => string;

/** 一台设备「怎么连」的一句话:直连 / 经「X」中转 / 在线未建链 / 要处理原因 / 离线。 */
export function pathLabel(node: TopologyNode, relayName: string, t: T): string {
  if (node.status === 'offline') return t('settings.remoteControl.v2.path.offline');
  if (node.attention === 'unresponsive') return t('settings.remoteControl.v2.attention.unresponsive');
  if (node.attention === 'peer-control-off') return t('settings.remoteControl.myDevices.peerControlOff');
  if (node.path === 'direct') return t('settings.remoteControl.v2.path.direct');
  if (node.path === 'relay') return t('settings.remoteControl.v2.path.relay', { name: relayName });
  return t('settings.remoteControl.v2.path.unlinked');
}

/**
 * 拓扑行下面那行小字:要处理的只写原因(不带系统名,留给宽度),经中转只写「经中转」
 * (中转名已在中转站下面),其它是「系统 · 路径」;离线写最后在线。
 */
export function rowSubtitle(node: TopologyNode, t: T): string {
  if (node.status === 'offline') {
    return t('settings.devices.lastSeen', { time: relativeTimeOf(node.lastSeenAt, t) });
  }
  if (node.status === 'attention') return pathLabel(node, '', t);
  // 行里用组名那套短词(直连 / 经中转 / 未建链),完整说法留给浮层。
  return `${platformLabelOf(node.platform)} · ${t(`settings.remoteControl.v2.group.${node.status}`)}`;
}

export function formatRtt(ms: number, t: T): string {
  return t('settings.remoteControl.v2.ms', { value: ms });
}
