import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import { observeProgrammaticScroll } from './observeProgrammaticScroll';
import { isEditableKeyboardTarget } from '@/lib/editableKeyboardTarget';
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
  const [accessibilitySupport, setAccessibilitySupport] = useState(
    () => window.electronAPI?.accessibilitySupport?.getSync() ?? false,
  );
  const accessibilitySupportRef = useRef(accessibilitySupport);
  const [keyboardOrSelection, setKeyboardOrSelection] = useState(false);
  const keyboardOrSelectionRef = useRef(false);
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
  const needsReconcileRef = useRef<() => boolean>(() => true);
  const reconcileRef = useRef<() => void>(() => {});
  // Programmatic writes made in rAF or an event callback can paint before the
  // browser emits scroll. Their callers must commit the destination immediately.
  const reconcileViewport = useCallback(() => reconcileRef.current(), []);
  const syncViewport = useCallback(() => {
    if (needsReconcileRef.current()) flushSync(reconcileViewport);
  }, [reconcileViewport]);

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
      if (records?.length) { geometry.mutations(records, items); measurement.current = null; }
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
    reconcile(!initial);
  };
  useLayoutEffect(connectViewport);

  useLayoutEffect(() => {
    const root = options.scrollRef.current;
    const items = options.itemsRef.current;
    if (!root || !items) return;
    let frame = 0;
    // A scroll event runs before paint. Deferring mounting to another rAF can
    // expose empty placeholders when a wheel/scrollbar jump exceeds overscan.
    const reconcileBeforePaint = syncViewport;
    const stopObservingWrites = observeProgrammaticScroll(root, () => flushSync(() => {
      // The owner's scroll coordinator must see the new position before our
      // DOM replacement triggers its height/MutationObserver compensation.
      latest.current.onProgrammaticScroll?.();
      reconcileRef.current();
    }));
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; reconcileBeforePaint(); });
    };
    const retainInteraction = (event: Event) => {
      const row = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-render-item-key]') : null;
      if (row && items.contains(row) && row.dataset.renderItemKey) {
        retained.current.add(row.dataset.renderItemKey);
        measurement.current = null;
      }
    };
    let keyboardTraversal = false;
    let textAccessTimer: ReturnType<typeof setTimeout> | undefined;
    const setTextAccess = (enabled: boolean) => {
      if (keyboardOrSelectionRef.current === enabled) return;
      keyboardOrSelectionRef.current = enabled;
      preserveTextAccessAnchor();
      setKeyboardOrSelection(enabled);
    };
    const selectionIntersectsItems = () => {
      const value = document.getSelection();
      if (!value || value.isCollapsed) return false;
      // A page-wide selection can start outside this message stream.
      for (let index = 0; index < value.rangeCount; index++) {
        if (value.getRangeAt(index).intersectsNode(items)) return true;
      }
      return false;
    };
    const updateTextAccess = () => {
      setTextAccess((keyboardTraversal && root.contains(document.activeElement)) || selectionIntersectsItems());
    };
    const settleTextAccess = () => {
      clearTimeout(textAccessTimer);
      // Native focus movement/selection happens after keydown. Also handle a
      // prevented Tab or select-all, without leaving the entire window mounted.
      textAccessTimer = setTimeout(updateTextAccess, 0);
    };
    const pointer = () => {
      keyboardTraversal = false;
      settleTextAccess();
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === 'Tab') {
        // Capture at window: Tab/Shift+Tab can enter from a composer or toolbar
        // outside the scroll root. Mount before native tab-order traversal.
        keyboardTraversal = true;
        flushSync(() => setTextAccess(true));
        settleTextAccess();
        return;
      }
      // Clicking ordinary message text leaves BODY focused. The page-level
      // shortcut therefore never reaches the scroll root's keydown listener.
      if (event.altKey || !(event.ctrlKey || event.metaKey)
        || event.key.toLowerCase() !== 'a' || isEditableKeyboardTarget(event.target)) return;
      flushSync(() => setTextAccess(true));
      settleTextAccess();
    };
    const invalidate = (records: MutationRecord[]) => {
      geometry.mutations(records, items);
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
    mutationObserver.observe(items, { subtree: true, childList: true, characterData: true, attributes: true });
    root.addEventListener('scroll', reconcileBeforePaint, { passive: true });
    root.addEventListener('pointerdown', retainInteraction, true);
    root.addEventListener('focusin', retainInteraction);
    root.addEventListener('keydown', retainInteraction, true);
    window.addEventListener('keydown', keyboard, true);
    window.addEventListener('pointerdown', pointer, true);
    document.addEventListener('focusin', settleTextAccess);
    document.addEventListener('focusout', settleTextAccess);
    document.addEventListener('selectionchange', updateTextAccess);
    return () => {
      stopObservingWrites();
      cancelAnimationFrame(frame);
      clearTimeout(textAccessTimer);
      observer.disconnect();
      geometry.observe(null);
      mutationObserver.disconnect();
      mutations.current = null;
      measurement.current = null;
      root.removeEventListener('scroll', reconcileBeforePaint);
      root.removeEventListener('pointerdown', retainInteraction, true);
      root.removeEventListener('focusin', retainInteraction);
      root.removeEventListener('keydown', retainInteraction, true);
      window.removeEventListener('keydown', keyboard, true);
      window.removeEventListener('pointerdown', pointer, true);
      document.removeEventListener('focusin', settleTextAccess);
      document.removeEventListener('focusout', settleTextAccess);
      document.removeEventListener('selectionchange', updateTextAccess);
    };
  }, [options.scrollRef, options.itemsRef, options.connection, preserveTextAccessAnchor, syncViewport, geometry]);

  return {
    connectViewport,
    reconcileViewport,
    syncViewport,
    shouldMount: (entry: Entry) => options.disabled || accessibilitySupport || pageTextAccess || keyboardOrSelection || entry.retain ||
      retained.current.has(entry.key) || mounted.has(entry.key),
    placeholderHeight: (key: string) => heights.current.get(key) ?? ESTIMATE,
  };
}
