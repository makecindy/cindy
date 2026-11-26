import { useEffect, useMemo, useSyncExternalStore } from 'react';
import {
  REMOTE_CATALOG_FRESH_MS,
  isProviderAccessDeniedError,
  isSharedTaskPeer,
  readProviderMetadataContinuity,
} from '@cindy/device-link';
import { withTransientRemoteRetry } from '@cindy/maker-shared/device-link-contract';
import {
  CONTROLLED_MODEL_CATALOG_CHANNEL,
  CONTROLLED_MODEL_CATALOG_CHANGED,
  modelCatalogKey,
  parseModelCatalogKey,
  readControlledFavoriteSource,
  readReceivedCatalogChangeSequence,
  type ControlledModelLocation,
} from '../../shared/controlledModelCatalog';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
  type DataOwnerGeneration,
} from '@/contexts/dataOwnerGeneration';
import { extractIpcError } from '@/utils/ipcError';
import { evictDeviceProviders, getRoutedProviderGeneration } from './useDeviceProviders';
import { evictDeviceCapabilities } from './useAgentCapabilities';
import {
  evictControlledPluginEngines,
  evictRemotePluginEngines,
  refreshControlledPluginEngines,
} from './usePluginEngines';
import { refreshControlledAvailableAgents } from './useAvailableAgents';
import { isProviderShareAgentDeviceId } from '../../shared/providerShare';
import { invalidateControlledCatalogRoutes, refreshDiscoveredCatalogRoutes } from '@/lib/remoteCatalogSnapshot';

const EMPTY_LOCATIONS: ControlledModelLocation[] = [];

type DeviceLinkApi = NonNullable<NonNullable<typeof window.electronAPI>['deviceLink']>;

function sameLocations(
  a: readonly ControlledModelLocation[] | undefined,
  b: readonly ControlledModelLocation[] | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i];
    const right = b[i];
    if (left.agentDeviceId !== right.agentDeviceId || left.name !== right.name) return false;
    const lf = left.favoriteSource;
    const rf = right.favoriteSource;
    if (lf === rf) continue;
    if (
      !lf
      || !rf
      || lf.shareId !== rf.shareId
      || lf.memberId !== rf.memberId
      || lf.providerId !== rf.providerId
      || lf.owner.region !== rf.owner.region
    ) {
      return false;
    }
  }
  return true;
}

function isTerminalLocationsError(error: unknown): boolean {
  return isProviderAccessDeniedError(error) || extractIpcError(error)?.code === 'PRECONDITION_FAILED';
}

function evictRouteKey(route: string): void {
  evictDeviceProviders(route);
  evictDeviceCapabilities(route);
  evictRemotePluginEngines(route);
}

interface ControlledLocationsEntry {
  readonly deviceId: string;
  readonly owner: DataOwnerGeneration;
  readonly link: DeviceLinkApi;
  routedGen: number;
  subscribe(listener: () => void): () => void;
  addSelfDeviceId(selfDeviceId: string | null | undefined): () => void;
  snapshot(): ControlledModelLocation[] | undefined;
  dispose(): void;
}

let entriesByOwner = new WeakMap<DataOwnerGeneration, Map<string, ControlledLocationsEntry>>();

function createEntry(
  owner: DataOwnerGeneration,
  deviceId: string,
  link: DeviceLinkApi,
): ControlledLocationsEntry {
  let revision = 0;
  let pending = false;
  let queuedMode: 'revalidate' | 'reload' | null = null;
  let available = true;
  let supported = false;
  let hasResolved = false;
  let detached = false;
  let lastConfirmedAt = 0;
  let completeLocations: ControlledModelLocation[] = [];
  let sourceIds = new Set<string>();
  const presenceStates = new Map<string, string>();
  let recoveredCatalogs: ReadonlySet<string> | undefined;
  let current: ControlledModelLocation[] | undefined = EMPTY_LOCATIONS;
  const subscribers = new Set<() => void>();
  const selfDeviceIds = new Map<string, number>();
  let detachListeners: (() => void) | null = null;

  const notify = (): void => {
    for (const listener of subscribers) listener();
  };

  const setCurrent = (next: ControlledModelLocation[] | undefined): void => {
    if (sameLocations(current, next)) return;
    current = next;
    notify();
  };

  const resetLocalState = (): void => {
    revision += 1;
    pending = false;
    queuedMode = null;
    available = true;
    supported = false;
    hasResolved = false;
    detached = false;
    lastConfirmedAt = 0;
    completeLocations = [];
    sourceIds = new Set();
    presenceStates.clear();
    recoveredCatalogs = undefined;
    current = EMPTY_LOCATIONS;
  };

  const invalidate = (catalogChanged: boolean, receivedChangeSequence?: number): void => {
    revision += 1;
    recoveredCatalogs = invalidateControlledCatalogRoutes(deviceId, catalogChanged, receivedChangeSequence);
    evictControlledPluginEngines(deviceId);
    refreshControlledAvailableAgents(deviceId);
    if (current !== undefined) setCurrent(EMPTY_LOCATIONS);
  };

  const refresh = async (destructive: boolean): Promise<void> => {
    if (subscribers.size === 0 || pending || !available || !isDataOwnerGenerationCurrent(owner)) return;
    pending = true;
    const request = ++revision;
    const isCurrent = (): boolean =>
      subscribers.size > 0 && request === revision && isDataOwnerGenerationCurrent(owner);
    try {
      // A failed push refresh otherwise leaves this menu empty until another
      // event. Use bounded read retries, not a per-hook polling/reconnect loop.
      // Recheck the owner and revision before every attempt: a queued newer
      // refresh, disconnect or unmount must retire the old read intent.
      const raw = await withTransientRemoteRetry(
        () => (isCurrent() && available
          ? link.invoke(deviceId, CONTROLLED_MODEL_CATALOG_CHANNEL, [{ op: 'locations' }])
          : Promise.resolve(undefined)),
        { maxAttempts: 3 },
      );
      if (!isCurrent()) return;
      const value = raw as { status?: unknown; locations?: unknown } | null;
      if (!value || !Array.isArray(value.locations)) throw new Error('Invalid model locations');
      let locations = value.locations
        .filter((entry): entry is ControlledModelLocation =>
          !!entry
          && typeof entry === 'object'
          && typeof entry.agentDeviceId === 'string'
          && entry.agentDeviceId.length > 0
          && typeof entry.name === 'string')
        .map((entry) => {
          const favoriteSource = readControlledFavoriteSource(entry.favoriteSource, entry.agentDeviceId);
          return {
            agentDeviceId: entry.agentDeviceId,
            name: entry.name,
            ...(favoriteSource ? { favoriteSource } : {}),
          };
        });
      const degraded = value.status === 'degraded';
      if (degraded) {
        // Only device discovery failed. Shares in this response remain authoritative.
        // Retain display names, never cached authorization or models; host reads still
        // require a current location before and after forwarding the request.
        locations = [
          ...completeLocations.filter(
            (location) =>
              !isProviderShareAgentDeviceId(location.agentDeviceId)
              && !locations.some((item) => item.agentDeviceId === location.agentDeviceId),
          ),
          ...locations,
        ];
      } else {
        completeLocations = locations;
      }
      const nextSourceIds = new Set(locations.map((location) => location.agentDeviceId));
      // During non-destructive revalidation (focus / remount / neighbor presence),
      // immediately retire any source that disappeared from the authoritative response
      // while preserving cached catalogs for every healthy remaining source.
      if (!destructive && hasResolved) {
        for (const previousId of sourceIds) {
          if (nextSourceIds.has(previousId)) continue;
          if (degraded && !isProviderShareAgentDeviceId(previousId)) continue;
          const route = modelCatalogKey(previousId, deviceId);
          if (route) evictRouteKey(route);
        }
      }
      supported = true;
      hasResolved = true;
      lastConfirmedAt = Date.now();
      entry.routedGen = getRoutedProviderGeneration(deviceId);
      sourceIds = nextSourceIds;
      setCurrent(locations);
      if (destructive || recoveredCatalogs !== undefined) {
        refreshDiscoveredCatalogRoutes(deviceId, recoveredCatalogs);
        recoveredCatalogs = undefined;
      }
      refreshControlledPluginEngines(deviceId, sourceIds);
    } catch (error) {
      if (!isCurrent()) return;
      const code = extractIpcError(error)?.code;
      // Old hosts keep their existing direct-read behavior. Network failures do
      // not switch a previously supported host back to the controller's grants.
      if (
        !supported
        && (code === 'DEVICE_LINK_CHANNEL_NOT_ALLOWED'
          || code === 'NOT_FOUND'
          || code === 'UNSUPPORTED_CAPABILITY')
      ) {
        hasResolved = true;
        setCurrent(undefined);
      } else if (supported && (destructive || isTerminalLocationsError(error))) {
        if (!destructive) invalidate(false);
        else setCurrent(EMPTY_LOCATIONS);
      }
    } finally {
      pending = false;
      if (queuedMode !== null && subscribers.size > 0) {
        const nextDestructive = queuedMode === 'reload';
        queuedMode = null;
        void refresh(nextDestructive);
      }
    }
  };

  const revalidate = (): void => {
    if (pending) {
      if (queuedMode !== 'reload') queuedMode = 'revalidate';
      return;
    }
    void refresh(false);
  };

  const reload = (catalogChanged = false, receivedChangeSequence?: number): void => {
    invalidate(catalogChanged, receivedChangeSequence);
    if (pending) {
      queuedMode = 'reload';
      return;
    }
    void refresh(true);
  };

  const attachListeners = (): void => {
    if (detachListeners) return;
    const offStatus = link.onStatusChanged?.(({ status, directDataDeviceIds }) => {
      const nextAvailable = status === 'online' || directDataDeviceIds?.includes(deviceId) === true;
      if (available === nextAvailable) return;
      available = nextAvailable;
      reload();
    });
    const offPresence = link.onPresenceChanged?.((presence) => {
      const signature = `${presence.online}:${presence.remoteControlEnabled}`;
      if (presenceStates.get(presence.deviceId) === signature) return;
      presenceStates.set(presence.deviceId, signature);
      if (presence.deviceId === deviceId) {
        available = presence.online && presence.remoteControlEnabled;
        reload();
        return;
      }
      if (!available) return;
      if (sourceIds.has(presence.deviceId)) {
        if (!presence.online || !presence.remoteControlEnabled) {
          const route = modelCatalogKey(presence.deviceId, deviceId);
          if (route) evictRouteKey(route);
        }
        revalidate();
      } else if (presence.online && presence.remoteControlEnabled) {
        revalidate();
      }
    });
    const offReset = link.onPeerLinkReset?.((event) => {
      if (event.deviceId === deviceId) {
        reload();
      } else if (sourceIds.has(event.deviceId)) {
        const route = modelCatalogKey(event.deviceId, deviceId);
        if (route) evictRouteKey(route);
        revalidate();
      }
    });
    const offControl = link.onControlTargetChanged?.((event) => {
      if (event.deviceId === deviceId) {
        available = event.enabled;
        reload();
      }
    });
    const offPush = link.onRemotePush?.((event) => {
      if (readProviderMetadataContinuity(event.payload)?.remainingMs === 0) {
        // A definitive denial/expiry is terminal for this metadata source.
        // Retire only the affected direct key or routed alias; never reload the
        // host, reopen the denied target or clear its healthy neighbors.
        if (event.deviceId === deviceId) {
          evictDeviceProviders(deviceId, { directOnly: true });
          evictDeviceCapabilities(deviceId, { directOnly: true });
        } else if (parseModelCatalogKey(event.deviceId)?.taskDeviceId === deviceId) {
          evictRouteKey(event.deviceId);
        } else if (sourceIds.has(event.deviceId)) {
          const route = modelCatalogKey(event.deviceId, deviceId);
          if (route) evictRouteKey(route);
        }
        return;
      }
      if (event.deviceId === deviceId && event.channel === CONTROLLED_MODEL_CATALOG_CHANGED) {
        reload(true, readReceivedCatalogChangeSequence(event.payload));
      } else if (
        (event.channel === 'maker:provider:changed' || event.channel === 'maker:agents:changed')
        && (event.deviceId === deviceId || sourceIds.has(event.deviceId))
      ) {
        reload(true);
      }
    });
    // A does not receive its own broadcasts through B. Its local notifications
    // must also refresh catalogs routed through B, without using A's local grants.
    const reloadLocalSource = (): void => {
      if (!isDataOwnerGenerationCurrent(owner) || selfDeviceIds.size === 0) return;
      if (!supported || [...selfDeviceIds.keys()].some((id) => sourceIds.has(id))) reload(true);
    };
    const offProviders = window.electronAPI?.maker?.onProvidersChanged?.(reloadLocalSource);
    const offAgents = window.electronAPI?.maker?.onAgentsChanged?.(reloadLocalSource);
    const revalidateOnFocus = (): void => {
      if (!available || !isDataOwnerGenerationCurrent(owner)) return;
      // Keep healthy cached locations and routed catalogs across focus transitions;
      // revalidate quietly after the shared freshness window to retire removed sources.
      if (hasResolved && lastConfirmedAt > 0 && Date.now() - lastConfirmedAt < REMOTE_CATALOG_FRESH_MS) return;
      revalidate();
    };
    window.addEventListener('focus', revalidateOnFocus);
    detachListeners = () => {
      offStatus?.();
      offPresence?.();
      offReset?.();
      offControl?.();
      offPush?.();
      offProviders?.();
      offAgents?.();
      window.removeEventListener('focus', revalidateOnFocus);
      detachListeners = null;
    };
  };

  const entry: ControlledLocationsEntry = {
    deviceId,
    owner,
    link,
    routedGen: getRoutedProviderGeneration(deviceId),
    subscribe(listener) {
      const wasEmpty = subscribers.size === 0;
      subscribers.add(listener);
      if (wasEmpty) {
        const currentRoutedGen = getRoutedProviderGeneration(deviceId);
        if (entry.routedGen !== currentRoutedGen) {
          resetLocalState();
          entry.routedGen = currentRoutedGen;
        }
        attachListeners();
        if (!hasResolved) {
          void refresh(false);
        } else if (detached) {
          detached = false;
          // Listeners were detached while unused, so a catalog push could have
          // arrived in the meantime; revalidate quietly while showing the cache.
          revalidate();
        }
      }
      return () => {
        subscribers.delete(listener);
        if (subscribers.size === 0) {
          revision += 1;
          queuedMode = null;
          detached = true;
          detachListeners?.();
        }
      };
    },
    addSelfDeviceId(selfDeviceId) {
      if (!selfDeviceId) return () => {};
      selfDeviceIds.set(selfDeviceId, (selfDeviceIds.get(selfDeviceId) ?? 0) + 1);
      return () => {
        const remaining = (selfDeviceIds.get(selfDeviceId) ?? 1) - 1;
        if (remaining <= 0) selfDeviceIds.delete(selfDeviceId);
        else selfDeviceIds.set(selfDeviceId, remaining);
      };
    },
    snapshot() {
      if (!isDataOwnerGenerationCurrent(owner)) return EMPTY_LOCATIONS;
      if (entry.routedGen !== getRoutedProviderGeneration(deviceId)) return EMPTY_LOCATIONS;
      return current;
    },
    dispose() {
      subscribers.clear();
      selfDeviceIds.clear();
      detachListeners?.();
      resetLocalState();
    },
  };
  return entry;
}

function getOrCreateEntry(
  owner: DataOwnerGeneration,
  deviceId: string,
  link: DeviceLinkApi,
): ControlledLocationsEntry {
  let byDevice = entriesByOwner.get(owner);
  if (!byDevice) {
    byDevice = new Map();
    entriesByOwner.set(owner, byDevice);
  }
  const existing = byDevice.get(deviceId);
  const routedGen = getRoutedProviderGeneration(deviceId);
  if (existing && existing.link === link && existing.routedGen === routedGen) {
    return existing;
  }
  existing?.dispose();
  const next = createEntry(owner, deviceId, link);
  byDevice.set(deviceId, next);
  return next;
}

function subscribeDisabled(): () => void {
  return () => {};
}

function unavailableSnapshot(): undefined {
  return undefined;
}

/** Test seam: clear module-level location cache and detach any remaining listeners. */
export function resetControlledModelLocationsForTests(): void {
  const currentOwner = getDataOwnerGeneration();
  const map = entriesByOwner.get(currentOwner);
  if (map) {
    for (const entry of map.values()) entry.dispose();
  }
  entriesByOwner = new WeakMap();
}

/** The task host discovers sources; no intersection with the controller's shares/devices. */
export function useControlledModelLocations(
  deviceId: string | null | undefined,
  selfDeviceId?: string | null,
): ControlledModelLocation[] | undefined {
  const owner = getDataOwnerGeneration();
  const link = window.electronAPI?.deviceLink;
  const enabled = !!deviceId && !isSharedTaskPeer(deviceId) && !!link;
  const entry = useMemo(
    () => (enabled ? getOrCreateEntry(owner, deviceId, link) : null),
    [enabled, owner, deviceId, link],
  );
  useEffect(() => {
    if (!entry || !selfDeviceId) return undefined;
    return entry.addSelfDeviceId(selfDeviceId);
  }, [entry, selfDeviceId]);
  // Until discovery completes, retain the saved source instead of temporarily
  // calibrating its model against B's local catalog. Only proven old hosts fall back.
  return useSyncExternalStore(
    entry?.subscribe ?? subscribeDisabled,
    entry?.snapshot ?? unavailableSnapshot,
    unavailableSnapshot,
  );
}
