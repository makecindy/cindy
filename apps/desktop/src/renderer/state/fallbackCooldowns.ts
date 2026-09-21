/**
 * fallbackCooldowns - remember when a chain entry ran out of quota.
 *
 * Without this, every new message re-attacks a model we already know is dry:
 * the user eats a failure and a reroute on each send. Recording the reset time
 * lets the runner skip that entry until the clock passes, then use it again.
 *
 * Only ever written from an OBSERVED failure, never inferred from a usage
 * percentage: some accounts (Luna reserve) report 0% remaining and still work.
 * Inferring would blacklist a model that is actually fine.
 *
 * Storage mirrors fallbackChains: localStorage, per data owner, external store.
 */

import { useSyncExternalStore } from 'react';

const STORAGE_KEY = 'xdt:fallbackCooldowns:v1';

/** Used when upstream gives no reset time: retry sooner rather than lock a model out for a day. */
export const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000;

export interface FallbackCooldown {
  /** Recovery instant, epoch ms. */
  until: number;
  /** True when upstream supplied the reset time; false = our conservative estimate. */
  exact: boolean;
}

type CooldownMap = Record<string, FallbackCooldown>;

let activeDataOwnerId: string | null = null;
let cache: CooldownMap | null = null;
let version = 0;
const listeners = new Set<() => void>();

function storageKey(): string {
  return activeDataOwnerId ? `${STORAGE_KEY}:${encodeURIComponent(activeDataOwnerId)}` : STORAGE_KEY;
}

function emit(): void {
  version += 1;
  for (const listener of listeners) listener();
}

function parse(raw: string | null): CooldownMap {
  if (!raw) return {};
  try {
    const data = JSON.parse(raw) as unknown;
    if (!data || typeof data !== 'object') return {};
    const out: CooldownMap = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const entry = value as Record<string, unknown>;
      const until =
        typeof entry.until === 'number' && Number.isFinite(entry.until) ? entry.until : null;
      if (until === null) continue;
      out[key] = { until, exact: entry.exact === true };
    }
    return out;
  } catch {
    return {};
  }
}

function load(): CooldownMap {
  if (cache) return cache;
  cache = typeof window === 'undefined' ? {} : parse(window.localStorage.getItem(storageKey()));
  return cache;
}

function persist(next: CooldownMap): void {
  cache = next;
  try {
    window.localStorage.setItem(storageKey(), JSON.stringify(next));
  } catch {
    // Quota or private mode: in-memory state still applies.
  }
  emit();
}

/**
 * Record one quota exhaustion.
 *
 * resetAtMs comes from the upstream error (extractUsageLimitRecoveryHint). When
 * it is missing we fall back to a conservative window and mark exact=false, so
 * the UI does not state a reset time it does not actually know.
 */
export function markFallbackExhausted(
  uid: string,
  resetAtMs: number | null,
  nowMs: number = Date.now(),
): void {
  const exact = typeof resetAtMs === 'number' && Number.isFinite(resetAtMs) && resetAtMs > nowMs;
  const until = exact ? (resetAtMs as number) : nowMs + DEFAULT_COOLDOWN_MS;
  persist({ ...load(), [uid]: { until, exact } });
}

/** Clear one entry: it just ran successfully, so its quota is back. */
export function clearFallbackCooldown(uid: string): void {
  const current = load();
  if (!current[uid]) return;
  const next = { ...current };
  delete next[uid];
  persist(next);
}

/** Still cooling down? Expires by the clock, so no sweeper is needed. */
export function fallbackCooldownFor(
  uid: string,
  nowMs: number = Date.now(),
): FallbackCooldown | null {
  const entry = load()[uid];
  if (!entry) return null;
  return entry.until > nowMs ? entry : null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getVersion = (): number => version;

export function useFallbackCooldownsVersion(): number {
  return useSyncExternalStore(subscribe, getVersion, getVersion);
}

export function setFallbackCooldownsOwner(ownerId: string | null): void {
  if (activeDataOwnerId === ownerId) return;
  activeDataOwnerId = ownerId;
  cache = null;
  emit();
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event: StorageEvent) => {
    if (event.storageArea && event.storageArea !== window.localStorage) return;
    if (event.key !== null && event.key !== storageKey()) return;
    cache = null;
    emit();
  });
}

export const __STORAGE_KEY = STORAGE_KEY;

export function __resetForTest(): void {
  cache = null;
  activeDataOwnerId = null;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // No storage in this environment; nothing to clear.
  }
  emit();
}
