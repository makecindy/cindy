import { useCallback, useEffect, useSyncExternalStore } from 'react';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
  subscribeDataOwnerGeneration,
  type DataOwnerGeneration,
} from '@/contexts/dataOwnerGeneration';
import type { AntigravityAccountsView } from '../../shared/antigravityAccounts';

interface AntigravityCacheState {
  owner: DataOwnerGeneration;
  value: AntigravityAccountsView | null;
  usageLoaded: boolean;
  fetchedAt: number;
}

const USAGE_FRESH_MS = 60_000;

let state: AntigravityCacheState | null = null;
const listeners = new Set<() => void>();
let inFlight: { key: string; action: 'read' | 'usage'; promise: Promise<AntigravityAccountsView | null> } | null = null;
let authSubscribed = false;
let ownerSubscribed = false;

function ownerKey(owner: DataOwnerGeneration): string {
  return `${owner.dataOwnerId ?? ''}:${owner.generation}`;
}

function notify(): void {
  for (const listener of [...listeners]) listener();
}

function getCurrentState(): AntigravityCacheState | null {
  if (!state) return null;
  if (!isDataOwnerGenerationCurrent(state.owner)) {
    state = null;
    inFlight = null;
    return null;
  }
  return state;
}

function ensureGlobalSubscriptions(): void {
  if (!ownerSubscribed) {
    ownerSubscribed = true;
    subscribeDataOwnerGeneration(() => {
      if (state && !isDataOwnerGenerationCurrent(state.owner)) {
        state = null;
        inFlight = null;
        notify();
      }
    });
  }
  if (!authSubscribed && window.electronAPI?.maker?.auth?.onStateChanged) {
    authSubscribed = true;
    window.electronAPI.maker.auth.onStateChanged((event) => {
      if (event.agentKind === 'antigravity') {
        void fetchAntigravityAccountsView(event.authenticated ? 'usage' : 'read', { force: true });
      }
    });
  }
}

export function setCachedAntigravityView(
  owner: DataOwnerGeneration,
  value: AntigravityAccountsView,
  options?: { usageLoaded?: boolean },
): void {
  if (!isDataOwnerGenerationCurrent(owner)) return;
  const previous = getCurrentState();
  const sameActive = previous?.value?.activeId === value.activeId;
  const hasIncomingUsage = value.usage !== undefined;
  const mergedUsage = hasIncomingUsage
    ? value.usage
    : (value.connected && sameActive ? previous?.value?.usage : undefined);
  const merged: AntigravityAccountsView = mergedUsage !== undefined
    ? { ...value, usage: mergedUsage }
    : value;
  const usageLoaded = options?.usageLoaded
    ?? (hasIncomingUsage ? true : (value.connected && sameActive ? (previous?.usageLoaded ?? false) : false));
  state = {
    owner,
    value: merged,
    usageLoaded,
    fetchedAt: Date.now(),
  };
  notify();
}

export function clearCachedAntigravityView(): void {
  state = null;
  inFlight = null;
  notify();
}

export async function fetchAntigravityAccountsView(
  action: 'read' | 'usage',
  options?: { force?: boolean },
): Promise<AntigravityAccountsView | null> {
  const api = window.electronAPI?.antigravityAccounts;
  const owner = getDataOwnerGeneration();
  if (!api || !owner.dataOwnerId || !isDataOwnerGenerationCurrent(owner)) return null;
  const key = ownerKey(owner);
  const current = getCurrentState();
  if (
    !options?.force &&
    current?.value &&
    (action === 'read' || current.usageLoaded) &&
    Date.now() - current.fetchedAt < USAGE_FRESH_MS
  ) {
    return current.value;
  }
  if (
    inFlight &&
    inFlight.key === key &&
    (inFlight.action === action || (action === 'read' && inFlight.action === 'usage'))
  ) {
    return inFlight.promise;
  }
  const promise = api(
    { action },
    { dataOwnerId: owner.dataOwnerId, ownerGeneration: owner.generation },
  )
    .then((value) => {
      if (isDataOwnerGenerationCurrent(owner)) {
        setCachedAntigravityView(owner, value, {
          usageLoaded: action === 'usage' || value.usage !== undefined,
        });
      }
      return value;
    })
    .finally(() => {
      if (inFlight?.promise === promise) inFlight = null;
    });
  inFlight = { key, action, promise };
  return promise;
}

function subscribe(listener: () => void): () => void {
  ensureGlobalSubscriptions();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useAntigravityAccountsCache(
  enabled: boolean,
  options?: { fetchUsage?: boolean },
): {
  accounts: AntigravityAccountsView | undefined;
  usageLoaded: boolean;
  refresh: (action: 'read' | 'usage', opts?: { force?: boolean }) => Promise<AntigravityAccountsView | null>;
  updateView: (owner: DataOwnerGeneration, value: AntigravityAccountsView, opts?: { usageLoaded?: boolean }) => void;
} {
  const owner = useSyncExternalStore(subscribeDataOwnerGeneration, getDataOwnerGeneration);
  const snapshot = useSyncExternalStore(subscribe, getCurrentState, () => null);
  const wantUsage = options?.fetchUsage === true;

  useEffect(() => {
    if (!enabled || !owner.dataOwnerId || !isDataOwnerGenerationCurrent(owner)) return;
    const action = wantUsage ? 'usage' : 'read';
    void fetchAntigravityAccountsView(action).catch(() => undefined);
  }, [enabled, owner, wantUsage]);

  const refresh = useCallback(
    (action: 'read' | 'usage', opts?: { force?: boolean }) => fetchAntigravityAccountsView(action, opts),
    [],
  );

  const valid = snapshot && isDataOwnerGenerationCurrent(snapshot.owner) ? snapshot : null;
  return {
    accounts: valid?.value ?? undefined,
    usageLoaded: valid?.usageLoaded ?? false,
    refresh,
    updateView: setCachedAntigravityView,
  };
}

export function useAntigravitySubscriptionUsage(enabled: boolean): AntigravityAccountsView | null {
  const { accounts } = useAntigravityAccountsCache(enabled, { fetchUsage: enabled });
  return enabled ? (accounts ?? null) : null;
}
