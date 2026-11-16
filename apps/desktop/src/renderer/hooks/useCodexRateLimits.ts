import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { CODEX_POOL_RESET_PREFIX } from '../../shared/subscriptionAccounts';

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

// A stalled read must not leave the recovery button disabled indefinitely.
const CODEX_RATE_LIMIT_READ_TIMEOUT_MS = 15_000;

/** Never expose raw account RPC errors; older preloads remain a silent fallback. */
export async function readCodexRateLimitsSafely(
  reader: CodexRateLimitsReader | undefined,
  providerId?: string,
  onFailure?: () => void,
): Promise<MobileCodexRateLimitsResult | null> {
  if (!reader) return null;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const read = providerId && providerId !== 'openai' ? reader(providerId) : reader();
    const result = await Promise.race([
      read,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Codex quota read timed out')), CODEX_RATE_LIMIT_READ_TIMEOUT_MS);
      }),
    ]);
    return providerId && providerId !== 'openai' && result.providerId !== providerId ? null : result;
  } catch {
    onFailure?.();
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

interface CodexRateLimitsReadState {
  snapshot: MobileCodexRateLimitsResult | null;
  failed: boolean;
  refreshing: boolean;
}

export interface CodexRateLimitsState extends CodexRateLimitsReadState {
  /** Best-effort authoritative refetch, used when the tooltip is opened again. */
  refresh: () => void;
}

/** Display cache shared by settings and task details, scoped to one owner/connection.
 * Memory only: reset offers are never persisted, and Main still validates actions.
 */
interface CachedRateLimits {
  state: CodexRateLimitsReadState;
  version: number;
  pendingReads: number;
  liveObservers: number;
  hasLiveObservation: boolean;
  queuedRefreshes: Set<{ version: number; manual?: true }>;
  listeners: Set<() => void>;
  unsubscribe: Array<() => void>;
  providerId: string;
  owner: ReturnType<typeof getDataOwnerGeneration>;
  awaitingAuthCompletion: boolean;
}
const snapshots = new Map<string, CachedRateLimits>();
let cacheOwner = getDataOwnerGeneration();
const EMPTY_STATE: CodexRateLimitsReadState = { snapshot: null, failed: false, refreshing: false };

function publish(entry: CachedRateLimits, patch: Partial<CodexRateLimitsReadState>): void {
  entry.state = { ...entry.state, ...patch };
  for (const listener of entry.listeners) listener();
}

function refreshEntry(entry: CachedRateLimits): void {
  // A manual/hover refresh can still read the old auth.json during re-login.
  // Wait for the main-process post-commit signal before allowing any read.
  if (entry.awaitingAuthCompletion) return;
  entry.queuedRefreshes.clear();
  const version = ++entry.version;
  entry.pendingReads++;
  publish(entry, { refreshing: true });
  let failed = false;
  void readCodexRateLimitsSafely(readCodexRateLimitsReader(), entry.providerId, () => { failed = true; }).then(next => {
    if (entry.version !== version || !isDataOwnerGenerationCurrent(entry.owner)) return;
    // An unavailable read is not a logout. Explicit identity clears come by push.
    publish(entry, { ...(next !== null ? { snapshot: next } : {}), failed, refreshing: false });
  }).finally(() => {
    entry.pendingReads--;
    if (entry.pendingReads !== 0) return;
    const queued = [...entry.queuedRefreshes].some(request => request.version === entry.version);
    entry.queuedRefreshes.clear();
    if (queued && entry.listeners.size > 0 && isDataOwnerGenerationCurrent(entry.owner)) refreshEntry(entry);
  });
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
    providerId, owner, state: EMPTY_STATE, version: 0, pendingReads: 0, liveObservers: 0, hasLiveObservation: false, queuedRefreshes: new Set(), listeners: new Set(), unsubscribe: [],
    awaitingAuthCompletion: false,
  };
  snapshots.set(providerId, entry);
  const clear = () => {
    entry.version++;
    publish(entry, EMPTY_STATE);
  };
  // Stay subscribed while panels are unmounted, so a replaced account cannot
  // seed the next panel with the previous identity's cached quota.
  const usageUnsubscribe = window.electronAPI?.maker?.usage?.onCodexAccountChanged?.(payload => {
    if (payload === null) clear();
    // The authoritative read itself emits a usage push. Suppress those echoes
    // while any read is pending rather than scheduling a recursive refresh.
    else if (!entry.awaitingAuthCompletion && entry.listeners.size > 0 && entry.pendingReads === 0
      && isDataOwnerGenerationCurrent(entry.owner)) refreshEntry(entry);
  }, providerId);
  if (usageUnsubscribe) entry.unsubscribe.push(usageUnsubscribe);
  if (providerId.startsWith(CODEX_POOL_RESET_PREFIX)) {
    const poolUnsubscribe = window.electronAPI?.subscriptionAccounts?.onChanged?.(payload => {
      if (payload.providerId !== 'openai' || !payload.resetAccountId
        || `${CODEX_POOL_RESET_PREFIX}${payload.resetAccountId}` !== providerId || entry.pendingReads > 0) return;
      if (entry.listeners.size > 0 && isDataOwnerGenerationCurrent(entry.owner)) refreshEntry(entry);
      else clear();
    });
    if (poolUnsubscribe) entry.unsubscribe.push(poolUnsubscribe);
  }
  if (providerId !== 'openai') {
    const authStartedUnsubscribe = window.electronAPI?.maker?.usage?.onCodexAccountAuthStarted?.(() => {
      entry.awaitingAuthCompletion = true;
      clear();
    }, providerId);
    if (authStartedUnsubscribe) entry.unsubscribe.push(authStartedUnsubscribe);
    const authReadyUnsubscribe = window.electronAPI?.maker?.usage?.onCodexAccountAuthReady?.(() => {
      // Main emits this only when the explicit account replacement has settled.
      entry.awaitingAuthCompletion = false;
      if (entry.listeners.size > 0) refreshEntry(entry);
    }, providerId);
    if (authReadyUnsubscribe) entry.unsubscribe.push(authReadyUnsubscribe);
  }
  if (providerId === 'openai') {
    const authUnsubscribe = readCodexAuthStateSubscriber()?.(payload => {
      if (payload.agentKind !== 'codex') return;
      clear();
      if (entry.listeners.size > 0) refreshEntry(entry);
    });
    if (authUnsubscribe) entry.unsubscribe.push(authUnsubscribe);
  }
  return entry;
}

/** Visible group cards share in-flight native reads with the local settings card. */
export function requestCodexRateLimitsRefresh(providerId = 'openai'): void {
  const entry = cachedRateLimits(providerId);
  if (entry.pendingReads === 0) refreshEntry(entry);
}

export function useCodexRateLimits(
  enabled: boolean,
  providerId = 'openai',
  options: { live?: boolean } = {},
): CodexRateLimitsState {
  const live = options.live === true;
  const entry = cachedRateLimits(providerId);
  const lastLiveEntry = useRef<CachedRateLimits | null>(null);
  const subscribe = useCallback((listener: () => void) => {
    if (!enabled) return () => {};
    entry.listeners.add(listener);
    return () => { entry.listeners.delete(listener); };
  }, [entry, enabled]);
  const readSnapshot = useCallback(() => enabled ? entry.state : EMPTY_STATE, [entry, enabled]);
  const state = useSyncExternalStore(subscribe, readSnapshot, readSnapshot);
  const refresh = useCallback(() => {
    if (!enabled || entry.awaitingAuthCompletion) return;
    if (entry.pendingReads === 0) {
      refreshEntry(entry);
      return;
    }
    // Reset completion needs a read started after older requests settle. Reuse
    // the live-card queue, keeping one manual request independent of its unmount tokens.
    if (![...entry.queuedRefreshes].some(request => request.manual && request.version === entry.version)) {
      entry.queuedRefreshes.add({ version: entry.version, manual: true });
    }
    publish(entry, { refreshing: true });
  }, [enabled, entry]);
  useEffect(() => {
    if (!enabled) return;
    // First expansion shares an ordinary consumer's pending read. A card that
    // resumes, or reopens after the last live observer left, queues one reread.
    // Keep the gap on the entry because collapse discards the card's hook/ref,
    // while an ordinary details/spend consumer may still keep the RPC alive.
    const resumed = live && (lastLiveEntry.current === entry ||
      (entry.hasLiveObservation && entry.liveObservers === 0));
    if (live) {
      entry.liveObservers++;
      entry.hasLiveObservation = true;
      lastLiveEntry.current = entry;
    }
    let request: { version: number } | undefined;
    if (live && entry.pendingReads > 0) {
      if (resumed) {
        request = { version: entry.version };
        entry.queuedRefreshes.add(request);
      }
    } else refreshEntry(entry);
    return () => {
      if (live) entry.liveObservers--;
      if (request) entry.queuedRefreshes.delete(request);
    };
  }, [enabled, entry, live]);
  return { ...state, refresh };
}
