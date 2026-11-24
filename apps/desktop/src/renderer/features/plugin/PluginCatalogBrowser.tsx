import { memo, useCallback, useEffect, useLayoutEffect, useReducer, useRef, type ReactNode, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Spinner } from '@/components/ui/spinner';
import { extractIpcError } from '@/utils/ipcError';
import type { PluginMarketCounts, PluginMarketItem, PluginMarketPage, PluginMarketQuery } from '../../../shared/pluginMarket';
import type { InstalledGhost } from '../../../shared/ghost';
import { marketItemMatchesInstalledGhost, publicPublisherFilter, type PluginCatalogFilter } from './lib/pluginMarketPresentation';
import { PluginVirtualGrid } from './PluginVirtualGrid';
import { pluginMarketOrganizationAccessErrorKey } from './lib/pluginMarketErrorKey';
import { emptyPluginBrowserCache, mergePluginItems, pluginBrowserKey, pluginCatalogPageLimit, pluginPageSize, samePluginValue,
  PLUGIN_CACHED_PAGES, PLUGIN_CATALOG_REFRESH_MS, type PluginBrowserCache } from './lib/pluginBrowserCache';
export { emptyPluginBrowserCache, PLUGIN_PAGE_SIZE, type PluginBrowserCache } from './lib/pluginBrowserCache';
import { readPluginCatalogAnchor, restorePluginCatalogAnchor, type PluginCatalogAnchor } from './lib/pluginCatalogAnchor';
import { useDelayedPluginLoading } from './lib/useDelayedPluginLoading';
import { mergePluginSnapshot } from './lib/pluginCatalogMemory';

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

const CatalogCard = memo(function CatalogCard({ item, renderItem }: {
  item: PluginMarketItem; renderItem(item: PluginMarketItem): ReactNode; renderRevision?: unknown;
}) {
  return <div data-plugin-id={item.pluginId}>{renderItem(item)}</div>;
}, (previous, next) => previous.item === next.item && previous.renderRevision === next.renderRevision);

/** Cursor metadata survives detail navigation; only six pages of summaries stay resident. */
export function PluginCatalogBrowser({ cacheRef, ownerKey, revision, catalogKey = '', installedItems, installedGhosts, query, scope: filter, onScope, showOrganization, prewarm = false,
  visible, scrollRef, loadPage, renderItem, renderRevision, onCounts, filterHost }: {
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
  renderItem(item: PluginMarketItem): ReactNode;
  renderRevision?: unknown;
  onCounts?(counts: PluginMarketCounts | null): void;
  filterHost?: RefObject<HTMLDivElement | null>;
}) {
  const { t } = useTranslation();
  const [, rerender] = useReducer(n => n + 1, 0);
  const publisher = filter === 'official' || filter === 'community' ? filter : undefined;
  const scope = filter === 'official' || filter === 'community' ? 'public' : filter;
  const pageLimit = pluginCatalogPageLimit(scope, query);
  const countsKey = JSON.stringify([ownerKey, catalogKey, query.trim()]);
  const key = pluginBrowserKey(ownerKey, catalogKey, query, scope);
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
  const showLoading = useDelayedPluginLoading(visible && cache.metadata === null && cache.error === null);
  const isInstalled = useRef<(item: PluginMarketItem) => boolean>(() => false);
  isInstalled.current = item => installedGhosts !== undefined
    ? installedGhosts.some(ghost => ghost.publishingSource?.kind === 'public-market'
      && ghost.publishingSource.pluginId === item.pluginId && marketItemMatchesInstalledGhost(item, ghost))
    : ['installed', 'update-available'].includes((installedItems?.find(row => row.pluginId === item.pluginId) ?? item).installState);
  const anchor = useRef<PluginCatalogAnchor | null>(null);
  const restartCursors = useRef(false);
  const visiblePages = useRef({ first: 0, last: 0 });
  useLayoutEffect(() => {
    if (scrollRef.current && anchor.current) restorePluginCatalogAnchor(scrollRef.current, anchor.current);
    anchor.current = null;
  });
  useLayoutEffect(() => {
    const saved = scrollRef.current ? readPluginCatalogAnchor(scrollRef.current) : null;
    let changed = false;
    for (const resident of new Set([cache, display])) {
      let removed = false;
      for (const [index, items] of resident.pages) {
        const next = items.filter(item => !isInstalled.current(item));
        if (next.length === items.length) continue;
        resident.pages.set(index, next); resident.sizes.set(index, pluginPageSize(next)); removed = true;
      }
      if (removed) {
        if (saved) resident.grid.restore = { anchor: saved };
        changed = true;
      }
    }
    if (changed) { anchor.current = saved; rerender(); }
  }, [cache, display, installedItems, installedGhosts, scrollRef]);
  const inFlight = useRef(new Map<string, { cache: PluginBrowserCache; promise: Promise<void> }>());
  const readQueue = useRef<Promise<void>>(Promise.resolve());
  const alive = useRef(true);
  const loader = useRef(loadPage);
  loader.current = loadPage;
  const latestRevision = useRef(revision);
  latestRevision.current = revision;
  const countListener = useRef(onCounts);
  countListener.current = onCounts;
  const read = useCallback((index: number): Promise<void> => {
    const current = cacheRef.current;
    const flightKey = `${current.key}:${index}`;
    const existing = inFlight.current.get(flightKey);
    if (existing?.cache === current) return existing.promise;
    if (!current.cursors.has(index)) return Promise.resolve();
    const previous = readQueue.current;
    let requestedRevision: string | undefined;
    const request = (async () => {
      try {
        await previous;
        // A slow count must not fan out more obsolete searches while the user types.
        if (!alive.current || cacheRef.current !== current) return;
        requestedRevision = latestRevision.current;
        const response = await (index === 0 && current.firstPageFlight ? current.firstPageFlight : loader.current({ query: query.trim().slice(0, 100), scope,
          cursor: current.cursors.get(index), limit: pageLimit, excludeInstalled: true,
          counts: false }));
        if (index === 0) current.firstPageFlight = undefined;
        if (!alive.current || cacheRef.current !== current || requestedRevision !== latestRevision.current) return;
        const initial = current.metadata === null;
        const prior = current.pages.get(index);
        const page = { ...response, items: mergePluginSnapshot(prior && current.metadata ? { ...current.metadata, items: prior } : null,
          response).items.filter(item => !isInstalled.current(item)) };
        const previousItems = current.pages.get(index) ?? (index === 0 && displayed.current.partitionKey === partitionKey
          ? [...displayed.current.pages.values()].flat() : []);
        current.pages.delete(index);
        current.pages.set(index, mergePluginItems(previousItems, page.items));
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
        while (current.pages.size > PLUGIN_CACHED_PAGES) current.pages.delete(current.pages.keys().next().value!);
        current.sizes.set(index, pluginPageSize(page.items));
        if (index >= current.last) { current.last = index; current.hasNext = page.nextCursor !== null; }
        if (page.nextCursor) current.cursors.set(index + 1, page.nextCursor);
        if (page.counts) { current.counts = page.counts; countListener.current?.(page.counts); }
        current.metadata = { ...page, items: [], unavailableCustomSourceNames: index > 0
          ? [...new Set([...(current.metadata?.unavailableCustomSourceNames ?? []), ...page.unavailableCustomSourceNames])]
          : page.unavailableCustomSourceNames };
        current.error = page.unavailableReason && page.items.length === 0 ? index : null;
        dedupeCachedPages(current);
        if (initial) { current.refreshedRevision = requestedRevision; current.refreshedAt = Date.now(); }
      } catch (error) {
        if (index === 0) current.firstPageFlight = undefined;
        if (!alive.current || cacheRef.current !== current || requestedRevision !== latestRevision.current) return;
        if (index > 0 && extractIpcError(error)?.code === 'PLUGIN_LIST_CHANGED') {
          current.refreshedRevision = undefined;
          restartCursors.current = true;
          void current.refresh?.({ force: true });
        } else current.error = index;
      } finally {
        if (inFlight.current.get(flightKey)?.cache === current) inFlight.current.delete(flightKey);
        if (alive.current) rerender();
        if (alive.current && cacheRef.current === current && requestedRevision !== undefined && requestedRevision !== latestRevision.current) {
          void current.refresh?.({ force: true });
        }
      }
    })();
    readQueue.current = request;
    inFlight.current.set(flightKey, { cache: current, promise: request });
    return request;
  }, [cacheRef, query, scope, partitionKey, pageLimit]);
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
          excludeInstalled: true, counts: true }));
        if (!alive.current || cacheRef.current !== cache || requestedRevision !== latestRevision.current) return;
        cache.countsKey = countsKey; cache.countsAt = Date.now(); cache.countsFlight = undefined;
        if (page.counts && !samePluginValue(cache.counts, page.counts)) {
          cache.counts = page.counts; countListener.current?.(page.counts); rerender();
        }
      } catch { cache.countsFlight = undefined; /* Counts never hide usable cards. */ }
    })();
    countQueue.current = flight;
    await flight;
  }, [cache, cacheRef, countsKey, query]);
  const refreshFlight = useRef<{ cache: PluginBrowserCache; revision: string; promise: Promise<void> } | null>(null);
  useEffect(() => {
    if (!visible && !prewarm) return;
    let active = true;
    const current = () => active && alive.current && cacheRef.current === cache;
    const refresh = async (options?: { force?: boolean; renewIcons?: boolean }) => {
      if (!current()) return;
      const pending = refreshFlight.current;
      if (pending?.cache === cache) {
        await pending.promise;
        // Reuse the flight as the queue: only invalidations newer than that
        // read need a follow-up. Concurrent callers join that one latest read.
        if (current() && pending.revision !== latestRevision.current && cache.refreshedRevision !== latestRevision.current) {
          await refresh({ ...options, force: true });
        } else if (current() && options?.renewIcons) {
          for (const [index, items] of cache.pages)
            cache.pages.set(index, items.map(item => item.icon ? { ...item, icon: { ...item.icon } } : item));
          rerender();
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
        const pages = new Map<number, PluginMarketPage>();
        const rebuiltSizes: PluginBrowserCache['sizes'] = new Map();
        const rebuiltCursors = new Map<number, string | null>([[0, null]]);
        const previousPages = new Map(cache.pages);
        const previousOffsets = [0];
        for (let index = 0; index <= cache.last; index++) previousOffsets.push(previousOffsets[index] + (cache.sizes.get(index)?.all ?? 0));
        let rebuilt = false;
        let rebuiltHasNext = false;
        try {
          if (restartCursors.current) throw new Error('[PLUGIN_LIST_CHANGED] Plugin cursor changed');
          // Rebuild off-screen. An invalid cursor restarts this bounded resident
          // window from the beginning; visible batches stay intact until ready.
          for (const index of [...cache.pages.keys()].sort((a, b) => a - b)) {
            if (!coversRevision()) return;
            pages.set(index, await loader.current({ query: query.trim().slice(0, 100), scope,
              cursor: cache.cursors.get(index), limit: pageLimit, excludeInstalled: true, counts: false }));
            if (!coversRevision()) return;
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
            while (pages.size > PLUGIN_CACHED_PAGES) {
              const distance = (index: number) => Math.max(first - index, index - last, 0);
              const farthest = [...pages.keys()].reduce((a, b) => distance(a) > distance(b) ? a : b);
              pages.delete(farthest);
            }
          };
          let cursor: string | null = null;
          // Walk only as far as the user had loaded, plus the failed next page.
          // Keep six batches resident while rebuilding cursor metadata.
          for (let index = 0; index <= cache.last + 1; index++) {
            if (!coversRevision()) return;
            const page = await loader.current({ query: query.trim().slice(0, 100), scope,
              cursor, limit: pageLimit, excludeInstalled: true, counts: false });
            if (!coversRevision()) return;
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
            pages.set(index, await loader.current({ query: query.trim().slice(0, 100), scope,
              cursor: rebuiltCursors.get(index), limit: pageLimit, excludeInstalled: true, counts: false }));
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
        for (const [index, page] of pages) {
          const previous = previousPages.get(index) ?? [];
          const next = mergePluginSnapshot(cache.metadata ? { ...cache.metadata, items: previous } : null,
            page, options?.renewIcons).items.filter(item => !isInstalled.current(item));
          const merged = mergePluginItems(previous, next, options?.renewIcons);
          if (rebuilt || merged !== previous) { cache.pages.set(index, merged); cache.sizes.set(index, pluginPageSize(merged)); changed = true; }
          if (page.nextCursor) cache.cursors.set(index + 1, page.nextCursor);
          if (index === cache.last && cache.hasNext !== (page.nextCursor !== null)) { cache.hasNext = page.nextCursor !== null; changed = true; }
        }
        while (cache.pages.size > PLUGIN_CACHED_PAGES) cache.pages.delete(cache.pages.keys().next().value!);
        if (dedupeCachedPages(cache)) changed = true;
        const fresh = pages.values().next().value;
        if (fresh && cache.metadata) {
          const metadata = { ...cache.metadata, customSourceNames: fresh.customSourceNames,
            customSourceCounts: fresh.customSourceCounts, organizationAccessError: fresh.organizationAccessError,
            unavailableReason: fresh.unavailableReason,
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
      refreshFlight.current = { cache, revision: latestRevision.current, promise: flight };
      await flight;
    };
    if (cache.metadata && cache.refreshedRevision !== latestRevision.current) { cache.countsAt = 0; cache.countsFlight = undefined; }
    cache.refresh = async options => { await Promise.all([refresh(options), Date.now() - cache.countsAt >= PLUGIN_CATALOG_REFRESH_MS ? count() : Promise.resolve()]); };
    const timer = setTimeout(() => {
      if (cache.countsFlight || cache.countsKey !== countsKey || Date.now() - cache.countsAt >= PLUGIN_CATALOG_REFRESH_MS) void count();
      void refresh();
    }, query.trim() ? 250 : 0);
    return () => {
      active = false;
      clearTimeout(timer); cache.refresh = undefined;
      if (refreshFlight.current?.cache === cache) refreshFlight.current = null;
    };
  }, [cache, countsKey, query, scope, pageLimit, visible, prewarm, count, scrollRef, read]);
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
  useEffect(() => {
    if (!visible || !cache.hasNext || cache.error !== null || !sentinel.current || !scrollRef.current) return;
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
  }, [visible, scope, query, publicTotal, hasPublisherCounts, pageLimit, cache, cacheRef, cache.hasNext, cache.last, cache.error, cache.metadata?.unavailableReason, scrollRef, read]);
  // Filtering installed matches can leave short or empty cursor pages.
  const offsets = [0];
  for (let page = 0; page <= display.last; page++) offsets.push(offsets[page] + (display.sizes.get(page)?.[publisher ?? 'all'] ?? 0));
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
  if (showOrganization) filters.push('organization');
  if ((cache.metadata ?? display.metadata)?.customSourceNames.length) filters.push('custom');
  // A complete cached catalog can also supply exact totals for older servers.
  const complete = ['public', 'all'].map(source => variants.get(pluginBrowserKey(ownerKey, catalogKey, query, source)))
    .find(entry => entry?.metadata && !entry.hasNext && entry.error === null && !entry.metadata.unavailableReason && entry.refreshedRevision === revision);
  function filterCount(value: PluginCatalogFilter) {
    const count = cache.counts?.[value];
    if (count !== undefined || (value !== 'official' && value !== 'community')) return count;
    if (!complete) return cache.counts?.public === 0 ? 0 : undefined;
    return Array.from(complete.sizes.values()).reduce((total, size) => total + size[value], 0);
  }
  const filtersView = <SegmentedControl value={filter} onValueChange={onScope} height={32} optionHeight={28}
        aria-label={t('settings.ghosts.page.filtersAria')}
        options={filters.map(value => ({ value, label: <>{value === 'all'
          ? t('settings.ghosts.page.filterAll') : value === 'official' || value === 'community'
            ? t(`settings.ghosts.market.publisherKind.${value}`) : t(`settings.ghosts.page.origin.${value}`)}
          <span className="ml-1.5 inline-block min-w-[3ch] text-right tabular-nums text-[var(--text-tertiary)]">{filterCount(value) ?? '\u00a0'}</span></> }))} />;
  return <section hidden={!visible} className="mt-6 min-w-0">
    {!query.trim() && filterHost?.current ? visible ? createPortal(filtersView, filterHost.current) : null : query.trim() ? (
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-20 font-medium text-[var(--text-primary)]">{t('settings.ghosts.page.marketSection')}</h2>
        {filtersView}
      </div>
    ) : filterHost ? null : <div className="mb-4">{filtersView}</div>}
    {cache.metadata?.unavailableReason ? <p className="mb-4 text-13 text-[var(--text-secondary)]">{t('settings.ghosts.market.unavailable')}</p> : null}
    {cache.metadata?.organizationAccessError ? <p className="mb-4 text-13 text-[var(--text-secondary)]">{t(pluginMarketOrganizationAccessErrorKey(cache.metadata.organizationAccessError)!)}</p> : null}
    {cache.metadata?.unavailableCustomSourceNames.length ? <p className="mb-4 text-13 text-[var(--text-secondary)]">
      {t('settings.ghosts.market.customSourcesUnavailable', { names: cache.metadata.unavailableCustomSourceNames.join(', ') })}</p> : null}
    {showLoading && display === cache ? <div aria-hidden="true" className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,340px),1fr))] gap-4">
      {Array.from({ length: 6 }, (_, index) => <div key={index} className="h-36 rounded-xl bg-[var(--surface-elevated)]" />)}
    </div> : null}
    <PluginVirtualGrid count={itemCount} scrollRef={scrollRef} cache={display.grid} active={visible}
      groupAt={display.groups.size > 0 && (display.metadata?.customSourceNames.length ?? 0) > 1 ? index => display.groups.has(index) : undefined}
      renderGroup={index => <header className="flex items-baseline gap-2">
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
        let rows = items;
        if (publisher && items) {
          if (!publisherPages.has(page)) publisherPages.set(page, items.filter(row => publicPublisherFilter(row) === publisher));
          rows = publisherPages.get(page);
        }
        const item = rows?.[index - offsets[page]];
        return item ? <CatalogCard item={item} renderItem={renderItem} renderRevision={renderRevision} />
          : <div className="h-36 rounded-xl bg-[var(--surface-elevated)]" aria-hidden="true" />;
      }} />
    <div ref={sentinel} className="flex min-h-12 items-center justify-center gap-3 text-12 text-[var(--text-tertiary)]" aria-live="polite">
      {cache.error !== null ? <><span>{t('settings.ghosts.market.unavailable')}</span>
        <Button size="sm" onClick={() => { void read(cache.error!); rerender(); }}>{t('commonUi.retry')}</Button></>
        : !cache.metadata ? showLoading ? <><Spinner /><span>{t(query.trim() ? 'settings.ghosts.page.searching' : 'ccAgent.common.loading')}</span></> : null
          : itemCount === 0 ? (publisher && cache.hasNext) || cache.metadata?.organizationAccessError || cache.metadata?.unavailableCustomSourceNames.length ? null : <span>{t('settings.ghosts.page.emptyFiltered')}</span>
            : !cache.hasNext ? <span>{t('settings.ghosts.page.allLoaded', { count: itemCount })}</span> : null}
    </div>
  </section>;
}
