import { defaultRangeExtractor, useVirtualizer, type Range } from '@tanstack/react-virtual';
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type RefObject } from 'react';
import { anchorKey, type UnifiedAnchor, type UnifiedListRow, type UnifiedListSection } from './unifiedModelSelection';

type Item = { key: string; sectionIndex: number } & (
  | { row: null }
  | { row: UnifiedListRow; rowIndex: number }
);

const VIRTUAL_OVERSCAN = 4;
const ROW_ROOT_SELECTOR = '[data-unified-anchor]';

export function useUnifiedModelWindow({ enabled, sections, listRef, flyAnchor, isRowDisabled, onNavigate }: {
  enabled: boolean;
  sections: readonly UnifiedListSection[];
  listRef: RefObject<HTMLDivElement | null>;
  flyAnchor: UnifiedAnchor | null;
  isRowDisabled: (row: UnifiedListRow) => boolean;
  onNavigate: () => void;
}) {
  const prefixRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const pendingFocus = useRef<string | null>(null);

  const { items, byKey, byAnchor } = useMemo(() => {
    const items: Item[] = [];
    const byKey = new Map<string, number>();
    const byAnchor = new Map<string, number>();
    if (enabled) sections.forEach((section, sectionIndex) => {
      items.push({ key: JSON.stringify([section.key]), sectionIndex, row: null });
      section.rows.forEach((row, rowIndex) => {
        const anchor = anchorKey(row.anchor);
        const key = JSON.stringify([section.key, anchor]);
        byKey.set(key, items.length);
        if (!byAnchor.has(anchor)) byAnchor.set(anchor, items.length);
        items.push({ key, sectionIndex, row, rowIndex });
      });
    });
    return { items, byKey, byAnchor };
  }, [enabled, sections]);

  const focusedIndex = focusedKey === null ? undefined : byKey.get(focusedKey);
  const flyIndex = flyAnchor ? byAnchor.get(anchorKey(flyAnchor)) : undefined;
  const firstSelectableIndex = items.findIndex(({ row }) => row && !isRowDisabled(row));
  const getItemKey = useCallback((index: number) => items[index]!.key, [items]);
  const estimateSize = useCallback((index: number) => {
    const item = items[index];
    return item?.row ? 54 + (item.rowIndex > 0 ? 4 : 0) : 28;
  }, [items]);
  const rangeExtractor = useCallback((range: Range) => {
    const indexes = defaultRangeExtractor(range);
    // Scrolling must not remove an active DOM focus or the configuration portal's anchor.
    // Keep one fallback Tab stop for viewports filled with disabled rows.
    for (const index of [focusedIndex, flyIndex, firstSelectableIndex]) {
      if (index !== undefined && index >= 0 && !indexes.includes(index)) indexes.push(index);
    }
    return indexes.sort((a, b) => a - b);
  }, [focusedIndex, flyIndex, firstSelectableIndex]);

  const virtualizer = useVirtualizer({
    enabled,
    count: items.length,
    getScrollElement: () => listRef.current,
    getItemKey,
    estimateSize,
    overscan: VIRTUAL_OVERSCAN,
    rangeExtractor,
    scrollMargin,
    useFlushSync: false,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const scrollOffset = virtualizer.scrollOffset ?? 0;
  const viewportEnd = scrollOffset + (virtualizer.scrollRect?.height ?? 0);
  const visibleTabItem = virtualItems.find(({ index, start, end }) => {
    const row = items[index]?.row;
    return row && start < viewportEnd && end > scrollOffset && !isRowDisabled(row);
  });
  const entryKey = focusedIndex === undefined
    ? items[visibleTabItem?.index ?? firstSelectableIndex]?.key
    : focusedKey;

  useLayoutEffect(() => {
    const prefix = prefixRef.current;
    const canvas = canvasRef.current;
    if (!enabled || !prefix || !canvas) return;
    const update = () => setScrollMargin(canvas.offsetTop);
    update();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(prefix);
    return () => observer?.disconnect();
  }, [enabled, items.length > 0]);

  function rowElement(key: string) {
    const item = virtualizer.elementsCache.get(key);
    return item?.isConnected ? item.querySelector<HTMLElement>(ROW_ROOT_SELECTOR) : undefined;
  }

  useLayoutEffect(() => {
    if (!enabled) {
      pendingFocus.current = null;
      if (focusedKey !== null) setFocusedKey(null);
      return;
    }
    const pending = pendingFocus.current;
    if (pending !== null) {
      const target = rowElement(pending);
      if (!target && byKey.has(pending)) return;
      pendingFocus.current = null;
      target?.focus({ preventScroll: true });
    }
    if (focusedKey !== null && focusedIndex === undefined) {
      setFocusedKey(null);
      if (document.activeElement === document.body) {
        const replacement = entryKey ? rowElement(entryKey) : listRef.current;
        replacement?.focus({ preventScroll: true });
      }
    }
  });

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!enabled || event.defaultPrevented || event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const target = event.target;
    if (!(target instanceof HTMLElement) || !target.matches(ROW_ROOT_SELECTOR)) return;
    const key = pendingFocus.current ?? target.closest<HTMLElement>('[data-window-key]')?.dataset.windowKey;
    const current = key === undefined ? undefined : byKey.get(key);
    if (current === undefined) return;
    const forward = event.key === 'ArrowDown' || event.key === 'Home';
    if (!forward && event.key !== 'ArrowUp' && event.key !== 'End') return;
    event.preventDefault();
    const start = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : current + (forward ? 1 : -1);
    for (let index = start; index >= 0 && index < items.length; index += forward ? 1 : -1) {
      const item = items[index]!;
      if (!item.row || isRowDisabled(item.row)) continue;
      onNavigate();
      pendingFocus.current = item.key;
      setFocusedKey(item.key);
      virtualizer.scrollToIndex(index, { align: 'auto' });
      const target = rowElement(item.key);
      if (target) {
        pendingFocus.current = null;
        target.focus({ preventScroll: true });
      }
      break;
    }
  }

  function onFocus(event: FocusEvent<HTMLDivElement>) {
    const wrapper = event.target.closest<HTMLElement>('[data-window-key]');
    if (wrapper) setFocusedKey(wrapper.dataset.windowKey ?? null);
  }

  function onBlur(event: FocusEvent<HTMLDivElement>) {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    pendingFocus.current = null;
    setFocusedKey(null);
  }

  return { items, virtualItems, virtualizer, prefixRef, canvasRef, scrollMargin, entryKey, onKeyDown, onFocus, onBlur };
}
