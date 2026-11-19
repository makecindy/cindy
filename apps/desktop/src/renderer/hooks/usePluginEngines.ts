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
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
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
  subscribe(listener: () => void): () => void;
  snapshot(): readonly PluginEngineView[] | null;
}

let deviceCatalogues = new WeakMap<DataOwnerGeneration, Map<string, DeviceCatalogue>>();

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
  const subscribers = new Set<() => void>();
  const catalogue: DeviceCatalogue = {
    read() {
      if (!isDataOwnerGenerationCurrent(owner)) return Promise.resolve();
      pending ??= Promise.resolve()
        .then(() => isDataOwnerGenerationCurrent(owner)
          ? window.electronAPI?.deviceLink?.invoke(deviceId, PLUGIN_ENGINES_INVOKE.LIST, [])
          : undefined)
        .then((reply) => {
          if (!isDataOwnerGenerationCurrent(owner) || !Array.isArray(reply)) return;
          const next = sanitize(reply);
          retainReportingPluginEngines(owner, deviceId, next);
          current = next;
          for (const subscriber of subscribers) subscriber();
        })
        // Old or unreachable hosts leave the catalogue unknown or retain their last result.
        .catch(() => undefined)
        .finally(() => { pending = undefined; });
      return pending;
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
 */
export function usePluginEngineIdentity(
  providerId: string | null | undefined,
  deviceId?: string,
): { name: string; iconDataUrl?: string } {
  const { t } = useTranslation();
  const localEngines = usePluginEngines(!!providerId && !deviceId);
  const { engines: remoteEngines } = useRemotePluginEngines(providerId ? deviceId : undefined);
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
