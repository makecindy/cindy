import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { extractIpcError } from '@/utils/ipcError';
import { DEFAULT_PLUGIN_MARKET_SORT, type PluginMarketCounts, type PluginMarketItem, type PluginMarketMetric, type PluginMarketPage, type PluginMarketQuery } from '../../../shared/pluginMarket';
import type { InstalledGhost } from '../../../shared/ghost';
import { marketItemMatchesInstalledGhost, publicPublisherFilter, simulatorMigrationCounterpart, type PluginCatalogFilter } from './lib/pluginMarketPresentation';
import { CatalogSectionHeader } from './PluginManagementLayout';
import { PluginVirtualGrid } from './PluginVirtualGrid';
import { pluginMarketOrganizationAccessErrorKey } from './lib/pluginMarketErrorKey';
import { emptyPluginBrowserCache, mergePluginItems, pluginBrowserKey, pluginCatalogPageLimit, pluginPageSize, samePluginValue,
  PLUGIN_CACHED_PAGES, PLUGIN_VISIBLE_CACHED_PAGES, PLUGIN_CATALOG_REFRESH_MS, trimPluginPages, type PluginBrowserCache } from './lib/pluginBrowserCache';
export { emptyPluginBrowserCache, PLUGIN_PAGE_SIZE, type PluginBrowserCache } from './lib/pluginBrowserCache';
import { readPluginCatalogAnchor, restorePluginCatalogAnchor, type PluginCatalogAnchor } from './lib/pluginCatalogAnchor';
import { useDelayedPluginLoading } from './lib/useDelayedPluginLoading';
import { mergePluginSnapshot } from './lib/pluginCatalogMemory';
import { readReusedMarketIcon, type MarketIconCache } from './lib/pluginBrowserCache';

function dedupeCachedPages(cache: PluginBrowserCache): boolean {
  const seen = new Set<string>();
  let changed = false;
  for (const [index, items] of [...cache.pages].sort(([a], [b]) => a - b)) {
    const unique = items.filter(item => {
      if (seen.has(item.pluginId)) return false;
      seen.add(item.pluginId); return true;
    });
    if (unique.length === items.length) continue;
    cache.pages.set(index, unique); cache.sizes.set(index, pluginPageSize(unique)); changed = true;
  }
  return changed;
}

function uniquePageItems(pageByPlugin: Map<string, number>, index: number, items: PluginMarketItem[]): PluginMarketItem[] {
  const seen = new Set<string>();
  return items.filter(({ pluginId }) => {
    const ownerPage = pageByPlugin.get(pluginId);
    if (seen.has(pluginId) || (ownerPage !== undefined && ownerPage !== index)) return false;
    seen.add(pluginId);
    pageByPlugin.set(pluginId, index);
    return true;
  });
}

function activeCatalogSort(page: PluginMarketPage | null, online: boolean): string | undefined {
  return online && page && !page.unavailableReason ? page.sort : undefined;
}

function cursorRejected(error: unknown): boolean {
  const code = extractIpcError(error)?.code;
  return code === 'PLUGIN_LIST_CHANGED' || code === 'INVALID_PARAMS';
}

export type PluginMarketRowMetric = PluginMarketMetric & { icon?: 'download' };

const CatalogCard = memo(function CatalogCard({ item, installState, renderItem, metric }: {
  item: PluginMarketItem; renderItem(item: PluginMarketItem, metric?: PluginMarketRowMetric | null): ReactNode; renderRevision?: unknown; metric?: PluginMarketRowMetric | null;
  installState: PluginMarketItem['installState'];
}) {
  return <div data-plugin-id={item.pluginId}>
    {renderItem(installState === item.installState ? item : { ...item, installState }, metric)}
  </div>;
}, (previous, next) => previous.item === next.item && previous.installState === next.installState &&
  previous.renderRevision === next.renderRevision && samePluginValue(previous.metric, next.metric));

/** Cursor metadata survives detail navigation. Keep more pages in the visible catalog for return scrolling. */
export function PluginCatalogBrowser({ cacheRef, ownerKey, revision, catalogKey = '', installedItems, installedGhosts, query, scope: filter, onScope, showOrganization, prewarm = false,
  visible, scrollRef, loadPage, renderItem, renderRevision, onCounts, filterHost, iconCache, renderPublicPreview, online = true }: {
  cacheRef: RefObject<PluginBrowserCache>;
  ownerKey: string;
  revision: string;
  catalogKey?: string;
  installedItems?: PluginMarketItem[];
  installedGhosts?: readonly InstalledGhost[];
  query: string;
  scope: PluginCatalogFilter;
  onScope(scope: PluginCatalogFilter): void;
  showOrganization: boolean;
  prewarm?: boolean;
  visible: boolean;
  scrollRef: RefObject<HTMLElement | null>;
  loadPage(input: PluginMarketQuery): Promise<PluginMarketPage>;
  renderItem(item: PluginMarketItem, metric?: PluginMarketRowMetric | null): ReactNode;
  /** Reuses the first unfiltered public page already warmed for the installed tab. */
  renderPublicPreview?(items: readonly PluginMarketItem[]): ReactNode;
  online?: boolean;
  renderRevision?: unknown;
  onCounts?(counts: PluginMarketCounts | null): void;
  filterHost?: RefObject<HTMLDivElement | null>;
  iconCache?: MarketIconCache;
}) {
  const { t } = useTranslation();
  const [, rerender] = useReducer(n => n + 1, 0);
  const publisher = filter === 'official' || filter === 'community' ? filter : undefined;
  const scope = filter === 'official' || filter === 'community' ? 'public' : filter;
  const pageLimit = pluginCatalogPageLimit(scope, query);
  const excludeInstalled = Boolean(query.trim());
  const countsKey = JSON.stringify([ownerKey, catalogKey, query.trim()]);
  const [requestedSort, setRequestedSort] = useState(() => cacheRef.current.metadata?.sort ?? DEFAULT_PLUGIN_MARKET_SORT);
  const sort = scope === 'custom' ? undefined : requestedSort;
  const keyFor = useCallback((source: string, order?: string, search = query) =>
    pluginBrowserKey(ownerKey, catalogKey, search, order && order !== DEFAULT_PLUGIN_MARKET_SORT ? JSON.stringify([source, order]) : source),
  [ownerKey, catalogKey, query]);
  const key = keyFor(scope, sort);
  const partitionKey = JSON.stringify([ownerKey, catalogKey]);
  const previousCache = cacheRef.current;
  const displayed = useRef(previousCache);
  const variants = previousCache.partitionKey === partitionKey
    ? previousCache.variants ?? new Map<string, PluginBrowserCache>() : new Map<string, PluginBrowserCache>();
  const sameCountsKey = previousCache.countsKey === countsKey;
  const cache = previousCache.key === key ? previousCache : variants.get(key) ?? {
    ...emptyPluginBrowserCache(key, countsKey),
    counts: sameCountsKey ? previousCache.counts : null,
    countsAt: sameCountsKey ? previousCache.countsAt : 0,
    countsFlight: sameCountsKey ? previousCache.countsFlight : undefined,
  };
  cache.partitionKey = partitionKey; cache.variants = variants;
  if (cache.gridPublisher !== publisher) {
    delete cache.grid.restore;
    delete cache.grid.offset;
    cache.gridPublisher = publisher;
  }
  if (sameCountsKey && previousCache.countsAt > cache.countsAt) {
    cache.counts = previousCache.counts; cache.countsAt = previousCache.countsAt;
  }
  if (previousCache.key !== key) {
    // Unfinished reads belong to the old visit; returning must not revive one.
    if (!previousCache.metadata) variants.delete(previousCache.key);
    // A source click chooses the new list start, unlike detail-return restore.
    delete cache.grid.restore;
  }
  variants.delete(key); variants.set(key, cache);
  while (variants.size > 4) {
    const oldest = [...variants.keys()].find(candidate => candidate !== displayed.current.key && candidate !== key)!;
    variants.delete(oldest);
  }
  cacheRef.current = cache;
  // A pending source/search keeps the last usable projection, never another
  // owner/locale. The LRU still owns the only copies of loaded batches.
  if (cache.metadata || displayed.current.partitionKey !== partitionKey) displayed.current = cache;
  if (!displayed.current.metadata) {
    displayed.current = [...variants.values()].reverse().find(candidate => candidate.metadata) ?? cache;
  }
  const display = displayed.current;
  const searchFallback = excludeInstalled && display.countsKey !== countsKey;
  for (const variant of variants.values()) {
    if (visible && (variant === cache || variant === display)) continue;
    trimPluginPages(variant.pages, PLUGIN_CACHED_PAGES);
  }
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const showLoading = useDelayedPluginLoading(visible && cache.metadata === null && cache.error === null);
  const isInstalled = useRef<(item: PluginMarketItem) => boolean>(() => false);
  const liveMarketItems = useMemo(() => new Map(installedItems?.map(item => [item.pluginId, item])), [installedItems]);
  const { ghostsById, ghostsByMarketId } = useMemo(() => {
    const ghostsById = new Map<string, InstalledGhost[]>();
    const ghostsByMarketId = new Map<string, InstalledGhost>();
    for (const ghost of installedGhosts ?? []) {
      const sameId = ghostsById.get(ghost.manifest.id);
      if (sameId) sameId.push(ghost);
      else ghostsById.set(ghost.manifest.id, [ghost]);
      if (ghost.publishingSource?.kind === 'public-market') ghostsByMarketId.set(ghost.publishingSource.pluginId, ghost);
    }
    return { ghostsById, ghostsByMarketId };
  }, [installedGhosts]);
  const installStateFor = (item: PluginMarketItem): PluginMarketItem['installState'] => {
    const live = liveMarketItems.get(item.pluginId)?.installState;
    const ghost = ghostsByMarketId.get(item.pluginId);
    if (ghost && marketItemMatchesInstalledGhost(item, ghost) && live !== 'conflict') {
      return live === 'update-available' ? live : 'installed';
    }
    const state = live ?? item.installState;
    if (excludeInstalled || !installedGhosts || state === 'not-installed') return state;

    // Market snapshots can omit the entry once its local installation is removed.
    if (ghostsById.get(item.ghostId)?.some(candidate =>
      candidate.namespace === undefined || marketItemMatchesInstalledGhost(item, candidate))) return state;
    const counterpart = simulatorMigrationCounterpart(item);
    if (counterpart && ghostsById.has(counterpart)) return state;
    return 'not-installed';
  };
  isInstalled.current = item => {
    if (!excludeInstalled) return false;
    const state = installStateFor(item);
    return state === 'installed' || state === 'update-available';
  };
  const anchor = useRef<PluginCatalogAnchor | null>(null);
  const restartCursors = useRef(false);
  const visiblePages = useRef({ first: 0, last: 0 });
  useLayoutEffect(() => {
    if (scrollRef.current && anchor.current) restorePluginCatalogAnchor(scrollRef.current, anchor.current);
    anchor.current = null;
  });
  useLayoutEffect(() => {
    if (!excludeInstalled) return;
    const saved = scrollRef.current ? readPluginCatalogAnchor(scrollRef.current) : null;
    let changed = false;
    for (const resident of display === cache || searchFallback ? [cache] : [cache, display]) {
      let removed = false;
      for (const [index, items] of resident.pages) {
        const next = items.filter(item => !isInstalled.current(item));
        if (next.length === items.length) continue;
        resident.pages.set(index, next);
        resident.sizes.set(index, pluginPageSize(next));
        removed = true;
      }
      if (removed) {
        if (saved) resident.grid.restore = { anchor: saved };
        changed = true;
      }
    }
    if (changed) {
      anchor.current = saved;
      rerender();
    }
  }, [cache, display, excludeInstalled, searchFallback, installedItems, installedGhosts, scrollRef]);
  const inFlight = useRef(new Map<string, { cache: PluginBrowserCache; promise: Promise<void>; sortedCursors?: PluginBrowserCache['cursors'] }>());
  const readQueue = useRef<Promise<void>>(Promise.resolve());
  const alive = useRef(true);
  const loader = useRef(loadPage);
  loader.current = loadPage;
  const latestRevision = useRef(revision);
  latestRevision.current = revision;
  const onlineRef = useRef(online);
  onlineRef.current = online;
  const refreshFlight = useRef<{ cache: PluginBrowserCache; revision: string; promise: Promise<void>; renewIcons: boolean } | null>(null);
  const countListener = useRef(onCounts);
  countListener.current = onCounts;
  const settleSort = useCallback((entry: PluginBrowserCache, page: PluginMarketPage) => {
    if (!sort || !onlineRef.current || page.unavailableReason) return;
    const effective = page.sort ?? DEFAULT_PLUGIN_MARKET_SORT;
    if (effective === sort) return;
    // Move the loaded chain with its cursors. Re-rendering the echoed key must
    // hit that very cache, even when the requested key has been removed.
    if (variants.get(entry.key) === entry) variants.delete(entry.key);
    entry.key = keyFor(scope, effective);
    variants.set(entry.key, entry);
    setRequestedSort(effective);
  }, [keyFor, scope, sort, variants]);
  const queryPage = useCallback((cursor: string | null | undefined, order = sort) => loader.current({
    query: query.trim().slice(0, 100), scope, cursor, limit: pageLimit, excludeInstalled,
    counts: false, ...(order ? { sort: order } : {}),
  }), [query, scope, pageLimit, sort, excludeInstalled]);
  const read = useCallback((index: number): Promise<void> => {
    const current = cacheRef.current;
    const sortedCursors = sort && activeCatalogSort(current.metadata, onlineRef.current) ? current.cursors : undefined;
    const flightKey = `${current.key}:${index}`;
    const existing = inFlight.current.get(flightKey);
    if (existing?.cache === current && (!sortedCursors || existing.sortedCursors === sortedCursors)) return existing.promise;
    if (!current.cursors.has(index)) return Promise.resolve();
    const previous = readQueue.current;
    let requestedRevision: string | undefined;
    const request: Promise<void> = (async () => {
      try {
        await previous;
        // A slow count must not fan out more obsolete searches while the user types.
        if (!alive.current || cacheRef.current !== current) return;
        if (sortedCursors && (sortedCursors !== current.cursors || (current.restartAt !== undefined && current.error !== null))) return;
        requestedRevision = latestRevision.current;
        const cursor = current.cursors.get(index);
        const response = await (index === 0 && current.firstPageFlight ? current.firstPageFlight
          : queryPage(cursor, cursor ? current.metadata?.sort ?? sort : sort));
        if (index === 0) current.firstPageFlight = undefined;
        if (!alive.current || cacheRef.current !== current || requestedRevision !== latestRevision.current) return;
        if (sortedCursors && (sortedCursors !== current.cursors || (current.restartAt !== undefined && current.error !== null))) return;
        const initial = current.metadata === null;
        const changedSort = index === 0 && !initial && !response.unavailableReason && onlineRef.current
          && response.sort !== current.metadata?.sort;
        if (changedSort) {
          current.pages.clear(); current.sizes.clear(); current.cursors = new Map([[0, null]]);
          current.pageByPlugin = undefined;
          current.last = 0; current.hasNext = false;
        }
        const prior = current.pages.get(index);
        const page = { ...response, items: mergePluginSnapshot(prior && current.metadata ? { ...current.metadata, items: prior } : null,
          response, Boolean(iconCache)).items.filter(item => !isInstalled.current(item)) };
        const sortedPage = sort && activeCatalogSort(page, onlineRef.current);
        const advanceCursor = !sortedPage || !current.sizes.has(index) || current.error === index;
        if (sortedPage) {
          current.pageByPlugin ??= new Map([...current.pages].flatMap(([page, items]) =>
            items.map(item => [item.pluginId, page] as const)));
          page.items = uniquePageItems(current.pageByPlugin, index, page.items);
        }
        const previousItems = current.pages.get(index) ?? (index === 0 && displayed.current.partitionKey === partitionKey
          ? [...displayed.current.pages.values()].flat() : []);
        current.pages.delete(index);
        current.pages.set(index, mergePluginItems(previousItems, page.items, false, iconCache));
        if (scope === 'custom') {
          let previous = current.lastSource.get(index - 1) ?? null;
          let start = 0;
          for (let page = 0; page < index; page++) start += current.sizes.get(page)?.all ?? 0;
          page.items.forEach((item, offset) => {
            if (item.sourceMarketName && item.sourceMarketName !== previous) current.groups.set(start + offset, item.sourceMarketName);
            previous = item.sourceMarketName;
          });
          current.lastSource.set(index, previous);
        }
        if (visibleRef.current) trimPluginPages(current.pages, PLUGIN_VISIBLE_CACHED_PAGES, visiblePages.current);
        else trimPluginPages(current.pages, PLUGIN_CACHED_PAGES);
        current.sizes.set(index, pluginPageSize(page.items));
        if (advanceCursor) {
          if (index >= current.last) { current.last = index; current.hasNext = page.nextCursor !== null; }
          if (page.nextCursor) current.cursors.set(index + 1, page.nextCursor);
          else if (sortedPage) current.cursors.delete(index + 1);
        }
        if (page.counts) { current.counts = page.counts; countListener.current?.(page.counts); }
        const sortMetadata = index > 0 && !page.sort && !page.unavailableReason && current.metadata?.sort &&
          scope === 'all' && page.items.every(item => item.sourceType !== 'server') ? {
            sort: current.metadata.sort, sorts: current.metadata.sorts,
          } : {};
        current.metadata = { ...page, ...sortMetadata, items: [], unavailableCustomSourceNames: index > 0
          ? [...new Set([...(current.metadata?.unavailableCustomSourceNames ?? []), ...page.unavailableCustomSourceNames])]
          : page.unavailableCustomSourceNames };
        current.error = page.unavailableReason && page.items.length === 0 ? index : null;
        if (!sortedPage) dedupeCachedPages(current);
        if (initial || changedSort) { current.refreshedRevision = requestedRevision; current.refreshedAt = Date.now(); }
        if (index === 0) settleSort(current, page);
      } catch (error) {
        if (index === 0) current.firstPageFlight = undefined;
        if (!alive.current || cacheRef.current !== current || requestedRevision !== latestRevision.current) return;
        if (sortedCursors && (sortedCursors !== current.cursors || (current.restartAt !== undefined && current.error !== null))) return;
        if (index > 0 && (sortedCursors ? cursorRejected(error) : extractIpcError(error)?.code === 'PLUGIN_LIST_CHANGED')) {
          current.refreshedRevision = undefined;
          if (sortedCursors) current.restartAt = index;
          else restartCursors.current = true;
          void current.refresh?.({ force: true });
        } else current.error = index;
      }
    })().finally(() => {
      if (inFlight.current.get(flightKey)?.promise === request) inFlight.current.delete(flightKey);
      if (alive.current) rerender();
      if (alive.current && cacheRef.current === current && requestedRevision !== undefined && requestedRevision !== latestRevision.current) {
        void current.refresh?.({ force: true });
      }
    });
    readQueue.current = request;
    inFlight.current.set(flightKey, { cache: current, promise: request, sortedCursors });
    return request;
  }, [cacheRef, scope, partitionKey, queryPage, settleSort, sort, iconCache]);
  useEffect(() => {
    alive.current = true;
    if (!visible && !prewarm) return () => { alive.current = false; };
    if (!cacheRef.current.metadata) {
      countListener.current?.(cacheRef.current.counts);
      const timer = setTimeout(() => {
        if (!cacheRef.current.metadata) { void read(0); rerender(); }
      }, query.trim() ? 250 : 0);
      return () => { clearTimeout(timer); alive.current = false; };
    }
    countListener.current?.(cacheRef.current.counts);
    return () => { alive.current = false; };
  }, [key, cacheRef, read, visible, prewarm]);
  const countQueue = useRef(Promise.resolve());
  const count = useCallback(async () => {
    const previous = countQueue.current;
    const flight = (async () => {
      await previous;
      if (!alive.current || cacheRef.current !== cache) return;
      if (!cache.countsFlight && cache.countsKey === countsKey && Date.now() - cache.countsAt < PLUGIN_CATALOG_REFRESH_MS) return;
      const requestedRevision = latestRevision.current;
      cache.countsAt = Date.now();
      try {
        const page = await (cache.countsFlight ??= loader.current({ query: query.trim().slice(0, 100), scope: 'all', limit: 1,
          excludeInstalled, counts: true }));
        if (!alive.current || cacheRef.current !== cache || requestedRevision !== latestRevision.current) return;
        cache.countsKey = countsKey; cache.countsAt = Date.now(); cache.countsFlight = undefined;
        if (page.counts && !samePluginValue(cache.counts, page.counts)) {
          cache.counts = page.counts; countListener.current?.(page.counts); rerender();
        }
      } catch { cache.countsFlight = undefined; /* Counts never hide usable cards. */ }
    })();
    countQueue.current = flight;
    await flight;
  }, [cache, cacheRef, countsKey, query, excludeInstalled]);
  useEffect(() => {
    if (!visible && !prewarm) return;
    let active = true;
    const current = () => active && alive.current && cacheRef.current === cache;
    const refresh = async (options?: Parameters<NonNullable<PluginBrowserCache['refresh']>>[0]) => {
      if (!current()) return;
      const pending = refreshFlight.current;
      if (pending?.cache === cache) {
        if (options?.renewIcons) pending.renewIcons = true;
        await pending.promise;
        // Reuse the flight as the queue: only invalidations newer than that
        // read need a follow-up. Concurrent callers join that one latest read.
        if (current() && pending.revision !== latestRevision.current && cache.refreshedRevision !== latestRevision.current) {
          await refresh({ ...options, force: true });
        }
        return;
      }
      const flight = (async () => {
        await readQueue.current;
        if (!current()) return;
        if (!options?.force && cache.refreshedRevision === latestRevision.current && Date.now() - cache.refreshedAt < PLUGIN_CATALOG_REFRESH_MS) return;
        const requestedRevision = latestRevision.current;
        if (refreshFlight.current?.cache === cache) refreshFlight.current.revision = requestedRevision;
        if (!cache.metadata) { if (cache.error === null || options?.force) await read(0); return; }
        const coversRevision = () => current() && requestedRevision === latestRevision.current;
        const retainLimit = visible ? PLUGIN_VISIBLE_CACHED_PAGES : PLUGIN_CACHED_PAGES;
        if (sort && activeCatalogSort(cache.metadata, onlineRef.current)) {
          if (cache.restartAt !== undefined && cache.error !== null && !options?.retry) return;
          const pages: PluginBrowserCache['pages'] = new Map();
          const sizes: PluginBrowserCache['sizes'] = new Map();
          const cursors: PluginBrowserCache['cursors'] = new Map([[0, null]]);
          const pageByPlugin = new Map<string, number>();
          const viewport = visiblePages.current;
          const root = visible ? scrollRef.current : null;
          const startAnchor = root ? readPluginCatalogAnchor(root) : cache.grid.restore?.anchor;
          const unavailableSources = new Set<string>();
          let metadata = cache.metadata;
          let cursor: string | null = null;
          let index = 0;
          try {
            // Only a confirmed sort needs a fresh chain. The live list can
            // keep using its own cursor map until the new projection is ready.
            for (; index <= Math.max(cache.last, cache.restartAt ?? 0); index++) {
              if (!coversRevision() || !onlineRef.current) return;
              const page = await queryPage(cursor, cursor ? metadata.sort ?? DEFAULT_PLUGIN_MARKET_SORT : sort);
              if (!coversRevision() || !onlineRef.current) return;
              if (page.unavailableReason) {
                cache.metadata = { ...cache.metadata, sort: undefined, sorts: undefined,
                  unavailableReason: page.unavailableReason };
                if (cache.restartAt !== undefined) cache.error = cache.restartAt;
                delete cache.restartAt;
                rerender();
                return;
              }
              if (index === 0) metadata = { ...page, items: [] };
              for (const name of page.unavailableCustomSourceNames) unavailableSources.add(name);
              const previous = cache.pages.get(index) ?? [];
              const renewIcons = refreshFlight.current?.cache === cache && refreshFlight.current.renewIcons;
              const merged = mergePluginSnapshot({ ...cache.metadata, items: previous }, page, renewIcons || Boolean(iconCache));
              const items = uniquePageItems(pageByPlugin, index, merged.items.filter(item => !isInstalled.current(item)));
              pages.set(index, mergePluginItems(previous, items, renewIcons, iconCache));
              sizes.set(index, pluginPageSize(items));
              const range = visiblePages.current;
              const first = range === viewport && startAnchor ? pageByPlugin.get(startAnchor.id) ?? range.first : range.first;
              const last = first + range.last - range.first;
              trimPluginPages(pages, retainLimit, { first, last });
              cursor = page.nextCursor;
              if (!cursor) break;
              cursors.set(index + 1, cursor);
            }
          } catch (error) {
            if (coversRevision() && (cache.restartAt !== undefined || cursorRejected(error))) {
              cache.restartAt ??= index;
              cache.error = index;
              rerender();
            }
            return;
          }
          const saved = root ? readPluginCatalogAnchor(root) : cache.grid.restore?.anchor;
          const anchorId = saved && [saved.id, ...(saved.following ?? [])].find(id => pageByPlugin.has(id));
          const anchorPage = anchorId ? pageByPlugin.get(anchorId) : undefined;
          let restore: PluginBrowserCache['grid']['restore'];
          if (saved && anchorPage !== undefined) {
            const publisher = cache.gridPublisher;
            const visibleItems = publisher ? pages.get(anchorPage)?.filter(item => publicPublisherFilter(item) === publisher) : pages.get(anchorPage);
            let offset = 0;
            for (let page = 0; page < anchorPage; page++) offset += sizes.get(page)?.[publisher ?? 'all'] ?? 0;
            const withinPage = visibleItems?.findIndex(item => item.pluginId === anchorId) ?? 0;
            restore = { anchor: saved, index: offset + Math.max(0, withinPage) };
          }
          cache.pages = pages; cache.sizes = sizes; cache.cursors = cursors;
          cache.pageByPlugin = pageByPlugin;
          cache.last = sizes.size - 1; cache.hasNext = cursor !== null;
          cache.metadata = { ...metadata, unavailableCustomSourceNames: [...unavailableSources] };
          cache.grid = { ...cache.grid, restore };
          delete cache.restartAt;
          cache.error = null;
          cache.refreshedRevision = requestedRevision;
          cache.refreshedAt = Date.now();
          settleSort(cache, metadata);
          // The grid's offsets also depend on sizes of its evicted pages.
          rerender();
          return;
        }
        const pages = new Map<number, PluginMarketPage>();
        const rebuiltSizes: PluginBrowserCache['sizes'] = new Map();
        const rebuiltCursors = new Map<number, string | null>([[0, null]]);
        const previousPages = new Map(cache.pages);
        const previousOffsets = [0];
        for (let index = 0; index <= cache.last; index++) previousOffsets.push(previousOffsets[index] + (cache.sizes.get(index)?.all ?? 0));
        let rebuilt = false;
        let rebuiltHasNext = false;
        let headPage: PluginMarketPage | undefined;
        try {
          if (restartCursors.current) throw new Error('[PLUGIN_LIST_CHANGED] Plugin cursor changed');
          // Rebuild off-screen. An invalid cursor restarts this bounded resident
          // window from the beginning; visible batches stay intact until ready.
          const refreshWindow = new Map(previousPages);
          trimPluginPages(refreshWindow, PLUGIN_CACHED_PAGES, visiblePages.current);
          for (const index of [...refreshWindow.keys()].sort((a, b) => a - b)) {
            if (!coversRevision()) return;
            const page = await queryPage(cache.cursors.get(index));
            if (!coversRevision()) return;
            if (index === 0) headPage = page;
            if (sort && activeCatalogSort(page, onlineRef.current))
              throw new Error('[PLUGIN_LIST_CHANGED] Catalog now supports sorting');
            pages.set(index, page);
          }
        } catch (error) {
          if (!coversRevision() || extractIpcError(error)?.code !== 'PLUGIN_LIST_CHANGED') return;
          pages.clear(); rebuilt = true;
          anchor.current = scrollRef.current ? readPluginCatalogAnchor(scrollRef.current) : null;
          const viewport = visiblePages.current;
          let anchorPage: number | undefined;
          const firstVisiblePage = () => visiblePages.current === viewport ? anchorPage ?? viewport.first : visiblePages.current.first;
          const retainVisiblePages = () => {
            const first = firstVisiblePage();
            const last = first + visiblePages.current.last - visiblePages.current.first;
            trimPluginPages(pages, retainLimit, { first, last });
          };
          let cursor: string | null = null;
          let order = sort;
          // Walk only as far as the user had loaded, plus the failed next page.
          // Keep the display window resident while rebuilding cursor metadata.
          for (let index = 0; index <= cache.last + 1; index++) {
            if (!coversRevision()) return;
            const page: PluginMarketPage = index === 0 && headPage?.sort && onlineRef.current && !headPage.unavailableReason
              ? headPage : await queryPage(cursor, order);
            if (!coversRevision()) return;
            if (index === 0) { headPage = page; order = page.sort ?? order; }
            pages.set(index, page); cursor = page.nextCursor;
            rebuiltHasNext = cursor !== null;
            if (page.items.some(item => item.pluginId === anchor.current?.id)) anchorPage = index;
            rebuiltSizes.set(index, pluginPageSize(page.items.filter(item => !isInstalled.current(item))));
            if (cursor) rebuiltCursors.set(index + 1, cursor);
            retainVisiblePages();
            if (!cursor) break;
          }
          // Scrolling during the walk can change the visible window after its
          // pages were visited. Fill it before publishing, with the new cursors.
          const first = firstVisiblePage();
          const last = Math.min(first + visiblePages.current.last - visiblePages.current.first, rebuiltSizes.size - 1);
          for (let index = first; index <= last; index++) {
            if (!coversRevision()) return;
            if (pages.has(index) || !rebuiltCursors.has(index)) continue;
            pages.set(index, await queryPage(rebuiltCursors.get(index), order));
            if (!coversRevision()) return;
            retainVisiblePages();
          }
          if (visiblePages.current !== viewport) anchor.current = scrollRef.current ? readPluginCatalogAnchor(scrollRef.current) : null;
        }
        if (!coversRevision()) return;
        let changed = cache.error !== null;
        if (rebuilt) {
          anchor.current ??= scrollRef.current ? readPluginCatalogAnchor(scrollRef.current) : null;
          cache.cursors = rebuiltCursors; cache.sizes = rebuiltSizes;
          cache.last = rebuiltSizes.size - 1;
          cache.hasNext = rebuiltHasNext;
          cache.pages.clear(); restartCursors.current = false; changed = true;
        }
        const renewIcons = refreshFlight.current?.cache === cache && refreshFlight.current.renewIcons;
        for (const [index, page] of pages) {
          const previous = previousPages.get(index) ?? [];
          const next = mergePluginSnapshot(cache.metadata ? { ...cache.metadata, items: previous } : null,
            page, renewIcons || Boolean(iconCache)).items.filter(item => !isInstalled.current(item));
          const merged = mergePluginItems(previous, next, renewIcons, iconCache);
          if (rebuilt || merged !== previous) { cache.pages.set(index, merged); cache.sizes.set(index, pluginPageSize(merged)); changed = true; }
          if (page.nextCursor) cache.cursors.set(index + 1, page.nextCursor);
          if (index === cache.last && cache.hasNext !== (page.nextCursor !== null)) { cache.hasNext = page.nextCursor !== null; changed = true; }
        }
        trimPluginPages(cache.pages, retainLimit, visible ? visiblePages.current : undefined);
        if (dedupeCachedPages(cache)) changed = true;
        const fresh = headPage ?? pages.values().next().value;
        if (fresh && cache.metadata) {
          const metadata = { ...cache.metadata, customSourceNames: fresh.customSourceNames,
            customSourceCounts: fresh.customSourceCounts, organizationAccessError: fresh.organizationAccessError,
            unavailableReason: fresh.unavailableReason, sort: fresh.sort, sorts: fresh.sorts,
            unavailableCustomSourceNames: [...new Set([...pages.values()].flatMap(page => page.unavailableCustomSourceNames))] };
          if (!samePluginValue(cache.metadata, metadata)) { cache.metadata = metadata; changed = true; }
        }
        if (scope === 'custom') {
          const offsets = [0];
          for (let index = 0; index <= cache.last; index++) offsets.push(offsets[index] + (cache.sizes.get(index)?.all ?? 0));
          const groups = new Map<number, string>();
          for (const [index, name] of cache.groups) {
            let low = 0, high = previousOffsets.length - 2;
            while (low < high) { const middle = Math.ceil((low + high) / 2); if (previousOffsets[middle] <= index) low = middle; else high = middle - 1; }
            if (low <= cache.last && !cache.pages.has(low)) groups.set(offsets[low] + index - previousOffsets[low], name);
          }
          for (const [index, items] of [...cache.pages].sort(([a], [b]) => a - b)) {
            let previous = cache.lastSource.get(index - 1) ?? null;
            items.forEach((item, offset) => {
              if (item.sourceMarketName && item.sourceMarketName !== previous) groups.set(offsets[index] + offset, item.sourceMarketName);
              previous = item.sourceMarketName;
            });
            cache.lastSource.set(index, previous);
          }
          cache.groups = groups;
        }
        cache.error = null;
        cache.refreshedRevision = requestedRevision;
        cache.refreshedAt = Date.now();
        if (headPage) settleSort(cache, headPage);
        if (changed) {
          anchor.current ??= scrollRef.current ? readPluginCatalogAnchor(scrollRef.current) : null;
          if (anchor.current) {
            let offset = 0;
            for (let page = 0; page <= cache.last; page++) {
              const items = cache.pages.get(page);
              const visibleItems = cache.gridPublisher ? items?.filter(item => publicPublisherFilter(item) === cache.gridPublisher) : items;
              const index = visibleItems?.findIndex(item => item.pluginId === anchor.current!.id) ?? -1;
              if (index >= 0) { cache.grid.restore = { anchor: anchor.current, index: offset + index }; break; }
              offset += cache.sizes.get(page)?.[cache.gridPublisher ?? 'all'] ?? 0;
            }
          }
          rerender();
        }
      })().catch(() => undefined).finally(() => { if (refreshFlight.current?.promise === flight) refreshFlight.current = null; });
      refreshFlight.current = { cache, revision: latestRevision.current, promise: flight, renewIcons: options?.renewIcons === true };
      await flight;
    };
    if (cache.metadata && cache.refreshedRevision !== latestRevision.current) { cache.countsAt = 0; cache.countsFlight = undefined; }
    cache.refresh = async options => {
      // Signed image URLs can expire independently of the catalog counts.
      const refreshCounts = !options?.renewIcons && Date.now() - cache.countsAt >= PLUGIN_CATALOG_REFRESH_MS;
      await Promise.all([refresh(options), refreshCounts ? count() : Promise.resolve()]);
    };
    const timer = setTimeout(() => {
      if (cache.countsFlight || cache.countsKey !== countsKey || Date.now() - cache.countsAt >= PLUGIN_CATALOG_REFRESH_MS) void count();
      void refresh();
    }, query.trim() ? 250 : 0);
    return () => {
      active = false;
      clearTimeout(timer); cache.refresh = undefined;
      if (refreshFlight.current?.cache === cache) refreshFlight.current = null;
    };
  }, [cache, countsKey, query, scope, sort, visible, prewarm, count, scrollRef, read, queryPage, settleSort, iconCache]);
  const previousRevision = useRef(revision);
  useEffect(() => {
    if (previousRevision.current === revision) return;
    previousRevision.current = revision;
    cache.countsAt = 0; cache.countsFlight = undefined;
    if (visible || prewarm) void cache.refresh?.({ force: true });
  }, [revision, cache, visible, prewarm]);
  const sentinel = useRef<HTMLDivElement>(null);
  const publicTotal = cache.counts?.public;
  const hasPublisherCounts = cache.counts?.official !== undefined && cache.counts?.community !== undefined;
  const restartingSort = Boolean(sort && cache.restartAt !== undefined && activeCatalogSort(cache.metadata, online));
  useEffect(() => {
    if (!visible || !cache.hasNext || cache.error !== null || restartingSort || !sentinel.current || !scrollRef.current) return;
    // Older servers omit the breakdown. Finish only small legacy results in the existing cache.
    const nextPage = cache.last + 1;
    if (!hasPublisherCounts && scope === 'public' && !query.trim() && publicTotal !== undefined && publicTotal > 0 &&
        publicTotal <= pageLimit && nextPage < PLUGIN_CACHED_PAGES && !cache.metadata?.unavailableReason) {
      const timer = setTimeout(() => { if (cacheRef.current === cache) void read(nextPage); }, 0);
      return () => clearTimeout(timer);
    }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { void read(cache.last + 1); rerender(); }
    }, { root: scrollRef.current, rootMargin: '80px' });
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [visible, scope, query, publicTotal, hasPublisherCounts, pageLimit, cache, cacheRef, cache.hasNext, cache.last, cache.error, restartingSort, cache.metadata?.unavailableReason, scrollRef, read]);
  // Filtering installed matches can leave short or empty cursor pages.
  const offsets = [0];
  const filteredPreview = searchFallback ? new Map<number, PluginMarketItem[]>() : undefined;
  for (let page = 0; page <= display.last; page++) {
    if (filteredPreview) {
      // Keep the warm page usable during the search debounce without pruning its cache.
      const rows = display.pages.get(page)?.filter(item =>
        !isInstalled.current(item) && (!publisher || publicPublisherFilter(item) === publisher)) ?? [];
      filteredPreview.set(page, rows);
      offsets.push(offsets[page] + rows.length);
    } else {
      offsets.push(offsets[page] + (display.sizes.get(page)?.[publisher ?? 'all'] ?? 0));
    }
  }
  const itemCount = offsets[display.last + 1];
  const publisherPages = new Map<number, PluginMarketItem[]>();
  const pageAt = (index: number) => {
    let low = 0, high = display.last;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (offsets[middle] <= index) low = middle;
      else high = middle - 1;
    }
    return low;
  };
  const filters: PluginCatalogFilter[] = ['all', 'official', 'community'];
  if (showOrganization || filter === 'organization') filters.push('organization');
  if (filter === 'custom' || (cache.metadata ?? display.metadata)?.customSourceNames.length) filters.push('custom');
  // A complete cached catalog can also supply exact totals for older servers.
  const complete = ['public', 'all'].map(source => variants.get(keyFor(source, sort)))
    .find(entry => entry?.metadata && !entry.hasNext && entry.error === null && !entry.metadata.unavailableReason && entry.refreshedRevision === revision);
  function filterCount(value: PluginCatalogFilter) {
    const count = cache.counts?.[value];
    if (count !== undefined || (value !== 'official' && value !== 'community')) return count;
    if (!complete) return cache.counts?.public === 0 ? 0 : undefined;
    return Array.from(complete.sizes.values()).reduce((total, size) => total + size[value], 0);
  }
  const filterLabel = (value: PluginCatalogFilter) => value === 'all'
    ? t('settings.ghosts.page.filterAll') : value === 'official' || value === 'community'
      ? t(`settings.ghosts.market.publisherKind.${value}`) : t(`settings.ghosts.page.origin.${value}`);
  const activeSort = sort && !cache.metadata?.unavailableReason ? activeCatalogSort(display.metadata, online) : undefined;
  const sortOptions = activeSort ? display.metadata?.sorts : undefined;
  // Undefined keeps the legacy row. Null means the active sort supplies no metric.
  const selectedMetric = activeSort ? sortOptions?.find(option => option.key === activeSort)?.metric ?? null : undefined;
  const rowMetric: PluginMarketRowMetric | null | undefined = activeSort === 'downloads' && selectedMetric?.kind === 'count'
    ? { ...selectedMetric, icon: 'download' }
    : selectedMetric;
  const filterMenuClass = 'w-max min-w-[var(--radix-select-trigger-width)] max-w-[var(--radix-select-content-available-width)] [&_[role=option]]:justify-between';
  const filterMetaClass = 'text-right text-12 font-normal tabular-nums text-[var(--text-tertiary)]';
  const sourceCount = filterCount(filter);
  const sourceLabel = t('settings.ghosts.page.filtersAria');
  const filtersView = <>
    <Select
      label={sourceCount === undefined ? sourceLabel : `${sourceLabel} · ${filterLabel(filter)} ${sourceCount}`}
      size="compact"
      className="plugin-catalog-borderless-control"
      value={filter}
      triggerAdornment={sourceCount === undefined ? undefined : (
        <span className="-ml-0.5 font-normal tabular-nums text-[var(--text-tertiary)]">{sourceCount}</span>
      )}
      contentClassName={filterMenuClass}
      options={filters.map(value => {
        const count = filterCount(value);
        return {
          value,
          label: filterLabel(value),
          title: count?.toString(),
          endAdornment: count === undefined ? undefined : <span className={filterMetaClass}>{count}</span>,
        };
      })}
      onValueChange={value => onScope(value as PluginCatalogFilter)}
    />
    {activeSort && sortOptions ? (
      <Select
        label={t('settings.ghosts.page.marketSort.label')}
        size="compact"
        className="plugin-catalog-borderless-control"
        value={activeSort}
        contentClassName={filterMenuClass}
        options={sortOptions.map(({ key, label }) => ({ value: key, label }))}
        onValueChange={value => {
          if (value === requestedSort) return;
          variants.delete(keyFor(scope, value));
          if (scrollRef.current) scrollRef.current.scrollTop = 0;
          setRequestedSort(value);
        }}
      />
    ) : null}
  </>;
  const catalogView = <section hidden={!visible} className="mt-6 min-w-0">
    <CatalogSectionHeader region="market"
      title={t(query.trim() ? 'settings.ghosts.page.marketSection' : 'settings.ghosts.page.allPlugins')}
      controls={!query.trim() && filterHost?.current ? visible ? createPortal(filtersView, filterHost.current) : null : filtersView} />
    {cache.metadata?.unavailableReason ? <p className="mb-4 text-13 text-[var(--text-secondary)]">{t('settings.ghosts.market.unavailable')}</p> : null}
    {cache.metadata?.organizationAccessError ? <p className="mb-4 text-13 text-[var(--text-secondary)]">{t(pluginMarketOrganizationAccessErrorKey(cache.metadata.organizationAccessError)!)}</p> : null}
    {cache.metadata?.unavailableCustomSourceNames.length ? <p className="mb-4 text-13 text-[var(--text-secondary)]">
      {t('settings.ghosts.market.customSourcesUnavailable', { names: cache.metadata.unavailableCustomSourceNames.join(', ') })}</p> : null}
    {showLoading && display === cache ? <div aria-hidden="true" className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,340px),1fr))] gap-4">
      {Array.from({ length: 6 }, (_, index) => <div key={index} className="h-36 rounded-xl bg-[var(--surface-elevated)]" />)}
    </div> : null}
    <PluginVirtualGrid count={itemCount} scrollRef={scrollRef} cache={searchFallback ? cache.grid : display.grid} active={visible}
      groupAt={!searchFallback && display.groups.size > 0 && (display.metadata?.customSourceNames.length ?? 0) > 1 ? index => display.groups.has(index) : undefined}
      renderGroup={index => <header className="flex items-baseline gap-2 px-3.5">
        <h3 className="text-14 font-medium text-[var(--text-primary)]">{display.groups.get(index)}</h3>
        <span className="text-12 tabular-nums text-[var(--text-tertiary)]">{display.metadata?.customSourceCounts?.find(item => item.name === display.groups.get(index))?.count}</span>
      </header>}
      onRange={(first, last) => {
        if (display !== cache) return;
        visiblePages.current = { first: pageAt(first), last: pageAt(last) };
        for (let page = pageAt(first); page <= pageAt(last); page++) {
          if (!cache.pages.has(page) && cache.error !== page) void read(page);
        }
      }} renderItem={index => {
        const page = pageAt(index);
        const items = display.pages.get(page);
        let rows = filteredPreview?.get(page) ?? items;
        if (!filteredPreview && publisher && items) {
          if (!publisherPages.has(page)) publisherPages.set(page, items.filter(row => publicPublisherFilter(row) === publisher));
          rows = publisherPages.get(page);
        }
        const item = rows?.[index - offsets[page]];
        return item ? <CatalogCard item={iconCache ? readReusedMarketIcon(iconCache, item) : item} installState={installStateFor(item)}
          renderItem={renderItem} renderRevision={renderRevision} metric={rowMetric} />
          : <div className="h-36 rounded-xl bg-[var(--surface-elevated)]" aria-hidden="true" />;
      }} />
    <div ref={sentinel} className="flex min-h-12 items-center justify-center gap-3 text-12 text-[var(--text-tertiary)]" aria-live="polite">
      {cache.error !== null ? <><span>{t('settings.ghosts.market.unavailable')}</span>
        <Button size="sm" onClick={() => {
          if (restartingSort) void cache.refresh?.({ force: true, retry: true });
          else { void read(cache.error!); rerender(); }
        }}>{t('commonUi.retry')}</Button></>
        : !cache.metadata ? showLoading ? <><Spinner /><span>{t(query.trim() ? 'settings.ghosts.page.searching' : 'ccAgent.common.loading')}</span></> : null
          : itemCount === 0 ? (publisher && cache.hasNext) || cache.metadata?.organizationAccessError || cache.metadata?.unavailableCustomSourceNames.length ? null : <span>{t('settings.ghosts.page.emptyFiltered')}</span>
            : !cache.hasNext ? <span>{t('settings.ghosts.page.allLoaded', { count: itemCount })}</span> : null}
    </div>
  </section>;
  return <>
    {renderPublicPreview?.(variants.get(keyFor('public', requestedSort, ''))?.pages.get(0) ?? [])}
    {catalogView}
  </>;
}
