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
import {
  PLUGIN_ENGINES_INVOKE,
  pluginEngineKeyFromProviderId,
  type PluginEngineView,
} from '../../shared/pluginEngines';

const log = createLogger('usePluginEngines');

const NO_ENGINES: readonly PluginEngineView[] = Object.freeze([]);

interface PluginEnginesApi {
  listPluginEngines?: () => Promise<PluginEngineView[]>;
  refreshPluginEngines?: () => Promise<void>;
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
export function requestPluginEnginesRefresh(): void {
  void pluginEnginesApi()?.refreshPluginEngines?.().catch((err: unknown) => log.warn('plugin engine refresh failed', err));
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
  ensureProvider(providerId: string): void;
  prefetch(): Promise<void>;
  markStale(): void;
  evict(): void;
  hasSubscribers(): boolean;
  subscribe(listener: () => void): () => void;
  snapshot(): readonly PluginEngineView[] | null;
}

const MAX_PROBED_PROVIDERS = 64;

let deviceCatalogues = new WeakMap<DataOwnerGeneration, Map<string, DeviceCatalogue>>();

function sameEngineViews(
  a: readonly PluginEngineView[] | null,
  b: readonly PluginEngineView[],
): boolean {
  if (a === null || a.length !== b.length) return false;
  return JSON.stringify(a) === JSON.stringify(b);
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
  let lastReadAt = 0;
  const probedProviders = new Set<string>();
  const subscribers = new Set<() => void>();
  const catalogue: DeviceCatalogue = {
    read() {
      if (!isDataOwnerGenerationCurrent(owner) || isSharedTaskPeer(deviceId)) return Promise.resolve();
      if (pending) return pending;
      const readGeneration = deviceGeneration;
      const run = Promise.resolve()
        .then(() => isDataOwnerGenerationCurrent(owner) && readGeneration === deviceGeneration
          ? window.electronAPI?.deviceLink?.invoke(deviceId, PLUGIN_ENGINES_INVOKE.LIST, [])
          : undefined)
        .then((reply) => {
          if (!isDataOwnerGenerationCurrent(owner) || readGeneration !== deviceGeneration || !Array.isArray(reply)) {
            return;
          }
          const next = sanitize(reply);
          lastReadAt = Date.now();
          retainReportingPluginEngines(owner, deviceId, next);
          if (sameEngineViews(current, next)) return;
          current = next;
          for (const subscriber of subscribers) subscriber();
        })
        // Old or unreachable hosts leave the catalogue unknown or retain their last result.
        .catch(() => undefined)
        .finally(() => {
          if (pending === run) pending = undefined;
        });
      pending = run;
      return run;
    },
    ensureProvider(providerId) {
      if (!isDataOwnerGenerationCurrent(owner) || isSharedTaskPeer(deviceId)) return;
      if (current !== null && findPluginEngine(current, providerId) !== null) return;
      if (probedProviders.has(providerId)) return;
      if (probedProviders.size >= MAX_PROBED_PROVIDERS) {
        const oldest = probedProviders.values().next().value;
        if (oldest !== undefined) probedProviders.delete(oldest);
      }
      probedProviders.add(providerId);
      void catalogue.read();
    },
    prefetch() {
      if (!isDataOwnerGenerationCurrent(owner) || isSharedTaskPeer(deviceId)) return Promise.resolve();
      if (pending) return pending;
      if (current !== null && lastReadAt > 0 && Date.now() - lastReadAt < DEVICE_PLUGIN_ENGINES_REREAD_MS) {
        return Promise.resolve();
      }
      probedProviders.clear();
      return catalogue.read();
    },
    markStale() {
      lastReadAt = 0;
      probedProviders.clear();
    },
    evict() {
      deviceGeneration += 1;
      pending = undefined;
      lastReadAt = 0;
      probedProviders.clear();
      retainReportingPluginEngines(owner, deviceId, []);
      if (current !== null) {
        current = null;
        for (const subscriber of subscribers) subscriber();
      }
    },
    hasSubscribers() {
      return subscribers.size > 0;
    },
    subscribe(listener) {
      subscribers.add(listener);
      return () => { subscribers.delete(listener); };
    },
    snapshot() {
      return isDataOwnerGenerationCurrent(owner) ? current : null;
    },
  };
  devices.set(deviceId, catalogue);
  return catalogue;
}

/** Whether any mounted UI currently subscribes to a remote computer's plugin engine catalogue. */
export function hasRemotePluginEngineSubscribers(deviceId: string): boolean {
  return existingDeviceCatalogue(getDataOwnerGeneration(), deviceId)?.hasSubscribers() ?? false;
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

function unreadSnapshot(): null {
  return null;
}

/** Reads on entry/reconnect when requested. The picker can also re-read on open. */
export function useRemotePluginEngines(deviceId?: string, readOnEntry = false): {
  engines: readonly PluginEngineView[] | null;
  read: () => void;
} {
  const owner = getDataOwnerGeneration();
  const catalogue = useMemo(() => deviceId ? deviceCatalogue(owner, deviceId) : null, [owner, deviceId]);
  const read = useCallback(() => { void catalogue?.read(); }, [catalogue]);
  useEffect(() => {
    if (readOnEntry) read();
  }, [readOnEntry, read]);
  const remoteEngines = useSyncExternalStore(
    catalogue?.subscribe ?? subscribeDisabled,
    catalogue?.snapshot ?? unreadSnapshot,
    unreadSnapshot,
  );
  return { engines: remoteEngines, read };
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
export function useDevicesPluginEngines(deviceIds: readonly string[]): {
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
    const offs = sources.map((source) => source.catalogue.subscribe(listener));
    return () => {
      for (const off of offs) off();
    };
  }, [sources]);
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
    if (!catalogue || !providerId || !readRemote) return;
    catalogue.ensureProvider(providerId);
  }, [catalogue, providerId, readRemote]);
  const engine = findPluginEngine(deviceId ? remoteEngines ?? NO_ENGINES : localEngines, providerId);
  if (!engine) return { name: t('newChat.pluginEngines.genericName') };
  return { name: engine.name, ...(engine.iconDataUrl ? { iconDataUrl: engine.iconDataUrl } : {}) };
}

/** Test seam: forget the shared list and listener between cases. */
export function resetPluginEnginesStoreForTests(): void {
  detachPush?.();
  detachPush = null;
  listeners.clear();
  generation = 0;
  engines = NO_ENGINES;
  deviceCatalogues = new WeakMap();
}
