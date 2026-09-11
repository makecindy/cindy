import { useMemo, useSyncExternalStore } from 'react';
import {
  getDataOwnerGeneration,
  isDataOwnerIdCurrent,
} from '@/contexts/dataOwnerGeneration';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import { isRemoteSessionSticky, subscribeTurnChangeSetUpdated } from '@/lib/makerTransport';
import type { TurnChangeSetSummary } from '../../../shared/turnChangeSet';

const EMPTY: TurnChangeSetSummary[] = [];
const MAX_CACHED_SESSIONS = 24;

/** Rebuildable, owner-scoped summaries only; exact patches remain in Main. */
interface Entry {
  summaries: TurnChangeSetSummary[];
  listeners: Set<() => void>;
  pending: Promise<void> | null;
  generation: number;
  updates: Map<string, TurnChangeSetSummary>;
  unsubscribe: (() => void) | null;
}

const cache = new Map<string, Entry>();
let cacheOwner = getDataOwnerGeneration();

function entryFor(sessionId: string): Entry {
  // Same-owner repairs advance generation without changing the storage
  // namespace. Keep already rendered cards until the owner actually changes.
  if (!isDataOwnerIdCurrent(cacheOwner)) {
    for (const entry of cache.values()) entry.unsubscribe?.();
    cache.clear();
    cacheOwner = getDataOwnerGeneration();
  }
  let entry = cache.get(sessionId);
  if (!entry) {
    entry = {
      summaries: EMPTY,
      listeners: new Set(),
      pending: null,
      generation: 0,
      updates: new Map(),
      unsubscribe: null,
    };
  }
  // LRU eviction never disconnects a mounted view (split panes may share an entry).
  cache.delete(sessionId);
  cache.set(sessionId, entry);
  for (const [key, value] of cache) {
    if (cache.size <= MAX_CACHED_SESSIONS) break;
    if (key !== sessionId && value.listeners.size === 0) cache.delete(key);
  }
  return entry;
}

function publish(entry: Entry, summaries: TurnChangeSetSummary[]) {
  entry.summaries = summaries.sort((a, b) => a.createdAt - b.createdAt);
  for (const listener of entry.listeners) listener();
}

/** Show cached cards on the first message paint, then refresh from authoritative data. */
export function useTurnChangeSets(
  sessionId: string | undefined,
  remoteHostId: string | null | undefined,
) {
  const remote = useSyncExternalStore(
    remoteProjectsStore.subscribe,
    () => Boolean(sessionId && isRemoteSessionSticky(sessionId)),
    () => false,
  );
  const enabled = Boolean(sessionId && remoteHostId === null && !remote);
  const owner = getDataOwnerGeneration();
  const store = useMemo(() => {
    if (!enabled || !sessionId) return { getSnapshot: () => EMPTY, subscribe: () => () => {} };
    const entry = entryFor(sessionId);
    const current = () =>
      isDataOwnerIdCurrent(owner) &&
      cache.get(sessionId) === entry &&
      !isRemoteSessionSticky(sessionId);
    return {
      getSnapshot: () => (current() ? entry.summaries : EMPTY),
      subscribe: (listener: () => void) => {
        entry.listeners.add(listener);
        if (!entry.unsubscribe) {
          let subscribed = true;
          const off = subscribeTurnChangeSetUpdated(sessionId, ({ summary }) => {
            if (!subscribed || !current()) return;
            if (entry.pending) entry.updates.set(summary.id, summary);
            publish(entry, [...entry.summaries.filter((item) => item.id !== summary.id), summary]);
          });
          entry.unsubscribe = () => {
            subscribed = false;
            off();
          };
        }
        if (!entry.pending && current()) {
          entry.updates.clear();
          const generation = ++entry.generation;
          entry.pending = window.electronAPI.maker
            .listTurnChangeSets(sessionId)
            .then((summaries) => {
              if (!current() || generation !== entry.generation) return;
              // Only pushes received during this request override the response. Old cached
              // summaries must not resurrect deleted cards or an outdated undo/reapply state.
              const merged = new Map(summaries.map((item) => [item.id, item]));
              for (const [id, summary] of entry.updates) merged.set(id, summary);
              publish(entry, [...merged.values()]);
            })
            .catch(() => {
              // A failed refresh keeps the last successful snapshot visible.
            })
            .finally(() => {
              if (generation !== entry.generation) return;
              entry.pending = null;
              entry.updates.clear();
            });
        }
        return () => {
          entry.listeners.delete(listener);
          if (entry.listeners.size === 0) {
            entry.unsubscribe?.();
            entry.unsubscribe = null;
            // Once push observation stops, an in-flight list is no longer a safe
            // baseline for a later mount. Late replies must not overwrite it.
            entry.generation += 1;
            entry.pending = null;
            entry.updates.clear();
          }
        };
      },
    };
  }, [enabled, sessionId, owner]);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, () => EMPTY);
}
