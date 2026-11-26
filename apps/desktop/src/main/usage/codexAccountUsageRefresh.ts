import type { RateLimitSnapshot } from '../usageBroadcaster.js';
import {
  ADAPTIVE_QUOTA_TIERS,
  epochSecondsToMs,
  nextExponentialBackoffMs,
  shouldRefreshAdaptiveQuota,
  type AdaptiveQuotaRefreshTiming,
} from './adaptiveQuotaRefresh.js';

interface CodexWebUsageRefreshDeps {
  readCredentials(): Promise<{ accessToken: string; accountId: string | null } | null>;
  fetchWebUsageSnapshot(args: {
    accessToken: string;
    accountId: string | null;
  }): Promise<RateLimitSnapshot | null>;
  recordSnapshot(snapshot: RateLimitSnapshot): Promise<void>;
  clearSnapshot(): Promise<void>;
  readCachedSnapshot(): Promise<RateLimitSnapshot | null>;
  now(): number;
  isUnauthorizedError?(err: unknown): boolean;
  onRefreshError(err: unknown): void;
}

interface CodexWebUsageRefreshOptions {
  throttleMs?: number;
  idleThrottleMs?: number;
  resetMinIntervalMs?: number;
  failureBackoffInitialMs?: number;
  failureBackoffMaxMs?: number;
}

interface RefreshInFlight {
  promise: Promise<void>;
}

interface RefreshState {
  lastRefreshAt: number;
  activitySeq: number;
  refreshedActivitySeq: number;
  backoffMs: number;
  backoffUntil: number;
  lastKnownResetsAtMs: number[];
}

const MAX_TRACKED_KEYS = 32;

function refreshKey(accessToken: string, accountId: string | null): string {
  return `${accountId ?? ''}\0${accessToken}`;
}

function codexResetTimesMs(snapshot: RateLimitSnapshot | null | undefined): number[] {
  if (!snapshot) return [];
  const out: number[] = [];
  const primary = epochSecondsToMs(snapshot.primary?.resetsAt);
  const secondary = epochSecondsToMs(snapshot.secondary?.resetsAt);
  if (primary !== null) out.push(primary);
  if (secondary !== null) out.push(secondary);
  return out;
}

function resolveTiming(options: CodexWebUsageRefreshOptions): AdaptiveQuotaRefreshTiming {
  const tier = ADAPTIVE_QUOTA_TIERS.subscriptionWeb;
  if (options.throttleMs !== undefined) {
    return {
      activeThrottleMs: options.throttleMs,
      idleThrottleMs: options.idleThrottleMs ?? options.throttleMs,
      resetMinIntervalMs: options.resetMinIntervalMs ?? options.throttleMs,
      failureBackoffInitialMs: options.failureBackoffInitialMs ?? tier.failureBackoffInitialMs,
      failureBackoffMaxMs: options.failureBackoffMaxMs ?? tier.failureBackoffMaxMs,
    };
  }
  return {
    activeThrottleMs: tier.activeThrottleMs,
    idleThrottleMs: options.idleThrottleMs ?? tier.idleThrottleMs,
    resetMinIntervalMs: options.resetMinIntervalMs ?? tier.resetMinIntervalMs,
    failureBackoffInitialMs: options.failureBackoffInitialMs ?? tier.failureBackoffInitialMs,
    failureBackoffMaxMs: options.failureBackoffMaxMs ?? tier.failureBackoffMaxMs,
  };
}

/**
 * Creates a cached-first Codex account usage reader.
 *
 * IPC reads should preserve the immediate warm-start path from SQLite and let
 * the slower ChatGPT web usage fetch update the shared snapshot in the
 * background. Refreshes are coalesced and adaptively throttled (active vs idle
 * + reset-boundary recheck + failure backoff) to avoid unnecessary WHAM traffic.
 */
export function createCodexAccountUsageSnapshotReader(
  deps: CodexWebUsageRefreshDeps,
  options: CodexWebUsageRefreshOptions = {},
): (options?: { fresh?: boolean; activity?: boolean }) => Promise<RateLimitSnapshot | null> {
  const timing = resolveTiming(options);
  const refreshInFlightByKey = new Map<string, RefreshInFlight>();
  const stateByKey = new Map<string, RefreshState>();
  let lastUnknownAccountSnapshotAccessToken: string | null = null;

  function getOrCreateState(key: string): RefreshState {
    const existing = stateByKey.get(key);
    if (existing) {
      stateByKey.delete(key);
      stateByKey.set(key, existing);
      return existing;
    }
    const created: RefreshState = {
      lastRefreshAt: 0,
      activitySeq: 0,
      refreshedActivitySeq: 0,
      backoffMs: 0,
      backoffUntil: 0,
      lastKnownResetsAtMs: [],
    };
    stateByKey.set(key, created);
    if (stateByKey.size > MAX_TRACKED_KEYS) {
      const oldest = stateByKey.keys().next().value;
      if (oldest !== undefined) stateByKey.delete(oldest);
    }
    return created;
  }

  async function clearCachedSnapshot(): Promise<void> {
    stateByKey.clear();
    refreshInFlightByKey.clear();
    lastUnknownAccountSnapshotAccessToken = null;
    try {
      await deps.clearSnapshot();
    } catch (err) {
      deps.onRefreshError(err);
    }
  }

  async function isRefreshStillCurrent(accessToken: string, accountId: string | null, clearDisconnected = false): Promise<boolean> {
    try {
      const current = await deps.readCredentials();
      if (current === null && clearDisconnected) await clearCachedSnapshot();
      return current?.accessToken === accessToken && current.accountId === accountId;
    } catch (err) {
      deps.onRefreshError(err);
      return false;
    }
  }

  function triggerRefresh(
    accessToken: string,
    accountId: string | null,
    opts: { force?: boolean; activity?: boolean; cachedSnapshot?: RateLimitSnapshot | null } = {},
  ): Promise<void> {
    const key = refreshKey(accessToken, accountId);
    const state = getOrCreateState(key);
    if (opts.activity) {
      state.activitySeq += 1;
    }
    const existing = refreshInFlightByKey.get(key);
    if (existing) return existing.promise;

    const now = deps.now();
    const cachedResets = codexResetTimesMs(opts.cachedSnapshot);
    const resetsAtMs = cachedResets.length > 0 ? cachedResets : state.lastKnownResetsAtMs;
    if (!opts.force && !shouldRefreshAdaptiveQuota({
      now,
      lastRefreshAt: state.lastRefreshAt,
      hasActivitySinceRefresh: state.activitySeq > state.refreshedActivitySeq,
      resetsAtMs,
      backoffUntil: state.backoffUntil,
      timing,
    })) {
      return Promise.resolve();
    }

    const attemptSeq = state.activitySeq;
    const prevLastRefreshAt = state.lastRefreshAt;
    state.lastRefreshAt = now;
    const refreshInFlight: RefreshInFlight = { promise: Promise.resolve() };
    refreshInFlightByKey.set(key, refreshInFlight);
    refreshInFlight.promise = (async () => {
      try {
        const webSnapshot = await deps.fetchWebUsageSnapshot({
          accessToken,
          accountId,
        });
        if (webSnapshot) {
          if (!await isRefreshStillCurrent(accessToken, accountId)) return;
          await deps.recordSnapshot(webSnapshot);
          state.backoffMs = 0;
          state.backoffUntil = 0;
          state.refreshedActivitySeq = Math.max(state.refreshedActivitySeq, attemptSeq);
          state.lastKnownResetsAtMs = codexResetTimesMs(webSnapshot);
          lastUnknownAccountSnapshotAccessToken =
            accountId === null && (webSnapshot.accountId ?? null) === null
              ? accessToken
              : null;
        } else {
          state.backoffMs = 0;
          state.backoffUntil = 0;
          state.refreshedActivitySeq = Math.max(state.refreshedActivitySeq, attemptSeq);
        }
      } catch (err) {
        if (deps.isUnauthorizedError?.(err)) {
          if (await isRefreshStillCurrent(accessToken, accountId)) {
            await clearCachedSnapshot();
          }
          return;
        }
        state.backoffMs = nextExponentialBackoffMs(state.backoffMs, timing);
        state.backoffUntil = deps.now() + state.backoffMs;
        if (state.backoffMs > 0) state.lastRefreshAt = prevLastRefreshAt;
        deps.onRefreshError(err);
      } finally {
        if (refreshInFlightByKey.get(key) === refreshInFlight) {
          refreshInFlightByKey.delete(key);
        }
      }
    })();

    return refreshInFlight.promise;
  }

  return async (readOptions) => {
    let credentials;
    try {
      credentials = await deps.readCredentials();
    } catch (err) {
      deps.onRefreshError(err);
      // A temporary read failure keeps the warm cache, subject to the current owner guard.
      return deps.readCachedSnapshot();
    }
    if (!credentials) {
      await clearCachedSnapshot();
      return null;
    }
    const { accessToken, accountId } = credentials;
    const cachedSnapshot = await deps.readCachedSnapshot();
    if (!await isRefreshStillCurrent(accessToken, accountId, true)) return null;
    const cachedAccountId = cachedSnapshot?.accountId ?? null;
    if (cachedSnapshot && (cachedAccountId !== accountId
      || (accountId === null && lastUnknownAccountSnapshotAccessToken !== accessToken))) {
      await clearCachedSnapshot();
      if (!readOptions?.fresh) {
        if (await isRefreshStillCurrent(accessToken, accountId)) {
          void triggerRefresh(accessToken, accountId, { activity: readOptions?.activity });
        }
        return null;
      }
    }
    if (readOptions?.fresh) {
      // A request already in flight may have observed quota before the reset. Let it settle,
      // then fetch again without the UI read throttle; credential checks still guard publication.
      await refreshInFlightByKey.get(refreshKey(accessToken, accountId))?.promise;
      if (!await isRefreshStillCurrent(accessToken, accountId)) return null;
      await triggerRefresh(accessToken, accountId, {
        force: true,
        activity: readOptions?.activity,
        cachedSnapshot,
      });
      return await isRefreshStillCurrent(accessToken, accountId) ? deps.readCachedSnapshot() : null;
    }
    void triggerRefresh(accessToken, accountId, {
      activity: readOptions?.activity,
      cachedSnapshot,
    });
    return cachedSnapshot;
  };
}
