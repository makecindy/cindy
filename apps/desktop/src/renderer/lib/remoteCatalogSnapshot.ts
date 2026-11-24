/** Remote catalog invalidations use the same refresh scheduling as local reads.
 * Existing device generations remain the authority for disconnect/owner changes.
 */
import { createCoalescedRefresh } from '@/lib/coalescedRefresh';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { readProviderMetadataContinuity } from '@cindy/device-link';
import {
  evictAllRemoteCapabilities,
  evictControlledDeviceCapabilities,
  evictDeviceCapabilities,
  getDeviceCapabilitiesGeneration,
  getInterestedDeviceCapabilityTargets,
  getMountedControlledDeviceCapabilityTargets,
  getRoutedCapabilityGeneration,
  prefetchDeviceCapabilities,
} from '@/hooks/useAgentCapabilities';
import {
  evictAllDeviceProviders,
  evictControlledDeviceProviders,
  evictDeviceProviders,
  getDeviceProvidersGeneration,
  getInterestedDeviceProviderTargets,
  getMountedControlledDeviceProviderTargets,
  getRoutedProviderGeneration,
  isDeviceProvidersGenerationCurrent,
  prefetchDeviceProviders,
} from '@/hooks/useDeviceProviders';
import { parseModelCatalogKey } from '../../shared/controlledModelCatalog';

const refreshes = new Map<
  string,
  {
    schedule: ReturnType<typeof createCoalescedRefresh<void>>;
    generation: number;
    capabilitiesGeneration: number;
    needsRead: boolean;
    endpointsAreCurrent: () => boolean;
  }
>();

const shareCatalogRetries = new Map<string, Promise<void>>();
const shareCatalogRecoverySequences = new Map<string, number>();

export function wasShareCatalogRecovered(deviceId: string, receivedChangeSequence: number): boolean {
  return shareCatalogRecoverySequences.get(deviceId) === receivedChangeSequence;
}

export function retryProviderShareCatalog(deviceId: string): Promise<void> {
  const pending = shareCatalogRetries.get(deviceId);
  if (pending) return pending;
  const owner = getDataOwnerGeneration();
  const generation = getDeviceProvidersGeneration(deviceId);
  const retry = (async () => {
    const result = await window.electronAPI?.providerShare?.command({ action: 'retry-model-catalog', agentDeviceId: deviceId });
    // A push or eviction during the directory refresh owns the newer catalog.
    if (isDataOwnerGenerationCurrent(owner) && isDeviceProvidersGenerationCurrent(deviceId, generation)) {
      const refresh = refreshRemoteCatalogSnapshot(deviceId);
      // The matching received snapshot may arrive after this catalog read finishes.
      if (result?.receivedChangeSequence !== undefined) {
        shareCatalogRecoverySequences.set(deviceId, result.receivedChangeSequence);
      }
      await refresh;
    }
  })().finally(() => {
    if (shareCatalogRetries.get(deviceId) === retry) shareCatalogRetries.delete(deviceId);
  });
  shareCatalogRetries.set(deviceId, retry);
  return retry;
}

function captureRouteEndpoints(deviceId: string): () => boolean {
  const route = parseModelCatalogKey(deviceId);
  const endpoints = route ? [route.taskDeviceId, route.agentDeviceId].map(key => ({
    key,
    providers: getRoutedProviderGeneration(key),
    capabilities: getRoutedCapabilityGeneration(key),
  })) : [];
  // A detached route can disappear from the caches while its refresh is still queued.
  // Direct-only eviction must leave the forwarded read alive.
  return () => endpoints.every(({ key, providers, capabilities }) =>
    getRoutedProviderGeneration(key) === providers
    && getRoutedCapabilityGeneration(key) === capabilities);
}

function getCurrentRefresh(deviceId: string) {
  const refresh = refreshes.get(deviceId);
  return refresh && isDeviceProvidersGenerationCurrent(deviceId, refresh.generation)
    && getDeviceCapabilitiesGeneration(deviceId) === refresh.capabilitiesGeneration
    && refresh.endpointsAreCurrent() ? refresh : undefined;
}

async function scheduleRefresh(
  deviceId: string,
  generation: number,
  capabilitiesGeneration: number,
  schedule: ReturnType<typeof createCoalescedRefresh<void>>,
  read: () => Promise<unknown>,
): Promise<void> {
  const endpointsAreCurrent = captureRouteEndpoints(deviceId);
  const refresh = { schedule, generation, capabilitiesGeneration, needsRead: false, endpointsAreCurrent };
  refreshes.set(deviceId, refresh);
  try {
    await schedule(async () => {
      // A queued refresh must not reopen reads after disconnect or account change.
      if (!isDeviceProvidersGenerationCurrent(deviceId, generation)
        || getDeviceCapabilitiesGeneration(deviceId) !== capabilitiesGeneration
        || !endpointsAreCurrent() || refreshes.get(deviceId)?.schedule !== schedule) return;
      await read();
    });
  } finally {
    if (refreshes.get(deviceId) === refresh) refreshes.delete(deviceId);
  }
}

/** A catalog notification invalidates display data while locations are being rediscovered. */
export function invalidateControlledCatalogRoutes(taskDeviceId: string, catalogChanged: boolean): void {
  const affected = [...refreshes.keys()]
    .filter(key => parseModelCatalogKey(key)?.taskDeviceId === taskDeviceId)
    .map(key => ({ key, refresh: getCurrentRefresh(key) }));
  evictControlledDeviceProviders(taskDeviceId);
  evictControlledDeviceCapabilities(taskDeviceId);
  for (const { key, refresh } of affected) {
    if (!catalogChanged) {
      refreshes.delete(key);
      continue;
    }
    if (!refresh || refreshes.get(key) !== refresh) continue;
    // Preserve the active reader until discovery can schedule the replacement.
    refresh.generation = getDeviceProvidersGeneration(key);
    refresh.capabilitiesGeneration = getDeviceCapabilitiesGeneration(key);
    refresh.needsRead = true;
  }
}

export function refreshDiscoveredCatalogRoutes(taskDeviceId: string): void {
  const providers = new Set(getMountedControlledDeviceProviderTargets(taskDeviceId));
  const capabilities = new Set(getMountedControlledDeviceCapabilityTargets(taskDeviceId));
  for (const key of new Set([...providers, ...capabilities])) {
    const current = getCurrentRefresh(key);
    if (current && !current.needsRead) continue;
    void scheduleRefresh(
      key, getDeviceProvidersGeneration(key), getDeviceCapabilitiesGeneration(key),
      current?.schedule ?? createCoalescedRefresh<void>(),
      () => Promise.all([
        providers.has(key) && prefetchDeviceProviders(key),
        capabilities.has(key) && prefetchDeviceCapabilities(key),
      ]),
    );
  }
}

/** 分享 ID 跨账号相同；切换账号时不能复用目录，也不能接收旧账号的在途结果。 */
export function invalidateRemoteCatalogSnapshots(): void {
  evictAllDeviceProviders();
  evictAllRemoteCapabilities();
  refreshes.clear();
  shareCatalogRetries.clear();
  shareCatalogRecoverySequences.clear();
}

export async function refreshRemoteCatalogSnapshot(deviceId: string, notification?: unknown,
  options?: { retireOnly?: boolean }): Promise<void> {
  // A Main-observed denial or an expired forwarded budget retires the mounted
  // copy without reopening the target. Callers pass retireOnly for that case;
  // a regular refresh still clears stale display copies before its live read.
  const retainDisplaySnapshot = !options?.retireOnly
    && readProviderMetadataContinuity(notification)?.remainingMs !== 0;
  const retireOnly = options?.retireOnly === true;
  shareCatalogRecoverySequences.delete(deviceId);
  // Capture in-flight-only consumers before eviction removes their request keys.
  // The direct source and every affected task-host route retain separate caches
  // and refresh generations; never reopen aliases for a denial/retirement.
  const routedTargets = retireOnly ? [] : [...new Set([
    ...getInterestedDeviceProviderTargets(deviceId),
    ...getInterestedDeviceCapabilityTargets(deviceId),
  ])].filter(key => key !== deviceId).map(key => ({ key, previous: getCurrentRefresh(key) }));
  const previous = getCurrentRefresh(deviceId);
  const generation = evictDeviceProviders(deviceId, { retainDisplaySnapshot });
  evictDeviceCapabilities(deviceId, { retainDisplaySnapshot });
  if (retireOnly) {
    // Invalidate any queued refresh for this exact target. Its callback still
    // checks the device generation, and deleting the entry prevents it from
    // being reused by a later read. Do not schedule a replacement read here.
    refreshes.delete(deviceId);
    return;
  }
  const idleRoutes: Array<() => Promise<void>> = [];
  const activeRoutes: Promise<void>[] = [];
  for (const target of routedTargets) {
    const { key } = target;
    const providers = getDeviceProvidersGeneration(key);
    const capabilities = getDeviceCapabilitiesGeneration(key);
    const endpointsAreCurrent = captureRouteEndpoints(key);
    const read = () => Promise.all([prefetchDeviceProviders(key), prefetchDeviceCapabilities(key)]);
    if (target.previous) {
      // The cascade already evicted this route. Queue its trailing read now so
      // another source's active refresh cannot delay or duplicate it.
      activeRoutes.push(scheduleRefresh(key, providers, capabilities, target.previous.schedule, read));
    } else {
      idleRoutes.push(async () => {
        // The task host can be retired independently before its source reads.
        if (!isDeviceProvidersGenerationCurrent(key, providers)
          || getDeviceCapabilitiesGeneration(key) !== capabilities || !endpointsAreCurrent()) return;
        await scheduleRefresh(key, providers, capabilities, createCoalescedRefresh<void>(), read);
      });
    }
  }
  // An intervening eviction retires the old link. A new link starts its own
  // refresh without waiting for requests still timing out on the old link.
  const direct = scheduleRefresh(
    deviceId, generation, getDeviceCapabilitiesGeneration(deviceId),
    previous?.schedule ?? createCoalescedRefresh<void>(),
    () => Promise.all([
      prefetchDeviceProviders(deviceId), prefetchDeviceCapabilities(deviceId),
      ...idleRoutes.map(read => read()),
    ]),
  );
  await Promise.all([direct, ...activeRoutes]);
}
