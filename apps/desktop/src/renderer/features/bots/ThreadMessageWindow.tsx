import { defaultRangeExtractor, useVirtualizer, type Range } from '@tanstack/react-virtual';
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode, type RefObject } from 'react';
import { findThreadMessageElement } from './BotGroupThreadViews';

interface ThreadWindowItem { key: string; messageId?: string; keepMounted?: boolean }
// Keep a single server page in the ordinary flow; window accumulated history.
const WINDOW_THRESHOLD = 64;
const ESTIMATED_ROW_HEIGHT = 160;

/** Message data stays in the panel; only viewport rows (plus a small overscan) have DOM. */
export function ThreadMessageWindow({ items, renderItem, scrollRef, following, sharing, focus, onLocated }: {
  items: readonly ThreadWindowItem[];
  renderItem: (index: number) => ReactNode;
  scrollRef: RefObject<HTMLDivElement | null>;
  following: MutableRefObject<boolean>;
  sharing: boolean;
  focus?: { messageId: string; nonce: number } | null;
  onLocated: (messageId: string, target: HTMLElement) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [selecting, setSelecting] = useState(false);
  const [scrollMargin, setScrollMargin] = useState<number>();
  const virtualized = items.length > WINDOW_THRESHOLD;
  // Live work owns pending interaction forms; scrolling must not discard their local drafts.
  const retained = useMemo(() => items.flatMap((item, index) => item.keepMounted ? [index] : []), [items]);
  // Sharing/export and native multi-message selection must retain all selected DOM.
  const rangeExtractor = useCallback((range: Range) => sharing || selecting
    ? Array.from({ length: range.count }, (_, index) => index)
    : [...new Set([...defaultRangeExtractor(range), ...retained])].sort((a, b) => a - b), [sharing, selecting, retained]);
  const getItemKey = useCallback((index: number) => items[index]!.key, [items]);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    getItemKey,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    initialRect: { width: 448, height: 600 },
    initialOffset: () => following.current ? Math.max(0, items.length * ESTIMATED_ROW_HEIGHT - 600) : 0,
    overscan: 4,
    enabled: virtualized,
    anchorTo: 'end',
    followOnAppend: following.current,
    scrollEndThreshold: 48,
    scrollMargin: scrollMargin ?? 0,
    rangeExtractor,
  });
  const visible = virtualizer.getVirtualItems();
  // The scroller ref belongs to the parent and attaches after child layout effects.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (scroller) setScrollMargin(parseFloat(getComputedStyle(scroller).paddingTop) || 0);
  }, [scrollRef]);
  useEffect(() => {
    const onSelection = () => {
      const selection = document.getSelection();
      setSelecting(Boolean(selection && !selection.isCollapsed && containerRef.current?.contains(selection.anchorNode)));
    };
    document.addEventListener('selectionchange', onSelection);
    return () => document.removeEventListener('selectionchange', onSelection);
  }, []);

  const located = useRef<number | null>(null);
  const focusIndex = focus ? items.findIndex(item => item.messageId === focus.messageId) : -1;
  useLayoutEffect(() => {
    if (!focus || focusIndex < 0 || located.current === focus.nonce) return;
    following.current = false;
    const target = findThreadMessageElement(containerRef.current, focus.messageId);
    if (target) {
      located.current = focus.nonce;
      onLocated(focus.messageId, target);
    } else if (virtualized) {
      // A loaded reply can be outside the DOM window; reveal it before trying to flash/read it.
      virtualizer.scrollToIndex(focusIndex, { align: 'center' });
    }
  }, [focus, focusIndex, following, onLocated, virtualized, virtualizer, visible, scrollMargin]);

  const last = visible[visible.length - 1];
  const full = !virtualized || sharing || selecting;
  const indices = full ? items.map((_, index) => index) : visible.map(item => item.index);
  return <div ref={containerRef} className="flex min-w-0 flex-col" data-thread-window={virtualized ? 'virtual' : 'full'}>
    {/* Flow spacers preserve native selection and existing message geometry; rows are not transformed. */}
    {indices.map((index, position) => <Fragment key={items[index]!.key}>
      <div aria-hidden style={{ height: !full ? Math.max(0, visible[position]!.start - (visible[position - 1]?.end ?? scrollMargin ?? 0)) : 0, flexShrink: 0 }} />
      <div data-index={index} data-thread-window-row={items[index]!.key}
      ref={virtualized ? virtualizer.measureElement : undefined} className="flex min-w-0 flex-col">
      {renderItem(index)}
      </div>
    </Fragment>)}
    <div aria-hidden style={{ height: !full && last ? Math.max(0, virtualizer.getTotalSize() - last.end + (scrollMargin ?? 0)) : 0, flexShrink: 0 }} />
  </div>;
}
