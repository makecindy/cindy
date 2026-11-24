/**
 * usePluginEngines — task engines provided by plugins on this computer
 * (docs/plans/acp-plugin-bridge.md).
 *
 * One module-level store shared by every consumer (model picker, task view, sidebar rows):
 * the first subscriber reads the list once and listens to the main-process push, which always
 * carries the complete list. There is no polling and no per-row request; the last unsubscribe
 * drops the listener but keeps the last list so a remount renders it immediately.
 *
 * Device Link has a separate catalogue for each computer in the current account. Task pickers
 * read it on demand, and task rows reuse the result without making their own requests.
 */
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { isSharedTaskPeer } from '@cindy/device-link';
import { retainReportingPluginEngines } from './pluginEngineUsage';

import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
  type DataOwnerGeneration,
} from '@/contexts/dataOwnerGeneration';
import { createLogger } from '@/lib/logger';
import { invokeModelCatalog } from '@/lib/invokeModelCatalog';
import { extractIpcError } from '@/utils/ipcError';
import { parseModelCatalogKey } from '../../shared/controlledModelCatalog';
import {
  PLUGIN_ENGINES_INVOKE,
  pluginEngineKeyFromProviderId,
  type PluginEngineView,
} from '../../shared/pluginEngines';

const log = createLogger('usePluginEngines');

const NO_ENGINES: readonly PluginEngineView[] = Object.freeze([]);

interface PluginEnginesApi {
  listPluginEngines?: () => Promise<PluginEngineView[]>;
  refreshPluginEngines?: (targetGhostId?: string) => Promise<void>;
  onPluginEnginesChanged?: (cb: (engines: PluginEngineView[]) => void) => () => void;
}

function pluginEnginesApi(): PluginEnginesApi | null {
  return (window as unknown as { electronAPI?: { maker?: PluginEnginesApi } }).electronAPI?.maker ?? null;
}

/**
 * The model picker opened with plugin engines in it: ask their plugins to republish their models,
 * like the provider model refresh at the same moment. Main applies a per-plugin cooldown; new
 * models arrive through the change push. Fire-and-forget.
 */
export function requestPluginEnginesRefresh(targetGhostId?: string): void {
  void pluginEnginesApi()?.refreshPluginEngines?.(targetGhostId).catch((err: unknown) => log.warn('plugin engine refresh failed', err));
}

let engines: readonly PluginEngineView[] = NO_ENGINES;
const listeners = new Set<() => void>();
let detachPush: (() => void) | null = null;
/** Bumped by every push, so a slower initial read never overwrites a newer pushed list. */
let generation = 0;

function setEngines(next: readonly PluginEngineView[]): void {
  retainReportingPluginEngines(getDataOwnerGeneration(), null, next);
  engines = next.length === 0 ? NO_ENGINES : next;
  for (const listener of listeners) listener();
}

function sanitize(raw: unknown): readonly PluginEngineView[] {
  if (!Array.isArray(raw)) return NO_ENGINES;
  return raw.filter((engine): engine is PluginEngineView =>
    !!engine && typeof engine === 'object'
    && typeof (engine as PluginEngineView).providerId === 'string'
    && typeof (engine as PluginEngineView).name === 'string'
    && Array.isArray((engine as PluginEngineView).models));
}

function attach(): void {
  const api = pluginEnginesApi();
  if (!api?.listPluginEngines || !api.onPluginEnginesChanged) return;
  detachPush = api.onPluginEnginesChanged((list) => {
    generation += 1;
    setEngines(sanitize(list));
  });
  const readGeneration = generation;
  api.listPluginEngines()
    .then((list) => {
      if (readGeneration === generation) setEngines(sanitize(list));
    })
    .catch((err: unknown) => log.warn('plugin engines unavailable', err));
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1 && !detachPush) attach();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && detachPush) {
      detachPush();
      detachPush = null;
    }
  };
}

function subscribeDisabled(): () => void {
  return () => {};
}

function snapshot(): readonly PluginEngineView[] {
  return engines;
}

function emptySnapshot(): readonly PluginEngineView[] {
  return NO_ENGINES;
}

/** The engines this computer offers; empty when `enabled` is false or no plugin declares one. */
export function usePluginEngines(enabled = true): readonly PluginEngineView[] {
  return useSyncExternalStore(
    enabled ? subscribe : subscribeDisabled,
    enabled ? snapshot : emptySnapshot,
    emptySnapshot,
  );
}

interface DeviceCatalogue {
  read(): Promise<void>;
  ensureLoaded(): void;
  retainPicker(): () => void;
  refreshForPicker(): void;
  prefetch(): Promise<void>;
  markStale(): void;
  evict(): void;
  hasPrefetchSubscribers(): boolean;
  hasLoadedConsumers(): boolean;
  subscribe(listener: () => void, prefetchOnReconnect?: boolean): () => void;
  snapshot(): readonly PluginEngineView[] | null;
}

let deviceCatalogues = new WeakMap<DataOwnerGeneration, Map<string, DeviceCatalogue>>();
const activeRefreshTimers = new Set<ReturnType<typeof setTimeout>>();

/** Cooldown and follow-up read when a picker asks another computer's engine plugins to republish models. */
export const DEVICE_PLUGIN_ENGINES_REFRESH_MS = 60_000;
export const DEVICE_PLUGIN_ENGINES_REFRESH_REREAD_MS = 2_500;

function sameEngineViews(
  a: readonly PluginEngineView[] | null,
  b: readonly PluginEngineView[],
): boolean {
  if (a === null || a.length !== b.length) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function isUnsupportedRemoteListError(error: unknown, deviceId: string): boolean {
  const code = extractIpcError(error)?.code;
  if (code === 'DEVICE_LINK_CHANNEL_NOT_ALLOWED') return true;
  // A task computer that cannot read plugin engines for its sources yet refuses the read itself.
  if (code === 'INVALID_PARAMS' && parseModelCatalogKey(deviceId)) return true;
  const message = error instanceof Error ? error.message : String(error ?? '');
  return message.includes('CHANNEL_NOT_ALLOWED');
}

function existingDeviceCatalogue(owner: DataOwnerGeneration, deviceId: string): DeviceCatalogue | undefined {
  return deviceCatalogues.get(owner)?.get(deviceId);
}

function deviceCatalogue(owner: DataOwnerGeneration, deviceId: string): DeviceCatalogue {
  let devices = deviceCatalogues.get(owner);
  if (!devices) {
    devices = new Map();
    deviceCatalogues.set(owner, devices);
  }
  const known = devices.get(deviceId);
  if (known) return known;

  let current: readonly PluginEngineView[] | null = null;
  let pending: Promise<void> | undefined;
  let deviceGeneration = 0;
  let pickerUsers = 0;
  let pickerGeneration = 0;
  let lastReadAt = 0;
  let lastFailedAt = 0;
  let lastRefreshAt = 0;
  let refreshRereadDueAt = 0;
  let refreshRereadTimer: ReturnType<typeof setTimeout> | undefined;
  let unsupported = false;
  const clearRefreshTimer = () => {
    if (refreshRereadTimer === undefined) return;
    clearTimeout(refreshRereadTimer);
    activeRefreshTimers.delete(refreshRereadTimer);
    refreshRereadTimer = undefined;
  };
  const scheduleRefreshReread = () => {
    if (
      refreshRereadDueAt <= 0
      || pickerUsers === 0
      || unsupported
      || !isDataOwnerGenerationCurrent(owner)
    ) {
      return;
    }
    clearRefreshTimer();
    const remaining = refreshRereadDueAt - Date.now();
    if (remaining <= 0) {
      refreshRereadDueAt = 0;
      void catalogue.read();
      return;
    }
    const scheduledGeneration = deviceGeneration;
    const timer = setTimeout(() => {
      activeRefreshTimers.delete(timer);
      if (refreshRereadTimer === timer) refreshRereadTimer = undefined;
      if (
        !isDataOwnerGenerationCurrent(owner)
        || scheduledGeneration !== deviceGeneration
        || pickerUsers === 0
        || refreshRereadDueAt <= 0
      ) {
        return;
      }
      refreshRereadDueAt = 0;
      void catalogue.read();
    }, remaining);
    (timer as unknown as { unref?: () => void })?.unref?.();
    refreshRereadTimer = timer;
    activeRefreshTimers.add(timer);
  };
  const subscribers = new Map<() => void, boolean>();
  const catalogue: DeviceCatalogue = {
    read() {
      if (!isDataOwnerGenerationCurrent(owner) || isSharedTaskPeer(deviceId)) return Promise.resolve();
      if (pending) return pending;
      const readGeneration = deviceGeneration;
      const readStartedAt = Date.now();
      const link = window.electronAPI?.deviceLink;
      const run = Promise.resolve()
        .then(() => isDataOwnerGenerationCurrent(owner) && readGeneration === deviceGeneration && link
          // A source read through the task computer (remote control) is keyed by modelCatalogKey.
          ? invokeModelCatalog(link, deviceId, PLUGIN_ENGINES_INVOKE.LIST, [])
          : undefined)
        .then((reply) => {
          if (!isDataOwnerGenerationCurrent(owner) || readGeneration !== deviceGeneration || !Array.isArray(reply)) {
            return;
          }
          const next = sanitize(reply);
          lastReadAt = Date.now();
          lastFailedAt = 0;
          unsupported = false;
          if (refreshRereadDueAt > 0 && readStartedAt >= refreshRereadDueAt) {
            refreshRereadDueAt = 0;
            clearRefreshTimer();
          }
          retainReportingPluginEngines(owner, deviceId, next);
          if (sameEngineViews(current, next)) return;
          current = next;
          for (const subscriber of subscribers.keys()) subscriber();
        })
        // Old or unreachable hosts leave the catalogue unknown or retain their last result.
        .catch((error: unknown) => {
          if (!isDataOwnerGenerationCurrent(owner) || readGeneration !== deviceGeneration) return;
          if (isUnsupportedRemoteListError(error, deviceId)) unsupported = true;
          else lastFailedAt = Date.now();
        })
        .finally(() => {
          if (pending === run) pending = undefined;
        });
      pending = run;
      return run;
    },
    ensureLoaded() {
      if (!isDataOwnerGenerationCurrent(owner) || isSharedTaskPeer(deviceId)) return;
      // Once the full catalogue for this computer has been read (even if empty or missing an
      // uninstalled plugin), reuse it instead of re-downloading on scroll or additional rows.
      if (current !== null || pending || unsupported) return;
      if (lastFailedAt > 0 && Date.now() - lastFailedAt < DEVICE_PLUGIN_ENGINES_REREAD_MS) return;
      void catalogue.read();
    },
    retainPicker() {
      const becameActive = pickerUsers === 0;
      pickerUsers += 1;
      if (becameActive && refreshRereadDueAt > 0) {
        scheduleRefreshReread();
      }
      return () => {
        pickerUsers = Math.max(0, pickerUsers - 1);
        if (pickerUsers === 0) {
          pickerGeneration += 1;
          clearRefreshTimer();
        }
      };
    },
    refreshForPicker() {
      if (!isDataOwnerGenerationCurrent(owner) || isSharedTaskPeer(deviceId) || unsupported || pickerUsers === 0) {
        return;
      }
      const refreshGeneration = deviceGeneration;
      const activePickerGeneration = pickerGeneration;
      const isPickerActive = () =>
        isDataOwnerGenerationCurrent(owner)
        && refreshGeneration === deviceGeneration
        && pickerUsers > 0
        && activePickerGeneration === pickerGeneration;
      const now = Date.now();
      const owedRereadReady = refreshRereadDueAt > 0 && now >= refreshRereadDueAt;
      if (owedRereadReady) {
        refreshRereadDueAt = 0;
        clearRefreshTimer();
      }
      const freshEnough =
        !owedRereadReady
        && current !== null
        && lastReadAt > 0
        && now - lastReadAt < DEVICE_PLUGIN_ENGINES_REREAD_MS;
      const ensureCurrent = freshEnough ? Promise.resolve() : catalogue.read();
      void ensureCurrent.then(() => {
        if (!isPickerActive() || !(current?.length)) return;
        const afterRead = Date.now();
        if (lastRefreshAt > 0 && afterRead - lastRefreshAt < DEVICE_PLUGIN_ENGINES_REFRESH_MS) {
          if (refreshRereadDueAt > 0) scheduleRefreshReread();
          return;
        }
        const invoke = window.electronAPI?.deviceLink?.invoke;
        if (!invoke) return;
        lastRefreshAt = afterRead;
        clearRefreshTimer();
        void Promise.resolve(invoke(deviceId, PLUGIN_ENGINES_INVOKE.REFRESH, []))
          .then(() => {
            if (!isDataOwnerGenerationCurrent(owner) || refreshGeneration !== deviceGeneration) return;
            refreshRereadDueAt = Date.now() + DEVICE_PLUGIN_ENGINES_REFRESH_REREAD_MS;
            scheduleRefreshReread();
          })
          .catch(() => undefined);
      });
    },
    prefetch() {
      if (!isDataOwnerGenerationCurrent(owner) || isSharedTaskPeer(deviceId)) return Promise.resolve();
      if (pending) return pending;
      if (current !== null && lastReadAt > 0 && Date.now() - lastReadAt < DEVICE_PLUGIN_ENGINES_REREAD_MS) {
        return Promise.resolve();
      }
      lastFailedAt = 0;
      unsupported = false;
      return catalogue.read();
    },
    markStale() {
      clearRefreshTimer();
      pickerReadAt.delete(catalogue);
      refreshRereadDueAt = 0;
      lastReadAt = 0;
      lastFailedAt = 0;
      lastRefreshAt = 0;
      unsupported = false;
    },
    evict() {
      deviceGeneration += 1;
      pending = undefined;
      clearRefreshTimer();
      pickerReadAt.delete(catalogue);
      refreshRereadDueAt = 0;
      lastReadAt = 0;
      lastFailedAt = 0;
      lastRefreshAt = 0;
      unsupported = false;
      retainReportingPluginEngines(owner, deviceId, []);
      if (current !== null) {
        current = null;
        for (const subscriber of subscribers.keys()) subscriber();
      }
    },
    hasPrefetchSubscribers() {
      return Array.from(subscribers.values()).includes(true);
    },
    hasLoadedConsumers() {
      return catalogue.hasPrefetchSubscribers() || (subscribers.size > 0 && current !== null);
    },
    subscribe(listener, prefetchOnReconnect = true) {
      subscribers.set(listener, prefetchOnReconnect);
      return () => { subscribers.delete(listener); };
    },
    snapshot() {
      return isDataOwnerGenerationCurrent(owner) ? current : null;
    },
  };
  devices.set(deviceId, catalogue);
  return catalogue;
}

/** Whether mounted task UI needs this catalogue during device bootstrap/reconnect. */
export function hasRemotePluginEngineSubscribers(deviceId: string): boolean {
  return existingDeviceCatalogue(getDataOwnerGeneration(), deviceId)?.hasPrefetchSubscribers() ?? false;
}

/** Whether mounted UI (including an open picker that already loaded this catalogue) is consuming this device's engines. */
export function hasRemotePluginEngineInterest(deviceId: string): boolean {
  return existingDeviceCatalogue(getDataOwnerGeneration(), deviceId)?.hasLoadedConsumers() ?? false;
}

/** One coalesced background catalogue read for a remote computer (used on bootstrap/reconnect). */
export function prefetchRemotePluginEngines(deviceId: string): Promise<void> {
  if (!deviceId || isSharedTaskPeer(deviceId)) return Promise.resolve();
  return deviceCatalogue(getDataOwnerGeneration(), deviceId).prefetch();
}

/** Keep cached icons while a remote computer is transiently offline, but refresh on reconnect. */
export function markRemotePluginEnginesStale(deviceId: string): void {
  existingDeviceCatalogue(getDataOwnerGeneration(), deviceId)?.markStale();
}

/** Drop cached engines and discard in-flight reads when a computer is revoked, removed or disabled. */
export function evictRemotePluginEngines(deviceId: string): void {
  existingDeviceCatalogue(getDataOwnerGeneration(), deviceId)?.evict();
}

/** Drop data and in-flight reads routed through this task computer. */
export function evictControlledPluginEngines(taskDeviceId: string): void {
  const catalogues = deviceCatalogues.get(getDataOwnerGeneration());
  for (const [key, catalogue] of catalogues ?? []) {
    if (parseModelCatalogKey(key)?.taskDeviceId === taskDeviceId) catalogue.evict();
  }
}

/** Only active task headers reload after the host confirms which sources are still available. */
export function refreshControlledPluginEngines(taskDeviceId: string, sourceIds: ReadonlySet<string>): void {
  const catalogues = deviceCatalogues.get(getDataOwnerGeneration());
  for (const [key, catalogue] of catalogues ?? []) {
    const route = parseModelCatalogKey(key);
    if (route?.taskDeviceId === taskDeviceId && sourceIds.has(route.agentDeviceId)
      && catalogue.hasPrefetchSubscribers()) catalogue.ensureLoaded();
  }
}

function unreadSnapshot(): null {
  return null;
}

/** Reads on entry/reconnect when requested. `'once'` reuses an existing catalogue; `refresh` asks plugins to republish models. */
export function useRemotePluginEngines(
  deviceId?: string,
  readOnEntry: boolean | 'once' = false,
  active = true,
): {
  engines: readonly PluginEngineView[] | null;
  read: () => void;
  refresh: () => void;
} {
  const owner = getDataOwnerGeneration();
  const catalogue = useMemo(() => deviceId ? deviceCatalogue(owner, deviceId) : null, [owner, deviceId]);
  const read = useCallback(() => { void catalogue?.read(); }, [catalogue]);
  const refresh = useCallback(() => { catalogue?.refreshForPicker(); }, [catalogue]);
  useEffect(() => (catalogue && active ? catalogue.retainPicker() : undefined), [catalogue, active]);
  useEffect(() => {
    if (!active) return;
    if (readOnEntry === true) read();
    else if (readOnEntry === 'once') catalogue?.ensureLoaded();
  }, [active, readOnEntry, read, catalogue]);
  const remoteEngines = useSyncExternalStore(
    catalogue?.subscribe ?? subscribeDisabled,
    catalogue?.snapshot ?? unreadSnapshot,
    unreadSnapshot,
  );
  return { engines: remoteEngines, read, refresh };
}

/**
 * A picker that lists other computers' engines asks each of them when it opens. Opening it again
 * right away reuses the answer instead of asking every computer once more.
 */
export const DEVICE_PLUGIN_ENGINES_REREAD_MS = 15_000;
const pickerReadAt = new WeakMap<DeviceCatalogue, number>();

/**
 * The engine lists of several other computers of this account, for a picker that offers their
 * engines next to this computer's (new-task draft). Nothing is read until `read()` is called — the
 * picker calls it when it opens: one read-only request per computer, at most once per
 * DEVICE_PLUGIN_ENGINES_REREAD_MS; a computer keeps its last answer in between.
 * `null` = that computer has not answered yet (or could not be reached).
 */
export function useDevicesPluginEngines(deviceIds: readonly string[], prefetchOnReconnect = false): {
  catalogues: ReadonlyMap<string, readonly PluginEngineView[] | null>;
  read: (deviceId?: string) => void;
} {
  const owner = getDataOwnerGeneration();
  const key = deviceIds.join('\n');
  const sources = useMemo(
    () => (key ? key.split('\n') : []).map((deviceId) => ({ deviceId, catalogue: deviceCatalogue(owner, deviceId) })),
    [owner, key],
  );
  const read = useCallback((deviceId?: string) => {
    const now = Date.now();
    for (const source of sources) {
      if (deviceId !== undefined && source.deviceId !== deviceId) continue;
      const last = pickerReadAt.get(source.catalogue);
      if (last !== undefined && now - last < DEVICE_PLUGIN_ENGINES_REREAD_MS) continue;
      pickerReadAt.set(source.catalogue, now);
      void source.catalogue.read();
    }
  }, [sources]);
  const subscribe = useCallback((listener: () => void) => {
    // Picker candidates read on demand. A visible settings list can also recover on reconnect.
    const offs = sources.map((source) => source.catalogue.subscribe(listener, prefetchOnReconnect));
    return () => {
      for (const off of offs) off();
    };
  }, [sources, prefetchOnReconnect]);
  // One map per distinct set of answers, so consumers re-render only when a computer's list changed.
  const cache = useRef<{
    sources: typeof sources;
    parts: Array<readonly PluginEngineView[] | null>;
    map: ReadonlyMap<string, readonly PluginEngineView[] | null>;
  } | null>(null);
  const snapshot = useCallback(() => {
    const parts = sources.map((source) => source.catalogue.snapshot());
    const previous = cache.current;
    if (previous && previous.sources === sources && previous.parts.every((part, index) => part === parts[index])) {
      return previous.map;
    }
    const map = new Map(sources.map((source, index) => [source.deviceId, parts[index]] as const));
    cache.current = { sources, parts, map };
    return map;
  }, [sources]);
  const catalogues = useSyncExternalStore(subscribe, snapshot, snapshot);
  return { catalogues, read };
}

/** Engine behind a task's `providerId` (`acp-plugin:<ghostId>:<harnessId>`), or null when it is gone. */
export function findPluginEngine(
  list: readonly PluginEngineView[],
  providerId: string | null | undefined,
): PluginEngineView | null {
  const key = pluginEngineKeyFromProviderId(providerId);
  if (!key) return null;
  return list.find((engine) => engine.key === key || engine.providerId === providerId) ?? null;
}

/**
 * Name to show for a plugin-engine task: the engine's name, or the generic 「插件引擎」 label
 * once the plugin is turned off or removed (never a built-in Harness name).
 */
export function usePluginEngineName(providerId: string | null | undefined): string {
  return usePluginEngineIdentity(providerId).name;
}

/**
 * Name and mark for a plugin-engine task: the engine's name and its plugin's icon, or the generic
 * label and no icon (the caller draws the generic engine mark) once the plugin is gone.
 *
 * For a remote computer (`deviceId`), shares one initial catalogue read across every mounted task
 * row for that computer so sidebar icons resolve without opening a task first.
 */
export function usePluginEngineIdentity(
  providerId: string | null | undefined,
  deviceId?: string,
  options?: {
    /** False while the remote computer is known to be disconnected/connecting: keep cached icon, skip new read. */
    readRemote?: boolean;
  },
): { name: string; iconDataUrl?: string } {
  const { t } = useTranslation();
  const remoteDeviceId = deviceId && !isSharedTaskPeer(deviceId) ? deviceId : undefined;
  const localEngines = usePluginEngines(!!providerId && !deviceId);
  const owner = getDataOwnerGeneration();
  const catalogue = useMemo(
    () => (providerId && remoteDeviceId ? deviceCatalogue(owner, remoteDeviceId) : null),
    [owner, providerId, remoteDeviceId],
  );
  const remoteEngines = useSyncExternalStore(
    catalogue?.subscribe ?? subscribeDisabled,
    catalogue?.snapshot ?? unreadSnapshot,
    unreadSnapshot,
  );
  const readRemote = options?.readRemote !== false;
  useEffect(() => {
    if (!catalogue || !readRemote) return;
    catalogue.ensureLoaded();
  }, [catalogue, readRemote]);
  const engine = findPluginEngine(deviceId ? remoteEngines ?? NO_ENGINES : localEngines, providerId);
  if (!engine) return { name: t('newChat.pluginEngines.genericName') };
  return { name: engine.name, ...(engine.iconDataUrl ? { iconDataUrl: engine.iconDataUrl } : {}) };
}

/** Test seam: forget the shared list and listener between cases. */
export function resetPluginEnginesStoreForTests(): void {
  detachPush?.();
  detachPush = null;
  for (const timer of activeRefreshTimers) clearTimeout(timer);
  activeRefreshTimers.clear();
  listeners.clear();
  generation = 0;
  engines = NO_ENGINES;
  deviceCatalogues = new WeakMap();
}
