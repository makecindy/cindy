import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';

import type { MobileCodexRateLimitsResult } from '@cindy/maker-shared/device-link-contract';

type CodexRateLimitsReader = (providerId?: string) => Promise<MobileCodexRateLimitsResult>;
type CodexAuthStateSubscriber = (
  callback: (payload: { agentKind?: string }) => void,
) => () => void;

function readCodexRateLimitsReader(): CodexRateLimitsReader | undefined {
  return (window as unknown as {
    electronAPI?: {
      maker?: {
        usage?: {
          getCodexRateLimits?: CodexRateLimitsReader;
        };
      };
    };
  }).electronAPI?.maker?.usage?.getCodexRateLimits;
}

function readCodexAuthStateSubscriber(): CodexAuthStateSubscriber | undefined {
  return (window as unknown as {
    electronAPI?: {
      maker?: {
        auth?: {
          onStateChanged?: CodexAuthStateSubscriber;
        };
      };
    };
  }).electronAPI?.maker?.auth?.onStateChanged;
}

/** Missing/older preload and failed app-server reads both degrade to no extra tooltip rows. */
export async function readCodexRateLimitsSafely(
  reader: CodexRateLimitsReader | undefined,
  providerId?: string,
): Promise<MobileCodexRateLimitsResult | null> {
  if (!reader) return null;
  try {
    const result = await (providerId && providerId !== 'openai' ? reader(providerId) : reader());
    return providerId && providerId !== 'openai' && result.providerId !== providerId ? null : result;
  } catch {
    return null;
  }
}

export interface CodexRateLimitsState {
  snapshot: MobileCodexRateLimitsResult | null;
  /** Best-effort authoritative refetch, used when the tooltip is opened again. */
  refresh: () => void;
}

/** Display cache shared by settings and task details, scoped to one owner/connection.
 * Memory only: reset offers are never persisted, and Main still validates actions.
 */
interface CachedRateLimits {
  snapshot: MobileCodexRateLimitsResult | null;
  version: number;
  pendingReads: number;
  listeners: Set<() => void>;
  unsubscribe: Array<() => void>;
  providerId: string;
  owner: ReturnType<typeof getDataOwnerGeneration>;
}
const snapshots = new Map<string, CachedRateLimits>();
let cacheOwner = getDataOwnerGeneration();

function publish(entry: CachedRateLimits, value: MobileCodexRateLimitsResult | null): void {
  entry.snapshot = value;
  for (const listener of entry.listeners) listener();
}

function refreshEntry(entry: CachedRateLimits): void {
  const version = ++entry.version;
  entry.pendingReads++;
  void readCodexRateLimitsSafely(readCodexRateLimitsReader(), entry.providerId).then(next => {
    if (entry.version !== version || !isDataOwnerGenerationCurrent(entry.owner)) return;
    // An unavailable read is not a logout. Explicit identity clears come by push.
    if (next !== null) publish(entry, next);
  }).finally(() => { entry.pendingReads--; });
}

function cachedRateLimits(providerId: string): CachedRateLimits {
  const owner = getDataOwnerGeneration();
  if (cacheOwner !== owner) {
    for (const entry of snapshots.values()) {
      entry.version++;
      entry.unsubscribe.forEach(unsubscribe => unsubscribe());
    }
    snapshots.clear();
    cacheOwner = owner;
  }
  const cached = snapshots.get(providerId);
  if (cached) return cached;
  const entry: CachedRateLimits = {
    providerId, owner, snapshot: null, version: 0, pendingReads: 0, listeners: new Set(), unsubscribe: [],
  };
  snapshots.set(providerId, entry);
  const clear = () => {
    entry.version++;
    publish(entry, null);
  };
  // Stay subscribed while panels are unmounted, so a replaced account cannot
  // seed the next panel with the previous identity's cached quota.
  const usageUnsubscribe = window.electronAPI?.maker?.usage?.onCodexAccountChanged?.(payload => {
    if (payload === null) clear();
    // The authoritative read itself emits a usage push. Suppress those echoes
    // while any read is pending rather than scheduling a recursive refresh.
    else if (entry.listeners.size > 0 && entry.pendingReads === 0
      && isDataOwnerGenerationCurrent(entry.owner)) refreshEntry(entry);
  }, providerId);
  if (usageUnsubscribe) entry.unsubscribe.push(usageUnsubscribe);
  if (providerId === 'openai') {
    const authUnsubscribe = readCodexAuthStateSubscriber()?.(payload => {
      if (payload.agentKind !== 'codex') return;
      clear();
      if (entry.listeners.size > 0) refreshEntry(entry);
    });
    if (authUnsubscribe) entry.unsubscribe.push(authUnsubscribe);
  } else {
    const providerUnsubscribe = window.electronAPI?.maker?.onProvidersChanged?.(() => {
      // Catalog edits/renames aren't account changes. Main sends a scoped null
      // usage push when credentials really change or the connection is removed.
      if (entry.listeners.size > 0) refreshEntry(entry);
    });
    if (providerUnsubscribe) entry.unsubscribe.push(providerUnsubscribe);
  }
  return entry;
}

export function useCodexRateLimits(enabled: boolean, providerId = 'openai'): CodexRateLimitsState {
  const entry = cachedRateLimits(providerId);
  const subscribe = useCallback((listener: () => void) => {
    if (!enabled) return () => {};
    entry.listeners.add(listener);
    return () => { entry.listeners.delete(listener); };
  }, [entry, enabled]);
  const readSnapshot = useCallback(() => enabled ? entry.snapshot : null, [entry, enabled]);
  const snapshot = useSyncExternalStore(subscribe, readSnapshot, readSnapshot);
  const refresh = useCallback(() => {
    if (enabled) refreshEntry(entry);
  }, [enabled, entry]);
  useEffect(refresh, [refresh]);
  return { snapshot, refresh };
}
