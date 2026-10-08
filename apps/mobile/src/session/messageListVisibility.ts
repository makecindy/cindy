import { createContext, useCallback, useContext, useSyncExternalStore } from 'react';

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
