import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { emptyPluginBrowserCache, mergePluginItems, samePluginValue, PLUGIN_CATALOG_REFRESH_MS } from './pluginBrowserCache';
import { ghostWebviewOwnerKey } from './ghostPluginViewModel';
import { resolveSystemLocale } from '../../../../shared/locale';
import type { PluginGridCache } from '../PluginVirtualGrid';
import type { PluginMarketItem, PluginMarketSnapshot } from '../../../../shared/pluginMarket';
import type { PluginManagementSnapshot } from '../../../../shared/pluginManagement';

function emptyCatalogMemory() {
  return {
    query: '', catalogTab: 'installed' as 'installed' | 'market', originFilter: 'all' as 'all' | 'public' | 'organization' | 'personal' | 'custom' | 'local',
    installedLimit: 10, marketTotal: null as number | null,
    browser: { current: emptyPluginBrowserCache() },
    installedGrid: { columns: 2, measurements: [] } as PluginGridCache, installedQuery: '',
    scroll: { offset: 0, anchor: null as { id: string; top: number } | null },
    todayPool: [] as PluginMarketItem[], consumedToday: new Set<string>(), todayLoaded: false,
    snapshot: null as PluginMarketSnapshot | null,
    remoteSnapshot: null as PluginManagementSnapshot | null,
    catalogPaging: false,
    catalogRevision: 0,
    localeReady: false,
    snapshotAt: 0, recommendationsAt: 0,
    snapshotFlight: null as Promise<PluginMarketSnapshot> | null,
    recommendationsFlight: null as Promise<PluginMarketItem[]> | null,
  };
}
type CatalogMemory = ReturnType<typeof emptyCatalogMemory>;
const catalogs = new Map<string, { ownerKey: string; memory: CatalogMemory }>();

export function pluginCatalogOwnerKey(mode: 'signed-out' | 'local' | 'cloud', owner: string | null, generation: number | undefined, locale: string) {
  return pluginCatalogPartitionKey(ghostWebviewOwnerKey(mode, owner), locale, generation);
}
export function pluginCatalogPartitionKey(ownerKey: string, locale: string, generation = 0) {
  return JSON.stringify([ownerKey, generation, resolveSystemLocale(locale)]);
}

/** View state only, for this renderer lifetime. Never restores actions or authority. */
export function pluginCatalogMemory(ownerKey: string, target: string): CatalogMemory {
  const entry = catalogs.get(target);
  if (entry?.ownerKey === ownerKey) return entry.memory;
  const memory = emptyCatalogMemory();
  catalogs.set(target, { ownerKey, memory });
  return memory;
}

export function usePluginCatalogState<K extends 'query' | 'catalogTab' | 'originFilter' | 'installedLimit' | 'marketTotal' | 'todayPool' | 'consumedToday' | 'todayLoaded' | 'snapshot' | 'remoteSnapshot' | 'catalogPaging' | 'catalogRevision'>(
  memory: CatalogMemory, key: K,
): [CatalogMemory[K], Dispatch<SetStateAction<CatalogMemory[K]>>] {
  const [state, setState] = useState({ memory, value: memory[key] });
  const latest = useRef(memory);
  latest.current = memory;
  if (state.memory !== memory || !Object.is(state.value, memory[key])) setState({ memory, value: memory[key] });
  const update: Dispatch<SetStateAction<CatalogMemory[K]>> = useCallback(value => {
    const memory = latest.current;
    const next = typeof value === 'function'
      ? (value as (previous: CatalogMemory[K]) => CatalogMemory[K])(memory[key]) : value;
    memory[key] = next;
    setState(previous => previous.memory === memory && Object.is(previous.value, next) ? previous : { memory, value: next });
  }, [key]);
  return [state.memory === memory ? state.value : memory[key], update];
}

export function pluginInstalledGrid(memory: CatalogMemory, query: string) {
  if (memory.installedQuery !== query) {
    memory.installedQuery = query;
    memory.installedGrid = { columns: 2, measurements: [] };
    memory.installedLimit = 10;
  }
  return memory.installedGrid;
}

export function mergePluginSnapshot(previous: PluginMarketSnapshot | null, next: PluginMarketSnapshot, renewIcons = false) {
  // Main reports failures per source, alongside successful custom results.
  const received = new Set(next.items.map(item => item.pluginId));
  const unavailable = new Set(next.unavailableCustomSourceNames);
  const retained = previous?.items.filter(item => !received.has(item.pluginId) && (item.sourceType === 'server'
    ? next.unavailableReason !== null : unavailable.has(item.sourceMarketName ?? ''))) ?? [];
  const items = mergePluginItems(previous?.items ?? [], [...retained, ...next.items], renewIcons);
  return previous?.items === items && samePluginValue(previous, { ...next, items }) ? previous : { ...next, items };
}

export function readLocalPluginSnapshot(memory: CatalogMemory, force = false, renewIcons = false): Promise<PluginMarketSnapshot> {
  if (memory.snapshotFlight) return memory.snapshotFlight;
  if (!force && memory.snapshot && Date.now() - memory.snapshotAt < PLUGIN_CATALOG_REFRESH_MS) return Promise.resolve(memory.snapshot);
  const flight = window.electronAPI.pluginMarket.snapshot().then(next => {
    // Publish data and freshness together in the initiating partition. A locale
    // refresh joining immediately after settlement must not reuse the old data.
    memory.snapshot = mergePluginSnapshot(memory.snapshot, next, renewIcons);
    memory.snapshotAt = Date.now();
    return memory.snapshot;
  }).finally(() => { if (memory.snapshotFlight === flight) memory.snapshotFlight = null; });
  memory.snapshotFlight = flight;
  return flight;
}

export function readPluginRecommendations(memory: CatalogMemory): Promise<PluginMarketItem[]> {
  if (memory.recommendationsFlight) return memory.recommendationsFlight;
  if (memory.todayLoaded && Date.now() - memory.recommendationsAt < PLUGIN_CATALOG_REFRESH_MS) return Promise.resolve(memory.todayPool);
  const flight = window.electronAPI.pluginMarket.recommendations().then(next => {
    memory.recommendationsAt = Date.now();
    return mergePluginItems(memory.todayPool, next);
  }).finally(() => { if (memory.recommendationsFlight === flight) memory.recommendationsFlight = null; });
  memory.recommendationsFlight = flight;
  return flight;
}

export function resetPluginCatalogMemoryForTest() { catalogs.clear(); }
