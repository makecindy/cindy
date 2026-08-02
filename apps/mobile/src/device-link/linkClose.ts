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
