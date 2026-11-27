import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import { observeProgrammaticScroll } from './observeProgrammaticScroll';
import { isEditableKeyboardTarget } from '@/lib/editableKeyboardTarget';
import { collectTabbables } from '@/lib/focusTraversal';
import { isPageTextAccessActive, subscribePageTextAccess } from '@/lib/pageTextAccess';
import { MessageViewportGeometry } from './messageViewportGeometry';

type Entry = { key: string; retain: boolean };
type Options = {
  entries: readonly Entry[];
  scrollRef: RefObject<HTMLDivElement | null>;
  itemsRef: RefObject<HTMLDivElement | null>;
  followRef: RefObject<boolean>;
  initialAnchor?: string;
  initialHeights?: Record<string, number>;
  onProgrammaticScroll?: () => void;
  disabled: boolean;
  /** The owner connects after ancestor DOM refs have attached, before paint. */
  connection?: number;
};
const ESTIMATE = 240;
const OVERSCAN = 600;

/** Keep the existing keyed row/scroll geometry, virtualizing only row contents.
 * Stateful cards are retained by the caller. Interacted-with rows stay mounted
 * for this MessageStream lifetime, so editors, media and portaled menus survive.
 * No browser display locking/content-visibility is used.
 */
export function useMessageViewport(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const [heightCache] = useState(() => new Map(Object.entries(options.initialHeights ?? {})
    .filter(([, height]) => Number.isFinite(height) && height > 0)));
  const heights = useRef(heightCache);
  const retained = useRef(new Set<string>());
  const selectedRows = useRef(new Set<string>());
  const [accessibilitySupport, setAccessibilitySupport] = useState(
    () => window.electronAPI?.accessibilitySupport?.getSync() ?? false,
  );
  const accessibilitySupportRef = useRef(accessibilitySupport);
  const [keyboardOrSelection, setKeyboardOrSelection] = useState(false);
  const keyboardOrSelectionRef = useRef(false);
  const [keyboardRows, setKeyboardRows] = useState<ReadonlySet<string>>(() => new Set());
  const [pageTextAccess, setPageTextAccess] = useState(isPageTextAccessActive);
  const pageTextAccessRef = useRef(pageTextAccess);
  const [mounted, setMounted] = useState(() => {
    const index = options.initialAnchor
      ? Math.max(0, options.entries.findIndex(e => e.key === options.initialAnchor))
      : Math.max(0, options.entries.length - 8);
    return new Set(options.entries.slice(Math.max(0, index - 2), index + 8).map(e => e.key));
  });
  const mountedRef = useRef(mounted);
  mountedRef.current = mounted;
  const pendingAnchor = useRef<{
    key: string; offset: number; wasFollowing: boolean; atBottom: boolean;
  } | null>(null);
  const firstLayout = useRef(true);
  const measurement = useRef<{
    entries: readonly Entry[]; top: number; width: number; height: number; scrollHeight: number;
    itemsWidth: number; itemsHeight: number;
    lower: number; upper: number;
  } | null>(null);
  const mutations = useRef<MutationObserver | null>(null);
  const [geometry] = useState(() => new MessageViewportGeometry());
  // Reading-position snapshots use the same row index as virtualization. A
  // long expanded history must not scan every preceding DOM row on each scroll.
  const getViewportTopRow = useCallback(() => {
    const root = latest.current.scrollRef.current;
    const items = latest.current.itemsRef.current;
    if (!root || !items) return null;
    const records = mutations.current?.takeRecords();
    if (records?.length) geometry.mutations(records, items);
    if (geometry.invalid) measurement.current = null;
    const previousOrigin = geometry.origin;
    geometry.refresh(root, items, heights.current);
    if (geometry.origin !== previousOrigin) measurement.current = null;
    return geometry.range(root.scrollTop, root.clientHeight, 0).anchorElement;
  }, [geometry]);
  const needsReconcileRef = useRef<() => boolean>(() => true);
  const reconcileRef = useRef<() => void>(() => {});
  const frame = useRef(0);
  const reconcileViewport = useCallback(() => reconcileRef.current(), []);
  // Scroll events, programmatic writes, resize deliveries and external sync
  // calls can each arrive several times per frame (a streaming pin emits most
  // of them at once). Coalesce them into one rAF flush that commits the
  // destination window before this frame paints, instead of forcing a
  // synchronous commit per signal.
  const scheduleViewportReconcile = useCallback(() => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      flushSync(() => reconcileRef.current());
    });
  }, []);
  // Callers move the viewport first and may run inside a rendering callback
  // (animateFocusScroll's tick): reconcile synchronously so the destination
  // commits before the current frame paints and same-paint corrections can
  // read the mounted heights.
  const syncViewport = useCallback(() => {
    if (needsReconcileRef.current()) flushSync(() => reconcileRef.current());
  }, []);
  useEffect(() => () => {
    if (frame.current) cancelAnimationFrame(frame.current);
  }, []);

  const preserveTextAccessAnchor = useCallback(() => {
    const { scrollRef, itemsRef, followRef } = latest.current;
    const root = scrollRef.current;
    const items = itemsRef.current;
    if (!root || !items) return;
    const top = root.getBoundingClientRect().top;
    const row = Array.from(items.children).find(element => {
      const rect = element.getBoundingClientRect();
      return rect.height > 0 && rect.bottom > top;
    }) as HTMLElement | undefined;
    if (row?.dataset.renderItemKey) pendingAnchor.current = {
      key: row.dataset.renderItemKey, offset: row.getBoundingClientRect().top - top,
      wasFollowing: followRef.current,
      atBottom: Math.abs(root.scrollHeight - root.scrollTop - root.clientHeight) <= 1,
    };
  }, []);

  useLayoutEffect(() => window.electronAPI?.accessibilitySupport?.onChanged(enabled => {
    if (enabled === accessibilitySupportRef.current) return;
    accessibilitySupportRef.current = enabled;
    preserveTextAccessAnchor();
    setAccessibilitySupport(enabled);
  }), [preserveTextAccessAnchor]);

  useLayoutEffect(() => {
    const update = () => {
      const next = isPageTextAccessActive();
      if (next === pageTextAccessRef.current) return;
      pageTextAccessRef.current = next;
      preserveTextAccessAnchor();
      setPageTextAccess(next);
    };
    const unsubscribe = subscribePageTextAccess(update);
    update();
    return unsubscribe;
  }, [preserveTextAccessAnchor]);

  const connectViewport = () => {
    const root = options.scrollRef.current;
    const items = options.itemsRef.current;
    if (!root || !items) return;
    const initial = firstLayout.current;
    firstLayout.current = false;
    if (initial) {
      if (options.followRef.current) root.scrollTop = root.scrollHeight;
      else if (options.initialAnchor) {
        const row = Array.from(items.children).find(e => (e as HTMLElement).dataset.renderItemKey === options.initialAnchor);
        if (row) root.scrollTop += row.getBoundingClientRect().top - root.getBoundingClientRect().top;
      }
    }
    const anchor = pendingAnchor.current;
    pendingAnchor.current = null;
    if (anchor) {
      if (options.followRef.current && (!anchor.wasFollowing || anchor.atBottom)) {
        // A NEW tail-follow intent supersedes an older reading anchor. An
        // already-following container can have been moved away by a script
        // before its scroll event updates followRef; preserve that destination.
        if (Math.abs(root.scrollHeight - root.scrollTop - root.clientHeight) > 1) root.scrollTop = root.scrollHeight;
      }
      else {
        const row = Array.from(items.children).find(e => (e as HTMLElement).dataset.renderItemKey === anchor.key);
        const delta = row ? row.getBoundingClientRect().top - root.getBoundingClientRect().top - anchor.offset : 0;
        // Even assigning the same scrollTop cancels Chromium's native smooth
        // animation. Only interrupt it when geometry actually needs correction.
        if (Math.abs(delta) > 1) root.scrollTop += delta;
      }
    }
    const needsReconcile = () => {
      // Drain mutations already represented by this commit before trusting the
      // cached interval. Nested message updates can run without a parent render.
      const records = mutations.current?.takeRecords();
      if (records?.length) {
        geometry.mutations(records, items);
        if (geometry.invalid) measurement.current = null;
      }
      const cached = measurement.current;
      const position = root.scrollTop;
      return !cached || geometry.invalid || cached.entries !== latest.current.entries ||
        cached.width !== root.clientWidth || cached.height !== root.clientHeight ||
        cached.itemsWidth !== items.clientWidth || cached.itemsHeight !== items.clientHeight ||
        cached.scrollHeight !== root.scrollHeight ||
        !(position === cached.top || (position > cached.lower && position < cached.upper));
    };
    needsReconcileRef.current = needsReconcile;
    const reconcile = (preserveAnchor = true) => {
      if (!needsReconcile()) return;
      const current = latest.current;
      const position = root.scrollTop;
      geometry.refresh(root, items, heights.current);
      const { keys, lower, upper, anchor: viewportAnchor } = geometry.range(position, root.clientHeight, OVERSCAN);
      const next = new Set(keys);
      for (const key of selectedRows.current) next.add(key);
      for (const entry of current.entries) {
        if (entry.retain || retained.current.has(entry.key)) next.add(entry.key);
      }
      measurement.current = { entries: current.entries, top: position,
        width: root.clientWidth, height: root.clientHeight, scrollHeight: root.scrollHeight,
        itemsWidth: items.clientWidth, itemsHeight: items.clientHeight,
        lower, upper };
      if (next.size === mountedRef.current.size && [...next].every(key => mountedRef.current.has(key))) return;
      if (preserveAnchor && viewportAnchor) pendingAnchor.current = {
        ...viewportAnchor,
        wasFollowing: current.followRef.current,
        atBottom: Math.abs(root.scrollHeight - root.scrollTop - root.clientHeight) <= 1,
      };
      mountedRef.current = next;
      setMounted(next);
    };
    reconcileRef.current = reconcile;
    // First paint and anchor restoration need the destination immediately.
    // Ordinary commits share the frame requested by DOM/resize observers.
    if (initial || anchor) reconcile(!initial);
    else scheduleViewportReconcile();
  };
  useLayoutEffect(connectViewport);

  useLayoutEffect(() => {
    const root = options.scrollRef.current;
    const items = options.itemsRef.current;
    if (!root || !items) return;
    // A scroll event dispatches before this frame's rAF callbacks: a rAF
    // requested here reconciles before that frame paints, coalescing bursts
    // of scroll and resize signals into one commit.
    const stopObservingWrites = observeProgrammaticScroll(root, () => {
      // The owner's scroll coordinator must see the new position before our
      // DOM replacement triggers its height/MutationObserver compensation.
      // Its state updates batch normally; only the reconcile commits now.
      latest.current.onProgrammaticScroll?.();
      if (needsReconcileRef.current()) flushSync(() => reconcileRef.current());
    });
    const schedule = scheduleViewportReconcile;
    const onScroll = () => scheduleViewportReconcile();
    const retainInteraction = (event: Event) => {
      const row = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-render-item-key]') : null;
      if (row && items.contains(row) && row.dataset.renderItemKey) {
        retained.current.add(row.dataset.renderItemKey);
        measurement.current = null;
      }
    };
    let keyboardRowsTimer: ReturnType<typeof setTimeout> | undefined;
    let selectAllTimer: ReturnType<typeof setTimeout> | undefined;
    const setTextAccess = (enabled: boolean) => {
      if (keyboardOrSelectionRef.current === enabled) return;
      keyboardOrSelectionRef.current = enabled;
      preserveTextAccessAnchor();
      setKeyboardOrSelection(enabled);
    };
    const rowAt = (node: Node) => {
      const element = node instanceof Element ? node : node.parentElement;
      const row = element?.closest<HTMLElement>('[data-render-item-key]');
      return row?.parentElement === items ? row : null;
    };
    let firstSelected: HTMLElement | null = null;
    let lastSelected: HTMLElement | null = null;
    const updateSelection = () => {
      const value = document.getSelection();
      let first: HTMLElement | null = null;
      let last: HTMLElement | null = null;
      let fullAccess = false;
      if (value && !value.isCollapsed) {
        for (let index = 0; index < value.rangeCount; index++) {
          const range = value.getRangeAt(index);
          if (!range.intersectsNode(items)) continue;
          first = rowAt(range.startContainer);
          last = rowAt(range.endContainer);
          // Document-wide and cross-stream selections still need full text.
          fullAccess = !first || !last || value.rangeCount > 1;
          break;
        }
      }
      if (fullAccess) first = last = null;
      if (first !== firstSelected || last !== lastSelected) {
        firstSelected = first;
        lastSelected = last;
        selectedRows.current.clear();
        // Range endpoints are in document order even for a backward drag.
        for (let row: Element | null = first; row; row = row.nextElementSibling) {
          const key = row.getAttribute('data-render-item-key');
          if (key) selectedRows.current.add(key);
          if (row === last) break;
        }
        measurement.current = null;
        schedule();
      }
      setTextAccess(fullAccess);
    };
    const clearKeyboardRowsOutside = () => {
      if (!root.contains(document.activeElement)) setKeyboardRows(previous => previous.size ? new Set() : previous);
    };
    const settleKeyboardRows = () => {
      clearTimeout(keyboardRowsTimer);
      // Native focus movement happens after keydown.
      keyboardRowsTimer = setTimeout(clearKeyboardRowsOutside, 0);
    };
    const updateTextAccess = () => {
      updateSelection();
      clearKeyboardRowsOutside();
    };
    const onSelectionChange = (event: Event) => {
      // Text inputs also emit selectionchange. Only the document event reports
      // changes to the page range, and reading isCollapsed can force layout.
      if (event.target !== document) return;
      clearTimeout(selectAllTimer);
      updateTextAccess();
    };
    const prepareTabDestination = (reverse: boolean) => {
      // Include virtual rows in native DOM order, revealing only rows on the
      // way to the next control. Never consume Tab or move focus ourselves.
      // A Tab between composer/toolbar controls must not expand the history.
      const active = document.activeElement;
      if (!(active instanceof HTMLElement)) return;
      for (let remaining = latest.current.entries.length; remaining > 0; remaining--) {
        const candidates = collectTabbables(document, element =>
          items.contains(element) && element.hasAttribute('data-message-placeholder'));
        // Native positive tabindex precedes ordinary document-order controls.
        candidates.sort((a, b) => (a.tabIndex > 0 ? a.tabIndex : Infinity) -
          (b.tabIndex > 0 ? b.tabIndex : Infinity));
        const index = candidates.indexOf(active);
        const next = index >= 0 ? candidates[index + (reverse ? -1 : 1)] :
          (reverse ? [...candidates].reverse() : candidates).find(element =>
            Boolean(active.compareDocumentPosition(element) &
              (reverse ? Node.DOCUMENT_POSITION_PRECEDING : Node.DOCUMENT_POSITION_FOLLOWING)));
        if (!next || !items.contains(next) || !next.hasAttribute('data-message-placeholder')) return;
        const key = next.dataset.renderItemKey;
        if (!key) return;
        flushSync(() => {
          preserveTextAccessAnchor();
          setKeyboardRows(previous => new Set([...previous, key]));
        });
      }
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (event.key === 'Tab') {
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        prepareTabDestination(event.shiftKey);
        settleKeyboardRows();
        return;
      }
      // Clicking ordinary message text leaves BODY focused. The page-level
      // shortcut therefore never reaches the scroll root's keydown listener.
      if (event.altKey || !(event.ctrlKey || event.metaKey)
        || event.key.toLowerCase() !== 'a' || isEditableKeyboardTarget(event.target)) return;
      flushSync(() => setTextAccess(true));
      // If native select-all is prevented or leaves the selection unchanged,
      // release the preemptive mount even without a selectionchange event.
      clearTimeout(selectAllTimer);
      selectAllTimer = setTimeout(updateTextAccess, 0);
    };
    const invalidate = (records: MutationRecord[]) => {
      geometry.mutations(records, items);
      if (!geometry.invalid) return;
      measurement.current = null;
      schedule();
    };
    // Resize delivery can describe a commit that the layout effect already
    // measured. Compare dimensions/DOM generation before scheduling it again.
    const observer = new ResizeObserver(entries => {
      for (const entry of entries ?? []) {
        if (entry.target !== root && entry.target !== items) {
          geometry.resize(entry.target as HTMLElement, entry.borderBoxSize?.[0]?.blockSize);
        }
      }
      if (needsReconcileRef.current()) schedule();
    });
    observer.observe(items);
    observer.observe(root);
    geometry.observe(observer);
    const mutationObserver = new MutationObserver(invalidate);
    mutations.current = mutationObserver;
    mutationObserver.observe(items, { subtree: true, childList: true, characterData: true, attributes: true, attributeOldValue: true });
    root.addEventListener('scroll', onScroll, { passive: true });
    root.addEventListener('pointerdown', retainInteraction, true);
    root.addEventListener('focusin', retainInteraction);
    root.addEventListener('keydown', retainInteraction, true);
    // Bubble after editor completion / modal handlers have had first refusal,
    // but before the browser performs its native focus or selection action.
    window.addEventListener('keydown', keyboard);
    window.addEventListener('pointerdown', settleKeyboardRows, true);
    document.addEventListener('focusin', settleKeyboardRows);
    document.addEventListener('focusout', settleKeyboardRows);
    document.addEventListener('selectionchange', onSelectionChange);
    return () => {
      stopObservingWrites();
      selectedRows.current.clear();
      clearTimeout(keyboardRowsTimer);
      clearTimeout(selectAllTimer);
      observer.disconnect();
      geometry.observe(null);
      mutationObserver.disconnect();
      mutations.current = null;
      measurement.current = null;
      root.removeEventListener('scroll', onScroll);
      root.removeEventListener('pointerdown', retainInteraction, true);
      root.removeEventListener('focusin', retainInteraction);
      root.removeEventListener('keydown', retainInteraction, true);
      window.removeEventListener('keydown', keyboard);
      window.removeEventListener('pointerdown', settleKeyboardRows, true);
      document.removeEventListener('focusin', settleKeyboardRows);
      document.removeEventListener('focusout', settleKeyboardRows);
      document.removeEventListener('selectionchange', onSelectionChange);
    };
  }, [options.scrollRef, options.itemsRef, options.connection, preserveTextAccessAnchor, scheduleViewportReconcile, geometry]);

  return {
    getViewportTopRow,
    connectViewport,
    reconcileViewport,
    syncViewport,
    shouldMount: (entry: Entry) => options.disabled || accessibilitySupport || pageTextAccess || keyboardOrSelection || entry.retain ||
      retained.current.has(entry.key) || selectedRows.current.has(entry.key) || keyboardRows.has(entry.key) || mounted.has(entry.key),
    placeholderHeight: (key: string) => heights.current.get(key) ?? ESTIMATE,
  };
}
