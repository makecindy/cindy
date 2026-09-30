/** Remote catalog invalidations use the same refresh scheduling as local reads.
 * Existing device generations remain the authority for disconnect/owner changes.
 */
import { createCoalescedRefresh } from '@/lib/coalescedRefresh';
import { evictDeviceCapabilities, prefetchDeviceCapabilities } from '@/hooks/useAgentCapabilities';
import {
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

export async function refreshRemoteCatalogSnapshot(deviceId: string): Promise<void> {
  const generation = evictDeviceProviders(deviceId);
  evictDeviceCapabilities(deviceId);
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
