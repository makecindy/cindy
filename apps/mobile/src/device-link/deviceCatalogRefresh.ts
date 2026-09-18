import { PeerRecoveryScheduler } from './peerRecoveryScheduler';
import {
  fetchDeviceProviders, getDeviceProvidersGen, invalidateDeviceProvidersForRefresh,
  markDeviceFetchEpoch, type DeviceProvidersPayload,
} from './deviceProvidersCache';
import {
  commitAgentCapabilities, evictAgentCapabilitiesForDevice, fetchAgentCapabilities,
  getAgentCapabilitiesGeneration,
} from '@/session/agentCapabilitiesCache';
import { normalizeMobileAgentCapabilities } from '@/session/agentCapabilities';

/** Provider pushes are invalidations, not an instruction to start four more
 * parallel RPCs. Reuse peer recovery's serialized rerun and cancellation rules. */
export function createDeviceCatalogRefresh(options: {
  readProviders(deviceId: string): Promise<DeviceProvidersPayload>;
  readCapabilities(deviceId: string, agent: 'claude-code' | 'codex' | 'pi'): Promise<unknown>;
  connectionEpoch(): number;
}) {
  let disposed = false;
  const queued = new Map<string, ReturnType<typeof setTimeout>>();
  const devices = new Set<string>();
  const invalidate = (id: string) => {
    invalidateDeviceProvidersForRefresh(id);
    evictAgentCapabilitiesForDevice(id);
  };
  const scheduler = new PeerRecoveryScheduler(async (id) => {
    const epoch = options.connectionEpoch();
    const providerGeneration = getDeviceProvidersGen(id);
    const generation = getAgentCapabilitiesGeneration(id);
    const read = <T,>(fetcher: () => Promise<T>): Promise<T> => {
      if (disposed || getAgentCapabilitiesGeneration(id) !== generation) return Promise.reject(new Error('Catalog refresh superseded'));
      return fetcher();
    };
    await Promise.allSettled([
      fetchDeviceProviders(id, () => read(() => options.readProviders(id))).then(() => {
        if (!disposed && getDeviceProvidersGen(id) === providerGeneration) markDeviceFetchEpoch(id, epoch);
      }),
      ...(['claude-code', 'codex', 'pi'] as const).map(async (agent) => {
        const raw = await fetchAgentCapabilities(id, agent, () => read(() => options.readCapabilities(id, agent)));
        const normalized = normalizeMobileAgentCapabilities(raw);
        if (!disposed && normalized) commitAgentCapabilities(id, agent, generation, normalized);
      }),
    ]);
    // Failures use the existing picker/reconnect recovery, not another retry loop.
    return { retry: false };
  });
  return {
    notify(id: string) {
      if (disposed) return;
      devices.add(id);
      invalidate(id); // Immediately fence responses already on the wire.
      if (queued.has(id)) return;
      // Separate socket callbacks from the same burst need a bounded batching
      // window, not just a microtask. Further notifications never extend it.
      queued.set(id, setTimeout(() => {
        queued.delete(id);
        if (disposed) return;
        scheduler.request(id);
      }, 50));
    },
    cancel(id: string) {
      clearTimeout(queued.get(id));
      queued.delete(id);
      scheduler.cancel(id);
      if (devices.delete(id)) invalidate(id);
    },
    clear() {
      for (const timer of queued.values()) clearTimeout(timer);
      queued.clear();
      scheduler.clear();
      for (const id of devices) invalidate(id);
      devices.clear();
    },
    dispose() {
      disposed = true;
      for (const timer of queued.values()) clearTimeout(timer);
      queued.clear();
      scheduler.clear();
      for (const id of devices) invalidate(id);
      devices.clear();
    },
  };
}
