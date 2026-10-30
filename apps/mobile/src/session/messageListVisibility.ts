import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useSyncExternalStore } from 'react';

/** One store per LegendList lifetime; only rows whose visibility changes are notified. */
export class MessageListVisibility {
  private visibleKeys = new Set<string>();
  private listeners = new Map<string, Set<() => void>>();

  isVisible(key: string): boolean {
    return this.visibleKeys.has(key);
  }

  subscribe(key: string, listener: () => void): () => void {
    let listeners = this.listeners.get(key);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(key, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(key);
    };
  }

  update(viewableItems: readonly { key: string; isViewable: boolean }[]): void {
    const next = new Set(viewableItems.filter(item => item.isViewable).map(item => item.key));
    const changed = new Set([...this.visibleKeys, ...next]);
    for (const key of changed) {
      if (this.visibleKeys.has(key) === next.has(key)) changed.delete(key);
    }
    this.visibleKeys = next;
    for (const key of changed) {
      for (const listener of this.listeners.get(key) ?? []) listener();
    }
  }
}

export const MessageListVisibilityContext = createContext<MessageListVisibility | null>(null);

export function useMessageListItemVisible(key: string): boolean {
  const store = useContext(MessageListVisibilityContext);
  const subscribe = useCallback((listener: () => void) => store?.subscribe(key, listener) ?? (() => {}), [store, key]);
  const getSnapshot = useCallback(() => store?.isVisible(key) ?? false, [store, key]);
  // LegendList's useViewability reads during render, then subscribes in an effect
  // without replaying the latest value. useSyncExternalStore closes that gap,
  // including the first layout notification arriving before this row subscribes.
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** ScrollView rows report content coordinates; reuse the list's per-row subscriptions. */
export class ScrollViewMessageVisibility extends MessageListVisibility {
  private layouts = new Map<string, { y: number; height: number }>();
  private offsetY = 0;
  private height = 0;
  private active = true;

  setActive(active: boolean): void {
    this.active = active;
    this.refresh();
  }

  setViewport(offsetY: number, height: number): void {
    this.offsetY = offsetY;
    this.height = height;
    this.refresh();
  }

  setHeight(height: number): void {
    this.height = height;
    this.refresh();
  }

  setLayout(key: string, layout: { y: number; height: number }): void {
    this.layouts.set(key, layout);
    this.refresh();
  }

  retain(keys: readonly string[]): void {
    const retained = new Set(keys);
    for (const key of this.layouts.keys()) if (!retained.has(key)) this.layouts.delete(key);
    this.refresh();
  }

  private refresh(): void {
    this.update([...this.layouts].map(([key, layout]) => ({
      key,
      isViewable: this.active && this.height > 0 && layout.height > 0
        && layout.y < this.offsetY + this.height && layout.y + layout.height > this.offsetY,
    })));
  }
}

export function useScrollViewMessageVisibility(scope: string, keys: readonly string[], active = true): ScrollViewMessageVisibility {
  const store = useMemo(() => new ScrollViewMessageVisibility(), [scope]);
  useLayoutEffect(() => {
    store.setActive(active);
    return () => store.setActive(false);
  }, [store, active]);
  useEffect(() => store.retain(keys), [store, keys]);
  return store;
}
