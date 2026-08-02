import type { Envelope } from '@cindy/device-link';

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
  onLinkClosed: (deviceId: string) => void,
): boolean {
  if (env.kind !== 'link-close' || !env.src) return false;
  onLinkClosed(env.src);
  return true;
}
