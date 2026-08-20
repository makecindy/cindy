import {
  isHostProjectOrderChannelMissing,
  parseSyncedProjectOrderSnapshot,
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

export function subscribeRemoteProjectOrderChanged(listener: RemoteProjectOrderListener): () => void {
  remoteProjectOrderListeners.add(listener);
  return () => {
    remoteProjectOrderListeners.delete(listener);
  };
}

export function applyRemoteProjectOrderPush(deviceId: string, payload: unknown): void {
  const snapshot = parseSyncedProjectOrderSnapshot(payload);
  for (const listener of remoteProjectOrderListeners) listener(deviceId, snapshot);
}

export { SIDEBAR_PROJECT_ORDER_CHANGED_CHANNEL };

export async function applyHostProjectOrder(
  invoke: <T>(deviceId: string, channel: string, args: unknown[]) => Promise<T>,
  deviceId: string,
  snapshot: {
    manualProjectOrder: readonly string[];
    ownerStamp?: SyncedProjectOrderOwnerStamp;
    projectOrder: 'activity' | 'custom';
  },
): Promise<HostProjectOrderResult> {
  if (!snapshot.ownerStamp) return { kind: 'transient' };
  try {
    const raw = await invoke<unknown>(deviceId, SIDEBAR_APPLY_PROJECT_ORDER_CHANNEL, [{
      ...snapshot.ownerStamp,
      manualProjectOrder: remapControllerOrderToHost(deviceId, snapshot.manualProjectOrder),
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
