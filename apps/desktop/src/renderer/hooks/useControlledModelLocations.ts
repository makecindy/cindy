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
import {
  evictDeviceProviders,
  getCachedControlledDeviceProviderTargets,
  getRoutedProviderGeneration,
  subscribeRoutedProviderInvalidation,
} from './useDeviceProviders';
import {
  evictDeviceCapabilities,
  getCachedControlledDeviceCapabilityTargets,
} from './useAgentCapabilities';
import {
  evictControlledPluginEngines,
  evictRemotePluginEngines,
  refreshControlledPluginEngines,
} from './usePluginEngines';
import { refreshControlledAvailableAgents } from './useAvailableAgents';
import { isProviderShareAgentDeviceId } from '../../shared/providerShare';
import {
  invalidateControlledCatalogRoutes,
  refreshDiscoveredCatalogRoutes,
  refreshRemoteCatalogSnapshot,
} from '@/lib/remoteCatalogSnapshot';

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

interface RefreshRequest {
  destructive: boolean;
  /** Revalidate already-cached routed catalogs that could have changed while detached. */
  refreshCachedRoutes: 'none' | 'self-only' | 'all';
}

function mergeRefreshRequest(existing: RefreshRequest | null, next: RefreshRequest): RefreshRequest {
  if (!existing) return next;
  const destructive = existing.destructive || next.destructive;
  const rank = (mode: RefreshRequest['refreshCachedRoutes']): number =>
    mode === 'all' ? 2 : mode === 'self-only' ? 1 : 0;
  const refreshCachedRoutes = rank(existing.refreshCachedRoutes) >= rank(next.refreshCachedRoutes)
    ? existing.refreshCachedRoutes
    : next.refreshCachedRoutes;
  return { destructive, refreshCachedRoutes };
}

interface ControlledLocationsEntry {
  readonly deviceId: string;
  readonly owner: DataOwnerGeneration;
  readonly link: DeviceLinkApi;
  routedGen: number;
  hasSubscribers(): boolean;
  subscribe(listener: () => void): () => void;
  addSelfDeviceId(selfDeviceId: string | null | undefined): () => void;
  snapshot(): ControlledModelLocation[] | undefined;
  dispose(): void;
}

let entriesByOwner = new WeakMap<DataOwnerGeneration, Map<string, ControlledLocationsEntry>>();
let globalCatalogPushWatchers = 0;

/**
 * Called by the app-wide device-link remote-push subscriber (`useDeviceLinkRemoteProjects`)
 * so detached location entries know whether `CONTROLLED_MODEL_CATALOG_CHANGED` pushes are
 * continuously observed while no model picker / draft route is mounted.
 */
export function registerControlledCatalogPushWatcher(): () => void {
  globalCatalogPushWatchers += 1;
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    globalCatalogPushWatchers = Math.max(0, globalCatalogPushWatchers - 1);
  };
}

/**
 * Invalidate cached routed catalogs and detached locations when `CONTROLLED_MODEL_CATALOG_CHANGED`
 * arrives while no `useControlledModelLocations` consumer is mounted for `deviceId`.
 * Mounted entries handle the same push directly through their own listener.
 */
export function invalidateDetachedControlledModelLocations(
  deviceId: string,
  receivedChangeSequence?: number,
): void {
  const owner = getDataOwnerGeneration();
  const byDevice = entriesByOwner.get(owner);
  const existing = byDevice?.get(deviceId);
  if (existing?.hasSubscribers()) return;
  invalidateControlledCatalogRoutes(deviceId, true, receivedChangeSequence);
  evictControlledPluginEngines(deviceId);
  refreshControlledAvailableAgents(deviceId);
  if (existing) {
    existing.dispose();
    byDevice?.delete(deviceId);
  }
}

function createEntry(
  owner: DataOwnerGeneration,
  deviceId: string,
  link: DeviceLinkApi,
): ControlledLocationsEntry {
  let revision = 0;
  let activeRequest: number | null = null;
  let queuedRequest: RefreshRequest | null = null;
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
    activeRequest = null;
    queuedRequest = null;
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

  const refresh = async (mode: RefreshRequest): Promise<void> => {
    const { destructive, refreshCachedRoutes } = mode;
    if (subscribers.size === 0 || activeRequest !== null || !available || !isDataOwnerGenerationCurrent(owner)) return;
    const request = ++revision;
    activeRequest = request;
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
      } else if (refreshCachedRoutes !== 'none') {
        // If catalog pushes could have been missed while detached (e.g. without a
        // global remote-push watcher, or for local self-device sources), refresh
        // already-cached routes in the background while retaining their display copies.
        const cachedRoutes = new Set([
          ...getCachedControlledDeviceProviderTargets(deviceId),
          ...getCachedControlledDeviceCapabilityTargets(deviceId),
        ]);
        for (const route of cachedRoutes) {
          const parsed = parseModelCatalogKey(route);
          if (!parsed || !nextSourceIds.has(parsed.agentDeviceId)) continue;
          if (refreshCachedRoutes === 'self-only' && !selfDeviceIds.has(parsed.agentDeviceId)) continue;
          void refreshRemoteCatalogSnapshot(route);
        }
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
      if (activeRequest === request) {
        activeRequest = null;
        if (queuedRequest !== null && subscribers.size > 0) {
          const next = queuedRequest;
          queuedRequest = null;
          void refresh(next);
        }
      }
    }
  };

  const revalidate = (refreshCachedRoutes: RefreshRequest['refreshCachedRoutes'] = 'none'): void => {
    const next: RefreshRequest = { destructive: false, refreshCachedRoutes };
    if (activeRequest !== null) {
      queuedRequest = mergeRefreshRequest(queuedRequest, next);
      return;
    }
    void refresh(next);
  };

  const reload = (catalogChanged = false, receivedChangeSequence?: number): void => {
    invalidate(catalogChanged, receivedChangeSequence);
    const next: RefreshRequest = { destructive: true, refreshCachedRoutes: 'none' };
    if (activeRequest !== null) {
      queuedRequest = mergeRefreshRequest(queuedRequest, next);
      return;
    }
    void refresh(next);
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
    // Stay synchronized when another path (e.g. PROVIDER_GROUP_IPC.CHANGED via
    // refreshRemoteCatalogSnapshot, disconnect, or account eviction) advances the
    // host's routed provider generation while this entry is mounted.
    const offRoutedInvalidation = subscribeRoutedProviderInvalidation((invalidatedDeviceId, options) => {
      if (!isDataOwnerGenerationCurrent(owner)) return;
      if (invalidatedDeviceId === null) {
        entry.routedGen = getRoutedProviderGeneration(deviceId);
        resetLocalState();
        notify();
        return;
      }
      if (invalidatedDeviceId !== deviceId) return;
      entry.routedGen = getRoutedProviderGeneration(deviceId);
      if (options?.retainDisplaySnapshot) {
        // A retained host refresh (e.g. PROVIDER_GROUP_IPC.CHANGED) must keep
        // the location list visible and recover quietly rather than blanking it.
        if (activeRequest === null) revalidate();
        return;
      }
      // Disconnect / revoke / disable eviction clears cached locations until the host returns.
      revision += 1;
      queuedRequest = null;
      hasResolved = false;
      lastConfirmedAt = 0;
      completeLocations = [];
      sourceIds = new Set();
      setCurrent(EMPTY_LOCATIONS);
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
      offRoutedInvalidation();
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
    hasSubscribers() {
      return subscribers.size > 0;
    },
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
        const returningAfterDetach = detached && hasResolved;
        detached = false;
        if (!hasResolved) {
          // Route through revalidate() so a quick remount while the prior initial
          // read is still settling queues a replacement read instead of dropping it.
          revalidate();
        } else if (returningAfterDetach) {
          // Listeners were detached while unused; revalidate locations quietly and
          // refresh any cached routes that could have missed pushes while away.
          revalidate(globalCatalogPushWatchers > 0 ? 'self-only' : 'all');
        }
      }
      return () => {
        subscribers.delete(listener);
        if (subscribers.size === 0) {
          revision += 1;
          queuedRequest = null;
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
  globalCatalogPushWatchers = 0;
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
