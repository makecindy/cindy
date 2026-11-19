import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { elementScroll, observeElementOffset, useVirtualizer, type VirtualItem, type Virtualizer } from '@tanstack/react-virtual';
import { readPluginCatalogAnchor, restorePluginCatalogAnchor, type PluginCatalogAnchor } from './lib/pluginCatalogAnchor';

export interface PluginGridCache {
  columns: number; measurements: VirtualItem[]; offset?: number;
  restore?: { anchor: PluginCatalogAnchor; index?: number };
}
export const emptyPluginGridCache = (): PluginGridCache => ({ columns: 2, measurements: [] });

/** Virtualize rows within the existing catalog scroller, including its header offset. */
export function PluginVirtualGrid({ count, scrollRef, renderItem, onRange, cache, groupAt, renderGroup, active = true }: {
  count: number;
  active?: boolean;
  scrollRef: RefObject<HTMLElement | null>;
  renderItem(index: number): ReactNode;
  onRange?(first: number, last: number): void;
  cache?: PluginGridCache;
  groupAt?(index: number): boolean;
  renderGroup?(index: number): ReactNode;
}) {
  // Commit the grid node through state so the next layout pass can also see
  // the ancestor scroller's ref when both mount together after detail.
  const [grid, setGrid] = useState<HTMLDivElement | null>(null);
  const [columns, setColumns] = useState(cache?.columns ?? 2);
  const [margin, setMargin] = useState(0);
  useLayoutEffect(() => {
    const element = grid;
    const scroller = scrollRef.current;
    if (!element || !scroller || !active) return;
    const update = () => {
      setColumns(Math.max(1, Math.min(2, Math.floor((element.clientWidth + 16) / 360))));
      setMargin(element.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [grid, scrollRef, count, active]);
  const groups = useMemo(() => {
    if (!groupAt) return null;
    const result: Array<{ header?: number; items: number[] }> = [];
    let current: number[] = [];
    for (let index = 0; index < count; index++) {
      if (groupAt(index)) {
        if (current.length) result.push({ items: current });
        current = [];
        result.push({ header: index, items: [] });
      }
      current.push(index);
      if (current.length === columns) { result.push({ items: current }); current = []; }
    }
    if (current.length) result.push({ items: current });
    return result;
  }, [groupAt, count, columns]);
  const activity = useRef(active);
  activity.current = active;
  const offsetCallback = useRef<((offset: number, scrolling: boolean) => void) | null>(null);
  // Both tabs share MAIN. Keep its subscription for the grid's whole lifetime;
  // virtual-core does not resubscribe when an observer option changes.
  const offsetObserver = useCallback((instance: Virtualizer<HTMLElement, HTMLElement>, callback: (offset: number, scrolling: boolean) => void) => {
    offsetCallback.current = callback;
    const stop = observeElementOffset(instance, (offset, scrolling) => { if (activity.current) callback(offset, scrolling); });
    return () => { offsetCallback.current = null; stop?.(); };
  }, []);
  const scrollTo = useCallback((offset: number, options: Parameters<typeof elementScroll>[1], instance: Virtualizer<HTMLElement, HTMLElement>) => {
    if (activity.current) elementScroll(offset, options, instance);
  }, []);
  const rows = useVirtualizer({ count: groups?.length ?? Math.ceil(count / columns), getScrollElement: () => scrollRef.current,
    observeElementOffset: offsetObserver, scrollToFn: scrollTo, useCachedMeasurements: !active,
    estimateSize: index => groups?.[index]?.header !== undefined ? 40 : 150, overscan: 2, scrollMargin: margin,
    initialOffset: cache?.offset ?? 0,
    onChange: instance => { if (active && cache) cache.offset = instance.scrollOffset ?? 0; },
    initialMeasurementsCache: cache?.measurements });
  const wasActive = useRef(active);
  useLayoutEffect(() => {
    const resume = active && !wasActive.current;
    wasActive.current = active;
    const root = scrollRef.current;
    if (!resume || !root) return;
    if (cache?.offset !== undefined) root.scrollTop = cache.offset;
    offsetCallback.current?.(root.scrollTop, false);
  }, [active, cache, scrollRef]);
  const previousColumns = useRef(columns);
  useLayoutEffect(() => {
    // Source/query changes reuse the same measured rows. Resetting them on a
    // cache switch replaces real heights with estimates until another resize.
    if (previousColumns.current !== columns) rows.measure();
    previousColumns.current = columns;
  }, [columns, rows]);
  const currentColumns = useRef(columns);
  currentColumns.current = columns;
  useLayoutEffect(() => () => {
    if (cache) {
      cache.columns = currentColumns.current; cache.measurements = rows.takeSnapshot();
      const anchor = scrollRef.current && readPluginCatalogAnchor(scrollRef.current);
      if (anchor) cache.restore = { anchor };
    }
  }, [cache, rows]);
  const visible = rows.getVirtualItems();
  useLayoutEffect(() => {
    const pending = cache?.restore, root = scrollRef.current;
    if (!active || !pending || !root) return;
    if (restorePluginCatalogAnchor(root, pending.anchor)) delete cache!.restore;
    else if (pending.index !== undefined) {
      const row = groups ? groups.findIndex(group => group.items.includes(pending.index!)) : Math.floor(pending.index / columns);
      if (row >= 0) rows.scrollToIndex(row, { align: 'start' });
    }
  });
  const indices = (row: number) => groups?.[row]?.items ?? Array.from({ length: Math.min(columns, count - row * columns) }, (_, column) => row * columns + column);
  const range = useRef(onRange);
  range.current = onRange;
  useLayoutEffect(() => {
    const items = visible.flatMap(row => indices(row.index));
    if (active && items.length) range.current?.(items[0]!, items.at(-1)!);
  }, [active, visible[0]?.index, visible.at(-1)?.index, columns, count, cache]);
  return <div ref={setGrid} style={{ height: rows.getTotalSize(), position: 'relative', width: '100%' }}>
    {visible.map(row => <div key={row.key} ref={rows.measureElement} data-index={row.index}
      style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${row.start - margin}px)`,
        display: 'grid', gridTemplateColumns: groups?.[row.index]?.header !== undefined ? '1fr' : `repeat(${columns}, minmax(0, 1fr))`, gap: 16, paddingBottom: 16 }}>
      {groups?.[row.index]?.header !== undefined ? renderGroup?.(groups[row.index]!.header!) : indices(row.index).map(index =>
        <div key={index} className="min-w-0">{renderItem(index)}</div>)}
    </div>)}
  </div>;
}
