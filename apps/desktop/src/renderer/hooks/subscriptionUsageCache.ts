import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';

interface UsageApi {
  read?: () => Promise<unknown>;
  subscribe?: (listener: (value: unknown) => void) => () => void;
}
interface UsageCache<T> {
  owner: ReturnType<typeof getDataOwnerGeneration>;
  value: T | null;
  epoch: number;
  pendingReads: number;
  liveObservers: number;
  hasLiveObservation: boolean;
  queuedRefreshes: Set<{ epoch: number }>;
  listeners: Set<() => void>;
  unsubscribe?: () => void;
}

/** One subscription source's display cache. Main owns account identity and sends
 * null on logout/rebinding. Reads may refresh in the background; errors are not
 * clears. The owner and epoch fences also apply while every panel is unmounted.
 */
export function createSubscriptionUsageCache<T extends object>(readApi: () => UsageApi) {
  let cached: UsageCache<T> | undefined;
  const apply = (state: UsageCache<T>, value: unknown, invalidatePending = true) => {
    if (!isDataOwnerGenerationCurrent(state.owner)) return;
    if (value !== null && (!value || typeof value !== 'object' || Array.isArray(value))) return;
    if (invalidatePending) state.epoch++;
    state.value = value as T | null;
    for (const notify of state.listeners) notify();
  };
  const current = (): UsageCache<T> => {
    const owner = getDataOwnerGeneration();
    if (!cached || cached.owner !== owner) {
      cached?.unsubscribe?.();
      cached = { owner, value: null, epoch: 0, pendingReads: 0, liveObservers: 0, hasLiveObservation: false, queuedRefreshes: new Set(), listeners: new Set() };
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
    state.queuedRefreshes.clear();
    const epoch = ++state.epoch;
    state.pendingReads++;
    void read().then(value => {
      if (state.epoch === epoch) apply(state, value, false);
    }).catch(() => { /* Keep the last known quota during transient failures. */ }).finally(() => {
      state.pendingReads--;
      if (state.pendingReads !== 0) return;
      const queued = [...state.queuedRefreshes].some(request => request.epoch === state.epoch);
      state.queuedRefreshes.clear();
      if (queued && state.listeners.size > 0 && isDataOwnerGenerationCurrent(state.owner)) refreshState(state);
    });
  };
  return {
    refresh: (shareIfPending = false) => {
      const state = current();
      if (!shareIfPending || state.pendingReads === 0) refreshState(state);
    },
    useSnapshot(enabled: boolean, options: { live?: boolean } = {}): T | null {
      const state = current();
      const live = options.live === true;
      const lastLiveState = useRef<UsageCache<T> | null>(null);
      const subscribe = useCallback((notify: () => void) => {
        if (!enabled) return () => {};
        state.listeners.add(notify);
        return () => { state.listeners.delete(notify); };
      }, [state, enabled]);
      const snapshot = useCallback(() => enabled ? state.value : null, [state, enabled]);
      useEffect(() => {
        if (!enabled) return;
        // First expansion shares pending data; foreground/reopen recovery queues
        // one reread. Ordinary consumers retain latest-request-wins semantics.
        const resumed = live && (lastLiveState.current === state ||
          (state.hasLiveObservation && state.liveObservers === 0));
        if (live) {
          state.liveObservers++;
          state.hasLiveObservation = true;
          lastLiveState.current = state;
        }
        let request: { epoch: number } | undefined;
        if (live && state.pendingReads > 0) {
          if (resumed) {
            request = { epoch: state.epoch };
            state.queuedRefreshes.add(request);
          }
        } else refreshState(state);
        return () => {
          if (live) state.liveObservers--;
          if (request) state.queuedRefreshes.delete(request);
        };
      }, [state, enabled, live]);
      return useSyncExternalStore(subscribe, snapshot, snapshot);
    },
  };
}
