import type { PluginMarketCounts, PluginMarketItem, PluginMarketPage } from '../../../../shared/pluginMarket';
import type { PluginGridCache } from '../PluginVirtualGrid';
import { publicPublisherFilter, type PublicPublisherFilter } from './pluginMarketPresentation';

export const PLUGIN_PAGE_SIZE = 10;
export const PLUGIN_CATALOG_REFRESH_MS = 30_000;
export const PLUGIN_CACHED_PAGES = 6;
export const PLUGIN_VISIBLE_CACHED_PAGES = 30;

export function trimPluginPages<T>(pages: Map<number, T>, limit: number, range?: { first: number; last: number }) {
  if (pages.size <= limit) return;
  const keys = [...pages.keys()];
  if (range) {
    const distance = (index: number) => Math.max(range.first - index, index - range.last, 0);
    // Match the rebuild policy: drop the earlier insertion first on ties.
    keys.reverse().sort((a, b) => distance(a) - distance(b));
  } else {
    keys.reverse();
  }
  for (const key of keys.slice(limit)) pages.delete(key);
}
// Browse All with the same bounded batch as the publisher tabs; searches stay compact.
export function pluginCatalogPageLimit(scope: string, query: string) {
  return (scope === 'public' || scope === 'all') && !query.trim() ? 100 : PLUGIN_PAGE_SIZE;
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
  pageByPlugin?: Map<string, number>;
  cursors: Map<number, string | null>;
  sizes: Map<number, ReturnType<typeof pluginPageSize>>;
  last: number;
  hasNext: boolean;
  counts: PluginMarketCounts | null;
  metadata: PluginMarketPage | null;
  error: number | null;
  restartAt?: number;
  grid: PluginGridCache;
  gridPublisher?: PublicPublisherFilter;
  groups: Map<number, string>;
  lastSource: Map<number, string | null>;
  refreshedAt: number;
  countsAt: number;
  refreshedRevision?: string;
  firstPageFlight?: Promise<PluginMarketPage>;
  countsFlight?: Promise<PluginMarketPage>;
  refresh?: (options?: { force?: boolean; renewIcons?: boolean; retry?: boolean }) => Promise<void>;
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
    if ('sha256' in value && 'mimeType' in value && 'sizeBytes' in value) {
      const hasThumbnail = 'thumbnailUrl' in value && Boolean(value.thumbnailUrl);
      return { ...value, url: undefined, expiresAt: undefined, thumbnailUrl: hasThumbnail };
    }
    if (key === 'usageStatistics') return { ...value, asOf: undefined };
    return value;
  };
  return a === b || JSON.stringify(a, content) === JSON.stringify(b, content);
}
export type MarketIconCache = Map<string, NonNullable<PluginMarketItem['icon']>>;

function marketIconKey(item: PluginMarketItem, icon: NonNullable<PluginMarketItem['icon']>, hasThumbnail = Boolean(icon.thumbnailUrl)) {
  return JSON.stringify([item.pluginId, item.releaseId, icon.sha256, icon.mimeType, icon.sizeBytes, hasThumbnail]);
}

export function forgetFailedMarketIcon(cache: MarketIconCache, item: PluginMarketItem): void {
  if (item.sourceType !== 'server' || !item.icon) return;
  const key = marketIconKey(item, item.icon);
  if (cache.get(key) === item.icon) cache.delete(key);
}

export function readReusedMarketIcon(cache: MarketIconCache, item: PluginMarketItem, preferThumbnail = false): PluginMarketItem {
  if (item.sourceType !== 'server' || !item.icon) return item;
  const now = Date.now();
  const thumbnail = preferThumbnail && !item.icon.thumbnailUrl ? cache.get(marketIconKey(item, item.icon, true)) : undefined;
  const cached = thumbnail && Date.parse(thumbnail.expiresAt) > now ? thumbnail : cache.get(marketIconKey(item, item.icon));
  return cached && cached !== item.icon && Date.parse(cached.expiresAt) > now ? { ...item, icon: cached } : item;
}

export function reuseMarketIcon(cache: MarketIconCache, item: PluginMarketItem): PluginMarketItem {
  const icon = item.icon;
  if (item.sourceType !== 'server' || !icon) return item;
  const key = marketIconKey(item, icon);
  const saved = cache.get(key);
  const reusable = saved && Date.parse(saved.expiresAt) > Date.now() ? saved : icon;
  cache.delete(key);
  cache.set(key, reusable);
  if (cache.size > 256) cache.delete(cache.keys().next().value!);
  return reusable === icon ? item : { ...item, icon: reusable };
}

export function mergePluginItems(previous: PluginMarketItem[], next: PluginMarketItem[], renewIcons = false, iconCache?: MarketIconCache): PluginMarketItem[] {
  const old = new Map(previous.map(item => [item.pluginId, item]));
  const merged = next.map(incoming => {
    const item = iconCache ? reuseMarketIcon(iconCache, incoming) : incoming;
    const existing = old.get(item.pluginId);
    const previousIcon = existing?.icon;
    const icon = item.icon;
    // Retain the signed address so Chromium can reuse the same image cache key.
    const reusable = (!iconCache || item.sourceType !== 'server') && !renewIcons && previousIcon && icon &&
      samePluginValue(previousIcon, icon) && Date.parse(previousIcon.expiresAt) > Date.now();
    if (!existing || !samePluginValue(existing, item)) return reusable ? { ...item, icon: previousIcon } : item;
    if (icon && !reusable && icon !== previousIcon) return item;
    if (existing.usageStatistics && item.usageStatistics) Object.assign(existing.usageStatistics, item.usageStatistics);
    return existing;
  });
  return merged.length === previous.length && merged.every((item, index) => item === previous[index]) ? previous : merged;
}
