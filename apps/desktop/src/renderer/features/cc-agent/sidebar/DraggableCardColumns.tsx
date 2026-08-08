/**
 * DraggableCardColumns — 置顶卡片的多列可拖拽瀑布流。
 * ---------------------------------------------------------------------------
 * 单列仍走 SortableList；2/3 列时这里把同一份 1 维 manualPinnedOrder 轮转铺到多列：
 *   - 下标 i → 第 (i % N) 列、列内第 Math.floor(i / N) 行。
 *   - drop 后按目标列/行换算回 1 维插入点(row * N + col)，继续复用现有
 *     manualPinnedOrder 持久化契约。列归属不是额外状态，重渲染后会按 round-robin
 *     重新分桶。
 *
 * SortableJS 会直接移动 DOM。onEnd 里先读取用户落点，再把所有列按拖拽前快照恢复，
 * 最后交给 React 用新的 items 顺序重渲染，避免 React 与 Sortable 同时拥有 DOM。
 * 多列 DOM 本身仍按列分组；每个卡片 wrapper 会标出 row-major 顺序，供
 * getVisibleSidebarSessionIds 维持 shift 多选 / 删除跳转的共享 pinned 顺序。
 */

import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import Sortable from 'sortablejs';

export interface DraggableCardColumnsProps<T> {
  items: T[];
  columns: number;
  getId: (item: T) => string;
  renderItem: (item: T, index: number) => ReactNode;
  onReorder: (newOrderIds: string[]) => void;
  reducedMotion: boolean;
  groupId?: string;
  /** 与 SortableList 同口径；置顶卡片用原生 DnD 兼容分屏 drop。 */
  forceFallback?: boolean;
}

const CARD_DRAG_FILTER = 'button, input, textarea, select, a, [data-no-drag]';
const CARD_GROUP_NAME = 'pinned-cards';
const SORTING_BODY_CLASS = 'xdt-sorting';

function readColumnIds(columns: readonly (HTMLDivElement | null)[], count: number): string[][] {
  return columns.slice(0, count).map((col) =>
    col
      ? Array.from(col.querySelectorAll<HTMLElement>(':scope > [data-card-id]')).map(
          (node) => node.getAttribute('data-card-id') ?? '',
        )
      : [],
  );
}

function flattenRoundRobinBuckets(buckets: readonly string[][]): string[] {
  const newOrder: string[] = [];
  const maxRows = Math.max(0, ...buckets.map((bucket) => bucket.length));
  for (let r = 0; r < maxRows; r++) {
    for (let c = 0; c < buckets.length; c++) {
      const id = buckets[c]?.[r];
      if (id) newOrder.push(id);
    }
  }
  return newOrder;
}

function reorderByDropSlot(
  currentOrder: readonly string[],
  movedId: string | null,
  toColumn: number,
  toRow: number,
  columns: number,
): string[] {
  if (!movedId || columns <= 0 || toColumn < 0 || toColumn >= columns || toRow < 0) {
    return [...currentOrder];
  }

  const withoutMoved = currentOrder.filter((id) => id !== movedId);
  const insertIndex = Math.min(toRow * columns + toColumn, withoutMoved.length);
  return [
    ...withoutMoved.slice(0, insertIndex),
    movedId,
    ...withoutMoved.slice(insertIndex),
  ];
}

function rowMajorRank(row: number, column: number, columns: number): number {
  return row * columns + column;
}

function readColumnIndex(col: HTMLElement): number {
  const raw = col.dataset.col;
  if (raw == null) return -1;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : -1;
}

function restoreColumnDomOrder(
  columns: readonly (HTMLDivElement | null)[],
  originalBuckets: readonly string[][],
) {
  const nodesById = new Map<string, HTMLElement>();
  for (const col of columns) {
    if (!col) continue;
    for (const node of Array.from(col.querySelectorAll<HTMLElement>(':scope > [data-card-id]'))) {
      const id = node.getAttribute('data-card-id');
      if (id) nodesById.set(id, node);
    }
  }

  originalBuckets.forEach((bucket, c) => {
    const col = columns[c];
    if (!col) return;
    for (const id of bucket) {
      const node = nodesById.get(id);
      if (node) col.appendChild(node);
    }
  });
}

export const __testing = {
  readColumnIds,
  flattenRoundRobinBuckets,
  reorderByDropSlot,
  restoreColumnDomOrder,
  rowMajorRank,
};

export function DraggableCardColumns<T>({
  items,
  columns,
  getId,
  renderItem,
  onReorder,
  reducedMotion,
  groupId,
  forceFallback = true,
}: DraggableCardColumnsProps<T>) {
  const columnRefs = useRef<(HTMLDivElement | null)[]>([]);
  const itemsRef = useRef(items);
  const getIdRef = useRef(getId);
  const onReorderRef = useRef(onReorder);
  const columnsRef = useRef(columns);
  const originalBucketsRef = useRef<string[][] | null>(null);
  const abortNextEndRef = useRef(false);
  // Native DnD may move a card between columns while the pointer passes over
  // the sidebar. Only persist a reorder when the final drop lands in one of
  // this component's columns; external drops must restore the transient DOM.
  const nativeDropDispositionRef = useRef<'internal' | 'external' | null>(null);

  itemsRef.current = items;
  getIdRef.current = getId;
  onReorderRef.current = onReorder;
  columnsRef.current = columns;

  const buckets = useMemo(() => {
    const out: T[][] = Array.from({ length: columns }, () => []);
    items.forEach((item, i) => {
      out[i % columns]?.push(item);
    });
    return out;
  }, [items, columns]);

  useEffect(() => {
    const cols = columnRefs.current.slice(0, columns).filter((el): el is HTMLDivElement => el != null);
    if (cols.length === 0) return;

    const onStart = () => {
      nativeDropDispositionRef.current = null;
      document.body.classList.add(SORTING_BODY_CLASS);
      originalBucketsRef.current = readColumnIds(columnRefs.current, columnsRef.current);
    };

    const onEnd = (evt: Sortable.SortableEvent) => {
      document.body.classList.remove(SORTING_BODY_CLASS);

      const aborted = abortNextEndRef.current;
      abortNextEndRef.current = false;
      const dropDisposition = nativeDropDispositionRef.current;
      nativeDropDispositionRef.current = null;

      const movedId = evt.item.getAttribute('data-card-id');
      const toColumn = readColumnIndex(evt.to);
      const toRow = evt.newDraggableIndex ?? evt.newIndex ?? -1;
      const current = itemsRef.current.map((it) => getIdRef.current(it));
      const newOrder = reorderByDropSlot(current, movedId, toColumn, toRow, columnsRef.current);

      const originalBuckets = originalBucketsRef.current;
      originalBucketsRef.current = null;
      if (originalBuckets) {
        restoreColumnDomOrder(columnRefs.current, originalBuckets);
      }

      if (aborted || (!forceFallback && dropDisposition !== 'internal')) return;

      if (current.length === newOrder.length && current.every((id, i) => id === newOrder[i])) {
        return;
      }
      onReorderRef.current(newOrder);
    };

    const instances = cols.map((el) =>
      Sortable.create(el, {
        group: { name: groupId ?? CARD_GROUP_NAME, pull: true, put: true },
        animation: reducedMotion ? 0 : 150,
        filter: CARD_DRAG_FILTER,
        preventOnFilter: false,
        ghostClass: 'xdt-sortable-ghost',
        chosenClass: '',
        dragClass: 'xdt-sortable-drag',
        fallbackOnBody: true,
        fallbackTolerance: 4,
        forceFallback,
        setData: (dataTransfer, dragEl) => {
          // Keep the browser-required plain-text slot empty: DOM text can contain
          // task titles/previews and would leak if the drag leaves the app.
          dataTransfer.setData('Text', '');
          const rect = dragEl.getBoundingClientRect();
          dataTransfer.setDragImage(
            dragEl,
            Math.min(24, Math.max(0, rect.width / 2)),
            Math.min(24, Math.max(0, rect.height / 2)),
          );
        },
        onStart,
        onEnd,
      }),
    );

    // Native Sortable receives the document `drop` event after capture. Record
    // whether the final target is inside any of this component's columns so
    // onEnd can restore external drops without persisting an intermediate move.
    const markDropDisposition = (event: Event) => {
      const active = Sortable.active;
      if (!active || !instances.includes(active)) return;
      const target = event.target;
      nativeDropDispositionRef.current =
        target instanceof Node && cols.some((col) => col.contains(target))
          ? 'internal'
          : 'external';
    };
    document.addEventListener('drop', markDropDisposition, true);

    const abortIfActive = () => {
      const active = Sortable.active;
      if (!active || !instances.includes(active)) return;
      abortNextEndRef.current = true;
      try {
        document.dispatchEvent(new Event('pointercancel'));
      } catch {
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') abortIfActive();
    };
    window.addEventListener('blur', abortIfActive);
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      window.removeEventListener('blur', abortIfActive);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      document.removeEventListener('drop', markDropDisposition, true);
      document.body.classList.remove(SORTING_BODY_CLASS);
      originalBucketsRef.current = null;
      nativeDropDispositionRef.current = null;
      instances.forEach((inst) => inst.destroy());
    };
  }, [columns, forceFallback, reducedMotion, groupId]);

  return (
    <div className="flex w-full items-stretch gap-[7px]">
      {buckets.map((bucket, c) => (
        <div
          key={c}
          data-col={c}
          data-sortable-native-dnd={forceFallback ? undefined : 'true'}
          ref={(el) => {
            columnRefs.current[c] = el;
          }}
          className="flex min-w-0 flex-1 flex-col gap-[7px]"
        >
          {bucket.map((item, r) => {
            const id = getId(item);
            return (
              <div
                key={id}
                data-card-id={id}
                data-sidebar-row-order={rowMajorRank(r, c, columns)}
                className="xdt-sortable-row"
              >
                {renderItem(item, rowMajorRank(r, c, columns))}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
