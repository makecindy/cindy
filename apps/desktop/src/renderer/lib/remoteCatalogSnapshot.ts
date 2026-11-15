/** Remote catalog invalidations use the same refresh scheduling as local reads.
 * Existing device generations remain the authority for disconnect/owner changes.
 */
import { createCoalescedRefresh } from '@/lib/coalescedRefresh';
import { readProviderMetadataContinuity } from '@cindy/device-link';
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

export async function refreshRemoteCatalogSnapshot(deviceId: string, notification?: unknown,
  options?: { retireOnly?: boolean }): Promise<void> {
  // A Main-observed denial or an expired forwarded budget retires the mounted
  // copy without reopening the target. Callers pass retireOnly for that case;
  // a regular refresh still clears stale display copies before its live read.
  const retainDisplaySnapshot = !options?.retireOnly
    && readProviderMetadataContinuity(notification)?.remainingMs !== 0;
  const retireOnly = options?.retireOnly === true;
  const generation = evictDeviceProviders(deviceId, { retainDisplaySnapshot });
  evictDeviceCapabilities(deviceId, { retainDisplaySnapshot });
  if (retireOnly) {
    // Invalidate any queued refresh for this exact target. Its callback still
    // checks the device generation, and deleting the entry prevents it from
    // being reused by a later read. Do not schedule a replacement read here.
    refreshes.delete(deviceId);
    return;
  }
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
