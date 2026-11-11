import { Fragment, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useVirtualizer, type VirtualItem } from '@tanstack/react-virtual';

export interface PluginGridCache { columns: number; measurements: VirtualItem[]; offset?: number }
export const emptyPluginGridCache = (): PluginGridCache => ({ columns: 2, measurements: [] });

/** Virtualize rows within the existing catalog scroller, including its header offset. */
export function PluginVirtualGrid({ count, scrollRef, renderItem, onRange, cache, groupAt, renderGroup }: {
  count: number;
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
    if (!element || !scroller) return;
    const update = () => {
      setColumns(Math.max(1, Math.min(2, Math.floor((element.clientWidth + 16) / 360))));
      setMargin(element.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [grid, scrollRef, count]);
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
  const rows = useVirtualizer({ count: groups?.length ?? Math.ceil(count / columns), getScrollElement: () => scrollRef.current,
    estimateSize: index => groups?.[index]?.header !== undefined ? 40 : 150, overscan: 2, scrollMargin: margin,
    initialOffset: cache?.offset ?? 0,
    onChange: instance => { if (cache) cache.offset = instance.scrollOffset ?? 0; },
    initialMeasurementsCache: cache?.measurements });
  const previous = useRef({ cache, columns });
  useLayoutEffect(() => {
    if (previous.current.cache !== cache || previous.current.columns !== columns) rows.measure();
    previous.current = { cache, columns };
  }, [cache, columns, rows]);
  const currentColumns = useRef(columns);
  currentColumns.current = columns;
  useLayoutEffect(() => () => {
    if (cache) { cache.columns = currentColumns.current; cache.measurements = rows.takeSnapshot(); }
  }, [cache, rows]);
  const visible = rows.getVirtualItems();
  const indices = (row: number) => groups?.[row]?.items ?? Array.from({ length: Math.min(columns, count - row * columns) }, (_, column) => row * columns + column);
  const range = useRef(onRange);
  range.current = onRange;
  useLayoutEffect(() => {
    const items = visible.flatMap(row => indices(row.index));
    if (items.length) range.current?.(items[0]!, items.at(-1)!);
  }, [visible[0]?.index, visible.at(-1)?.index, columns, count]);
  if (!visible.length && count > 0) return <div ref={setGrid} style={{ height: rows.getTotalSize(), position: 'relative', width: '100%' }}>
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gap: 16 }}>
      {Array.from({ length: Math.min(count, columns * 3) }, (_, index) => <Fragment key={index}>
        {groupAt?.(index) ? <div className="col-span-full">{renderGroup?.(index)}</div> : null}
        <div className="min-w-0">{renderItem(index)}</div>
      </Fragment>)}
    </div>
  </div>;
  return <div ref={setGrid} style={{ height: rows.getTotalSize(), position: 'relative', width: '100%' }}>
    {visible.map(row => <div key={row.key} ref={rows.measureElement} data-index={row.index}
      style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${row.start - margin}px)`,
        display: 'grid', gridTemplateColumns: groups?.[row.index]?.header !== undefined ? '1fr' : `repeat(${columns}, minmax(0, 1fr))`, gap: 16, paddingBottom: 16 }}>
      {groups?.[row.index]?.header !== undefined ? renderGroup?.(groups[row.index]!.header!) : indices(row.index).map(index =>
        <div key={index} className="min-w-0">{renderItem(index)}</div>)}
    </div>)}
  </div>;
}
