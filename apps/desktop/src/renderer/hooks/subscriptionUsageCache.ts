import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';

interface UsageApi {
  read?: () => Promise<unknown>;
  subscribe?: (listener: (value: unknown) => void) => () => void;
}
interface UsageCache<T> {
  owner: ReturnType<typeof getDataOwnerGeneration>;
  value: T | null;
  epoch: number;
  listeners: Set<() => void>;
  unsubscribe?: () => void;
}

/** One subscription source's display cache. Main owns account identity and sends
 * null on logout/rebinding. Reads may refresh in the background; errors are not
 * clears. The owner and epoch fences also apply while every panel is unmounted.
 */
export function createSubscriptionUsageCache<T extends object>(readApi: () => UsageApi) {
  let cached: UsageCache<T> | undefined;
  const apply = (state: UsageCache<T>, value: unknown) => {
    if (!isDataOwnerGenerationCurrent(state.owner)) return;
    if (value !== null && (!value || typeof value !== 'object' || Array.isArray(value))) return;
    state.epoch++;
    state.value = value as T | null;
    for (const notify of state.listeners) notify();
  };
  const current = (): UsageCache<T> => {
    const owner = getDataOwnerGeneration();
    if (!cached || cached.owner !== owner) {
      cached?.unsubscribe?.();
      cached = { owner, value: null, epoch: 0, listeners: new Set() };
    }
    const state = cached;
    if (!state.unsubscribe) {
      state.unsubscribe = readApi().subscribe?.(value => apply(state, value));
    }
    return state;
  };
  const refreshState = (state: UsageCache<T>) => {
    const read = readApi().read;
    if (!read) return;
    const epoch = ++state.epoch;
    void read().then(value => {
      if (state.epoch === epoch) apply(state, value);
    }).catch(() => { /* Keep the last known quota during transient failures. */ });
  };
  return {
    refresh: () => refreshState(current()),
    useSnapshot(enabled: boolean): T | null {
      const state = current();
      const subscribe = useCallback((notify: () => void) => {
        if (!enabled) return () => {};
        state.listeners.add(notify);
        return () => { state.listeners.delete(notify); };
      }, [state, enabled]);
      const snapshot = useCallback(() => enabled ? state.value : null, [state, enabled]);
      useEffect(() => { if (enabled) refreshState(state); }, [state, enabled]);
      return useSyncExternalStore(subscribe, snapshot, snapshot);
    },
  };
}
