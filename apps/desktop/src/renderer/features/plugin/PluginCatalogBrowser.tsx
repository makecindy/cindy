import { useCallback, useEffect, useReducer, useRef, type ReactNode, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Spinner } from '@/components/ui/spinner';
import { extractIpcError } from '@/utils/ipcError';
import type { PluginMarketCounts, PluginMarketItem, PluginMarketPage, PluginMarketQuery } from '../../../shared/pluginMarket';
import { PluginVirtualGrid, emptyPluginGridCache, type PluginGridCache } from './PluginVirtualGrid';
import { pluginMarketOrganizationAccessErrorKey } from './lib/pluginMarketErrorKey';

export const PLUGIN_PAGE_SIZE = 10;

export interface PluginBrowserCache {
  key: string;
  countsKey: string;
  pages: Map<number, PluginMarketItem[]>;
  cursors: Map<number, string | null>;
  sizes: Map<number, number>;
  last: number;
  hasNext: boolean;
  counts: PluginMarketCounts | null;
  metadata: PluginMarketPage | null;
  error: number | null;
  grid: PluginGridCache;
  groups: Map<number, string>;
  lastSource: Map<number, string | null>;
}
export function emptyPluginBrowserCache(key = '', countsKey = ''): PluginBrowserCache {
  return { key, countsKey, pages: new Map(), cursors: new Map([[0, null]]), sizes: new Map(), last: 0,
    hasNext: false, counts: null, metadata: null, error: null, grid: emptyPluginGridCache(), groups: new Map(), lastSource: new Map() };
}

/** Cursor metadata survives detail navigation; only six pages of summaries stay resident. */
export function PluginCatalogBrowser({ cacheRef, ownerKey, revision, query, scope, onScope, showOrganization,
  visible, scrollRef, loadPage, renderItem, onCounts, filterHost }: {
  cacheRef: RefObject<PluginBrowserCache>;
  ownerKey: string;
  revision: string;
  query: string;
  scope: NonNullable<PluginMarketQuery['scope']>;
  onScope(scope: NonNullable<PluginMarketQuery['scope']>): void;
  showOrganization: boolean;
  visible: boolean;
  scrollRef: RefObject<HTMLElement | null>;
  loadPage(input: PluginMarketQuery): Promise<PluginMarketPage>;
  renderItem(item: PluginMarketItem): ReactNode;
  onCounts?(counts: PluginMarketCounts | null): void;
  filterHost?: RefObject<HTMLDivElement | null>;
}) {
  const { t } = useTranslation();
  const [, rerender] = useReducer(n => n + 1, 0);
  const countsKey = JSON.stringify([ownerKey, revision, query.trim()]);
  const key = JSON.stringify([PLUGIN_PAGE_SIZE, ownerKey, revision, query.trim(), scope]);
  if (cacheRef.current.key !== key) {
    const counts = cacheRef.current.countsKey === countsKey ? cacheRef.current.counts : null;
    cacheRef.current = { ...emptyPluginBrowserCache(key, countsKey), counts };
  }
  const cache = cacheRef.current;
  const inFlight = useRef(new Map<string, { cache: PluginBrowserCache; promise: Promise<void> }>());
  const readQueue = useRef<Promise<void>>(Promise.resolve());
  const alive = useRef(true);
  const loader = useRef(loadPage);
  loader.current = loadPage;
  const countListener = useRef(onCounts);
  countListener.current = onCounts;
  const read = useCallback((index: number): Promise<void> => {
    const current = cacheRef.current;
    const flightKey = `${current.key}:${index}`;
    const existing = inFlight.current.get(flightKey);
    if (existing?.cache === current) return existing.promise;
    if (!current.cursors.has(index)) return Promise.resolve();
    const previous = readQueue.current;
    const request = (async () => {
      try {
        await previous;
        // A slow count must not fan out more obsolete searches while the user types.
        if (!alive.current || cacheRef.current !== current) return;
        const page = await loader.current({ query: query.trim().slice(0, 100), scope,
          cursor: current.cursors.get(index), limit: PLUGIN_PAGE_SIZE, excludeInstalled: !!query.trim(),
          counts: index === 0 && current.counts === null });
        if (!alive.current || cacheRef.current !== current) return;
        current.pages.delete(index);
        current.pages.set(index, page.items);
        if (scope === 'custom') {
          let previous = current.lastSource.get(index - 1) ?? null;
          let start = 0;
          for (let page = 0; page < index; page++) start += current.sizes.get(page) ?? 0;
          page.items.forEach((item, offset) => {
            if (item.sourceMarketName && item.sourceMarketName !== previous) current.groups.set(start + offset, item.sourceMarketName);
            previous = item.sourceMarketName;
          });
          current.lastSource.set(index, previous);
        }
        while (current.pages.size > 6) current.pages.delete(current.pages.keys().next().value!);
        current.sizes.set(index, page.items.length);
        if (index >= current.last) { current.last = index; current.hasNext = page.nextCursor !== null; }
        if (page.nextCursor) current.cursors.set(index + 1, page.nextCursor);
        if (page.counts) { current.counts = page.counts; countListener.current?.(page.counts); }
        current.metadata = { ...page, items: [], unavailableCustomSourceNames: index > 0
          ? [...new Set([...(current.metadata?.unavailableCustomSourceNames ?? []), ...page.unavailableCustomSourceNames])]
          : page.unavailableCustomSourceNames };
        current.error = page.unavailableReason ? index : null;
      } catch (error) {
        if (!alive.current || cacheRef.current !== current) return;
        if (index > 0 && extractIpcError(error)?.code === 'PLUGIN_LIST_CHANGED') {
          cacheRef.current = emptyPluginBrowserCache(current.key, current.countsKey);
          void read(0);
        } else current.error = index;
      } finally {
        if (inFlight.current.get(flightKey)?.cache === current) inFlight.current.delete(flightKey);
        if (alive.current) rerender();
      }
    })();
    readQueue.current = request;
    inFlight.current.set(flightKey, { cache: current, promise: request });
    return request;
  }, [cacheRef, query, scope]);
  useEffect(() => {
    alive.current = true;
    if (!visible) return () => { alive.current = false; };
    if (!cacheRef.current.metadata) {
      countListener.current?.(cacheRef.current.counts);
      const timer = setTimeout(() => { void read(0); rerender(); }, query.trim() ? 250 : 0);
      return () => { clearTimeout(timer); alive.current = false; };
    }
    countListener.current?.(cacheRef.current.counts);
    return () => { alive.current = false; };
  }, [key, cacheRef, read, visible]);
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!visible || !cache.hasNext || cache.error !== null || !sentinel.current || !scrollRef.current) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { void read(cache.last + 1); rerender(); }
    }, { root: scrollRef.current, rootMargin: '80px' });
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [visible, cache.hasNext, cache.last, cache.error, scrollRef, read]);
  if (!visible) return null;
  // Filtering installed matches can leave short or empty cursor pages.
  const offsets = [0];
  for (let page = 0; page <= cache.last; page++) offsets.push(offsets[page] + (cache.sizes.get(page) ?? 0));
  const count = offsets[cache.last + 1];
  const pageAt = (index: number) => {
    let low = 0, high = cache.last;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (offsets[middle] <= index) low = middle;
      else high = middle - 1;
    }
    return low;
  };
  const pending = [...inFlight.current.keys()].some(value => value.startsWith(`${key}:`));
  const filters = (['all', 'public', ...(showOrganization ? ['organization'] : []),
    ...(cache.metadata?.customSourceNames.length ? ['custom'] : [])] as NonNullable<PluginMarketQuery['scope']>[]);
  const filtersView = <SegmentedControl value={scope} onValueChange={onScope} height={32} optionHeight={28}
        aria-label={t('settings.ghosts.page.filtersAria')}
        options={filters.map(filter => ({ value: filter, label: <>{filter === 'all'
          ? t('settings.ghosts.page.filterAll') : t(`settings.ghosts.page.origin.${filter}`)}
          {cache.counts ? <span className="ml-1.5 tabular-nums text-[var(--text-tertiary)]">{cache.counts[filter]}</span> : null}</> }))} />;
  return <section className="mt-6 min-w-0">
    {!query.trim() && filterHost?.current ? createPortal(filtersView, filterHost.current) : query.trim() ? (
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-20 font-medium text-[var(--text-primary)]">{t('settings.ghosts.page.marketSection')}</h2>
        {filtersView}
      </div>
    ) : filterHost ? null : <div className="mb-4">{filtersView}</div>}
    {cache.metadata?.unavailableReason ? <p className="mb-4 text-13 text-[var(--text-secondary)]">{t('settings.ghosts.market.unavailable')}</p> : null}
    {cache.metadata?.organizationAccessError ? <p className="mb-4 text-13 text-[var(--text-secondary)]">{t(pluginMarketOrganizationAccessErrorKey(cache.metadata.organizationAccessError)!)}</p> : null}
    {cache.metadata?.unavailableCustomSourceNames.length ? <p className="mb-4 text-13 text-[var(--text-secondary)]">
      {t('settings.ghosts.market.customSourcesUnavailable', { names: cache.metadata.unavailableCustomSourceNames.join(', ') })}</p> : null}
    <PluginVirtualGrid count={count} scrollRef={scrollRef} cache={cache.grid}
      groupAt={scope === 'custom' && (cache.metadata?.customSourceNames.length ?? 0) > 1 ? index => cache.groups.has(index) : undefined}
      renderGroup={index => <header className="flex items-baseline gap-2">
        <h3 className="text-14 font-medium text-[var(--text-primary)]">{cache.groups.get(index)}</h3>
        <span className="text-12 tabular-nums text-[var(--text-tertiary)]">{cache.metadata?.customSourceCounts?.find(item => item.name === cache.groups.get(index))?.count}</span>
      </header>}
      onRange={(first, last) => {
        for (let page = pageAt(first); page <= pageAt(last); page++) {
          if (!cache.pages.has(page) && cache.error !== page) void read(page);
        }
      }} renderItem={index => {
        const page = pageAt(index);
        const item = cache.pages.get(page)?.[index - offsets[page]];
        return item ? renderItem(item) : <div className="flex h-40 items-center justify-center"><Spinner /></div>;
      }} />
    <div ref={sentinel} className="flex min-h-12 items-center justify-center gap-3 text-12 text-[var(--text-tertiary)]" aria-live="polite">
      {cache.error !== null ? <><span>{t('settings.ghosts.market.unavailable')}</span>
        <Button size="sm" onClick={() => { void read(cache.error!); rerender(); }}>{t('commonUi.retry')}</Button></>
        : pending || !cache.metadata ? <><Spinner /><span>{t(query.trim() ? 'settings.ghosts.page.searching' : 'common.loading')}</span></>
          : count === 0 ? cache.metadata?.organizationAccessError || cache.metadata?.unavailableCustomSourceNames.length ? null : <span>{t('settings.ghosts.page.emptyFiltered')}</span>
            : !cache.hasNext ? <span>{t('settings.ghosts.page.allLoaded', { count })}</span> : null}
    </div>
  </section>;
}
