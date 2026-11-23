import type { PluginMarketCounts, PluginMarketItem, PluginMarketPage } from '../../../../shared/pluginMarket';
import type { PluginGridCache } from '../PluginVirtualGrid';
import { publicPublisherFilter, type PublicPublisherFilter } from './pluginMarketPresentation';

export const PLUGIN_PAGE_SIZE = 10;
export const PLUGIN_CATALOG_REFRESH_MS = 30_000;
export const PLUGIN_CACHED_PAGES = 6;
// Both publisher tabs browse the same public page. The catalog accepts up to 100 summaries.
export function pluginCatalogPageLimit(scope: string, query: string) {
  return scope === 'public' && !query.trim() ? 100 : PLUGIN_PAGE_SIZE;
}
export function pluginPageSize(items: readonly PluginMarketItem[]) {
  const size = { all: items.length, official: 0, community: 0 };
  for (const item of items) {
    const publisher = publicPublisherFilter(item);
    if (publisher) size[publisher]++;
  }
  return size;
}
export interface PluginBrowserCache {
  key: string;
  partitionKey?: string;
  variants?: Map<string, PluginBrowserCache>;
  countsKey: string;
  pages: Map<number, PluginMarketItem[]>;
  cursors: Map<number, string | null>;
  sizes: Map<number, ReturnType<typeof pluginPageSize>>;
  last: number;
  hasNext: boolean;
  counts: PluginMarketCounts | null;
  metadata: PluginMarketPage | null;
  error: number | null;
  grid: PluginGridCache;
  gridPublisher?: PublicPublisherFilter;
  groups: Map<number, string>;
  lastSource: Map<number, string | null>;
  refreshedAt: number;
  countsAt: number;
  refreshedRevision?: string;
  firstPageFlight?: Promise<PluginMarketPage>;
  countsFlight?: Promise<PluginMarketPage>;
  refresh?: (options?: { force?: boolean; renewIcons?: boolean }) => Promise<void>;
}
export function emptyPluginBrowserCache(key = '', countsKey = ''): PluginBrowserCache {
  return { key, countsKey, pages: new Map(), cursors: new Map([[0, null]]), sizes: new Map(), last: 0,
    hasNext: false, counts: null, metadata: null, error: null, grid: { columns: 2, measurements: [] },
    groups: new Map(), lastSource: new Map(), refreshedAt: 0, countsAt: 0 };
}
export function pluginBrowserKey(ownerKey: string, catalogKey: string, query = '', scope = 'all') {
  return JSON.stringify([pluginCatalogPageLimit(scope, query), ownerKey, catalogKey, query.trim(), scope]);
}

/** Plain IPC values only; keep unchanged projections referentially stable. */
export function samePluginValue(a: unknown, b: unknown): boolean {
  const content = (key: string, value: unknown) => {
    if (!value || typeof value !== 'object') return value;
    if ('sha256' in value && 'mimeType' in value && 'sizeBytes' in value)
      return { ...value, url: undefined, expiresAt: undefined };
    if (key === 'usageStatistics') return { ...value, asOf: undefined };
    return value;
  };
  return a === b || JSON.stringify(a, content) === JSON.stringify(b, content);
}
export function mergePluginItems(previous: PluginMarketItem[], next: PluginMarketItem[], renewIcons = false): PluginMarketItem[] {
  const old = new Map(previous.map(item => [item.pluginId, item]));
  const merged = next.map(item => {
    const existing = old.get(item.pluginId);
    const same = !renewIcons || !item.icon ? samePluginValue(existing, item) : false;
    if (!same || !existing) return item;
    // Update transport metadata silently. Content and React identity stay fixed;
    // explicit failed/expiring-image renewal below can request fresh props.
    if (existing.icon && item.icon) Object.assign(existing.icon, item.icon);
    if (existing.usageStatistics && item.usageStatistics) Object.assign(existing.usageStatistics, item.usageStatistics);
    return existing;
  });
  return merged.length === previous.length && merged.every((item, index) => item === previous[index]) ? previous : merged;
}
