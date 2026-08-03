import type { Envelope, LinkClosePayload } from '@cindy/device-link';

type DeviceScopedState = Pick<Map<string, unknown>, 'delete'>;
type DeviceTopicAckState = Pick<Map<string, Set<string>>, 'delete' | 'get'>;

export function invalidatePeerLinkState(
  deviceId: string,
  openLinks: DeviceScopedState,
  remoteTopicAcks: DeviceTopicAckState,
  onTopicsInterrupted: (topics: readonly string[]) => void,
): void {
  openLinks.delete(deviceId);
  const topics = remoteTopicAcks.get(deviceId);
  remoteTopicAcks.delete(deviceId);
  if (topics && topics.size > 0) onTopicsInterrupted([...topics]);
}

/**
 * 永久关闭(user/toggle-off/shutdown/revoked 及未知新值)→ 抑制后台 rehydrate
 * 对该设备的自动重建:对方刚明确结束链路,在途 openLink 被 LINK_NOT_OPEN 拒后
 * 不得由 rehydrate/退避重试链再次建链;只有 transport-timeout(唯一可恢复的
 * 瞬时重置)解除抑制继续恢复。抑制的其它解除点(由 context 各接线点负责):
 * 权威 presence 可用快照、新 relay 连接代际、显式 openLink 成功(用户/页面主动)。
 */
export function updateRehydrateSuppressionOnLinkClose(
  suppressed: Set<string>,
  deviceId: string,
  reason: string | undefined,
): void {
  if (reason === 'transport-timeout') suppressed.delete(deviceId);
  else suppressed.add(deviceId);
}

export function handlePeerLinkCloseFrame(
  env: Envelope,
  onLinkClosed: (deviceId: string, reason?: string) => void,
): boolean {
  if (env.kind !== 'link-close' || !env.src) return false;
  // reason 透传给上层:transport-timeout(被控端对本机的可靠重试耗尽后的
  // peer 级瞬时重置)需要控制端立即重建链路,而不是等下一次外部 rehydrate。
  const reason = (env.payload as LinkClosePayload | undefined)?.reason;
  onLinkClosed(env.src, typeof reason === 'string' ? reason : undefined);
  return true;
}
