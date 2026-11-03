/** Remote catalog invalidations use the same refresh scheduling as local reads.
 * Existing device generations remain the authority for disconnect/owner changes.
 */
import { createCoalescedRefresh } from '@/lib/coalescedRefresh';
import { evictAllRemoteCapabilities, evictDeviceCapabilities, prefetchDeviceCapabilities } from '@/hooks/useAgentCapabilities';
import {
  evictAllDeviceProviders,
  evictDeviceProviders,
  isDeviceProvidersGenerationCurrent,
  prefetchDeviceProviders,
} from '@/hooks/useDeviceProviders';

const refreshes = new Map<
  string,
  {
    schedule: ReturnType<typeof createCoalescedRefresh<void>>;
    generation: number;
  }
>();

/** 分享 ID 跨账号相同；切换账号时不能复用目录，也不能接收旧账号的在途结果。 */
export function invalidateRemoteCatalogSnapshots(): void {
  evictAllDeviceProviders();
  evictAllRemoteCapabilities();
  refreshes.clear();
}

export async function refreshRemoteCatalogSnapshot(deviceId: string): Promise<void> {
  const generation = evictDeviceProviders(deviceId, { retainDisplaySnapshot: true });
  evictDeviceCapabilities(deviceId, { retainDisplaySnapshot: true });
  const previous = refreshes.get(deviceId);
  const refresh = {
    // An intervening eviction belongs to disconnect/ownership handling. Its new
    // link must not wait for requests still timing out on the retired link.
    schedule:
      previous?.generation === generation - 1 ? previous.schedule : createCoalescedRefresh<void>(),
    generation,
  };
  refreshes.set(deviceId, refresh);
  try {
    await refresh.schedule(async () => {
      // A queued refresh must not reopen reads after disconnect or account change.
      if (!isDeviceProvidersGenerationCurrent(deviceId, generation)) return;
      await Promise.all([prefetchDeviceProviders(deviceId), prefetchDeviceCapabilities(deviceId)]);
    });
  } finally {
    if (refreshes.get(deviceId) === refresh) refreshes.delete(deviceId);
  }
}
