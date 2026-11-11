import {
  isHostProjectOrderChannelMissing,
  parseSyncedProjectOrderOwnerStamp,
  parseSyncedProjectOrderSnapshot,
  shouldAcceptHostProjectOrderPush,
  remapControllerOrderToHost,
  remapHostOrderToController,
  SIDEBAR_APPLY_PROJECT_ORDER_CHANNEL,
  SIDEBAR_GET_PROJECT_ORDER_CHANNEL,
  SIDEBAR_PROJECT_ORDER_CHANGED_CHANNEL,
  UNAVAILABLE_PROJECT_ORDER_SNAPSHOT,
  type SyncedProjectOrderOwnerStamp,
  type SyncedProjectOrderSnapshot,
} from '@cindy/maker-shared/project-order-sync';

export function isProjectOrderUnavailable(error: unknown): boolean {
  return isHostProjectOrderChannelMissing(error);
}

export type HostProjectOrderResult =
  | { kind: 'ok'; snapshot: SyncedProjectOrderSnapshot }
  | { kind: 'unavailable' }
  | { kind: 'transient' };

export async function fetchHostProjectOrder(
  invoke: <T>(deviceId: string, channel: string, args: unknown[]) => Promise<T>,
  deviceId: string,
): Promise<HostProjectOrderResult> {
  try {
    const raw = await invoke<unknown>(deviceId, SIDEBAR_GET_PROJECT_ORDER_CHANNEL, []);
    return { kind: 'ok', snapshot: parseSyncedProjectOrderSnapshot(raw) };
  } catch (error) {
    if (isHostProjectOrderChannelMissing(error)) return { kind: 'unavailable' };
    return { kind: 'transient' };
  }
}

type RemoteProjectOrderListener = (deviceId: string, snapshot: SyncedProjectOrderSnapshot) => void;
const remoteProjectOrderListeners = new Set<RemoteProjectOrderListener>();
const remoteProjectOrderStamps = new Map<string, SyncedProjectOrderOwnerStamp>();
const stampedRemoteProjectOrderDevices = new Set<string>();

/** peer 新连接代际 / 主机进程重启后 generation 可能从更小值重计,必须清掉旧水印。 */
export function resetRemoteProjectOrderPushFence(deviceId?: string): void {
  if (deviceId) {
    remoteProjectOrderStamps.delete(deviceId);
    stampedRemoteProjectOrderDevices.delete(deviceId);
    return;
  }
  remoteProjectOrderStamps.clear();
  stampedRemoteProjectOrderDevices.clear();
}

export function rememberRemoteProjectOrderStamp(
  deviceId: string,
  stamp: SyncedProjectOrderOwnerStamp | undefined,
): void {
  if (!stamp) return;
  stampedRemoteProjectOrderDevices.add(deviceId);
  remoteProjectOrderStamps.set(deviceId, stamp);
}

export function subscribeRemoteProjectOrderChanged(listener: RemoteProjectOrderListener): () => void {
  remoteProjectOrderListeners.add(listener);
  return () => {
    remoteProjectOrderListeners.delete(listener);
  };
}

export function applyRemoteProjectOrderPush(
  deviceId: string,
  payload: unknown,
  envelope: {
    controllerDataOwnerId?: string | null;
    ownerStamp?: unknown;
    ownerStampPresent?: boolean;
  } = {},
): boolean {
  const incomingPresent = envelope.ownerStampPresent
    ?? Object.prototype.hasOwnProperty.call(envelope, 'ownerStamp');
  const incoming = parseSyncedProjectOrderOwnerStamp(envelope.ownerStamp);
  if (!shouldAcceptHostProjectOrderPush({
    controllerDataOwnerId: envelope.controllerDataOwnerId ?? null,
    incoming,
    incomingPresent,
    previous: remoteProjectOrderStamps.get(deviceId),
    seenStampFromDevice: stampedRemoteProjectOrderDevices.has(deviceId),
  })) {
    return false;
  }
  if (incomingPresent && incoming) {
    stampedRemoteProjectOrderDevices.add(deviceId);
    remoteProjectOrderStamps.set(deviceId, incoming);
  }
  const snapshot = parseSyncedProjectOrderSnapshot(payload);
  for (const listener of remoteProjectOrderListeners) listener(deviceId, snapshot);
  return true;
}

export { SIDEBAR_PROJECT_ORDER_CHANGED_CHANNEL };

export async function applyHostProjectOrder(
  invoke: <T>(deviceId: string, channel: string, args: unknown[]) => Promise<T>,
  deviceId: string,
  snapshot: {
    manualProjectOrder: readonly string[];
    ownerStamp?: SyncedProjectOrderOwnerStamp;
    knownHostKeys?: readonly string[];
    projectOrder: 'activity' | 'custom';
  },
): Promise<HostProjectOrderResult> {
  if (!snapshot.ownerStamp) return { kind: 'transient' };
  try {
    const raw = await invoke<unknown>(deviceId, SIDEBAR_APPLY_PROJECT_ORDER_CHANNEL, [{
      ...snapshot.ownerStamp,
      manualProjectOrder: remapControllerOrderToHost(
        deviceId,
        snapshot.manualProjectOrder,
        snapshot.knownHostKeys ?? [],
      ),
      projectOrder: snapshot.projectOrder,
    }]);
    return { kind: 'ok', snapshot: parseSyncedProjectOrderSnapshot(raw) };
  } catch (error) {
    if (isHostProjectOrderChannelMissing(error)) return { kind: 'unavailable' };
    return { kind: 'transient' };
  }
}

export function controllerKeysFromHost(
  deviceId: string,
  snapshot: SyncedProjectOrderSnapshot,
): string[] {
  if (!snapshot.authoritative || snapshot.projectOrder !== 'custom') return [];
  return remapHostOrderToController(deviceId, snapshot.manualProjectOrder);
}
