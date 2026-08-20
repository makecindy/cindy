import {
  parseSyncedProjectOrderSnapshot,
  remapControllerOrderToHost,
  remapHostOrderToController,
  SIDEBAR_APPLY_PROJECT_ORDER_CHANNEL,
  SIDEBAR_GET_PROJECT_ORDER_CHANNEL,
  UNAVAILABLE_PROJECT_ORDER_SNAPSHOT,
  type SyncedProjectOrderSnapshot,
} from '@cindy/maker-shared/project-order-sync';

export function isProjectOrderUnavailable(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = 'code' in error ? (error as { code?: unknown }).code : undefined;
  return code === 'CHANNEL_NOT_ALLOWED' || code === 'REMOTE_DISABLED';
}

export async function fetchHostProjectOrder(
  invoke: <T>(deviceId: string, channel: string, args: unknown[]) => Promise<T>,
  deviceId: string,
): Promise<SyncedProjectOrderSnapshot> {
  try {
    const raw = await invoke<unknown>(deviceId, SIDEBAR_GET_PROJECT_ORDER_CHANNEL, []);
    return parseSyncedProjectOrderSnapshot(raw);
  } catch {
    return UNAVAILABLE_PROJECT_ORDER_SNAPSHOT;
  }
}

export async function applyHostProjectOrder(
  invoke: <T>(deviceId: string, channel: string, args: unknown[]) => Promise<T>,
  deviceId: string,
  snapshot: { manualProjectOrder: readonly string[]; projectOrder: 'activity' | 'custom' },
): Promise<SyncedProjectOrderSnapshot | null> {
  try {
    const raw = await invoke<unknown>(deviceId, SIDEBAR_APPLY_PROJECT_ORDER_CHANNEL, [{
      manualProjectOrder: remapControllerOrderToHost(deviceId, snapshot.manualProjectOrder),
      projectOrder: snapshot.projectOrder,
    }]);
    return parseSyncedProjectOrderSnapshot(raw);
  } catch (error) {
    if (isProjectOrderUnavailable(error)) return null;
    return null;
  }
}

export function controllerKeysFromHost(
  deviceId: string,
  snapshot: SyncedProjectOrderSnapshot,
): string[] {
  if (!snapshot.authoritative || snapshot.projectOrder !== 'custom') return [];
  return remapHostOrderToController(deviceId, snapshot.manualProjectOrder);
}
