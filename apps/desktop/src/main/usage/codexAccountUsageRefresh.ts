import type { RateLimitSnapshot } from '../usageBroadcaster.js';

interface CodexWebUsageRefreshDeps {
  readAccessToken(): Promise<string | null>;
  readAccountId(): Promise<string | null>;
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
}

interface RefreshInFlight {
  promise: Promise<void>;
}

const DEFAULT_THROTTLE_MS = 10_000;

function refreshKey(accessToken: string, accountId: string | null): string {
  return `${accountId ?? ''}\0${accessToken}`;
}

/**
 * Creates a cached-first Codex account usage reader.
 *
 * IPC reads should preserve the immediate warm-start path from SQLite and let
 * the slower ChatGPT web usage fetch update the shared snapshot in the
 * background. Refreshes are coalesced to avoid piling up WHAM requests during
 * dense turn completion bursts.
 */
export function createCodexAccountUsageSnapshotReader(
  deps: CodexWebUsageRefreshDeps,
  options: CodexWebUsageRefreshOptions = {},
): (options?: { fresh?: boolean }) => Promise<RateLimitSnapshot | null> {
  const throttleMs = options.throttleMs ?? DEFAULT_THROTTLE_MS;
  const refreshInFlightByKey = new Map<string, RefreshInFlight>();
  const lastRefreshAtByKey = new Map<string, number>();
  let lastUnknownAccountSnapshotAccessToken: string | null = null;

  async function clearCachedSnapshot(): Promise<void> {
    lastRefreshAtByKey.clear();
    refreshInFlightByKey.clear();
    lastUnknownAccountSnapshotAccessToken = null;
    try {
      await deps.clearSnapshot();
    } catch (err) {
      deps.onRefreshError(err);
    }
  }

  async function isRefreshStillCurrent(accessToken: string, accountId: string | null): Promise<boolean> {
    try {
      const currentAccessToken = await deps.readAccessToken();
      if (currentAccessToken !== accessToken) return false;
      const currentAccountId = await deps.readAccountId();
      return currentAccountId === accountId;
    } catch (err) {
      deps.onRefreshError(err);
      return false;
    }
  }

  function triggerRefresh(accessToken: string, accountId: string | null, force = false): Promise<void> {
    const key = refreshKey(accessToken, accountId);
    const existing = refreshInFlightByKey.get(key);
    if (existing) return existing.promise;

    const now = deps.now();
    const lastRefreshAt = lastRefreshAtByKey.get(key) ?? 0;
    if (!force && lastRefreshAt > 0 && now - lastRefreshAt < throttleMs) {
      return Promise.resolve();
    }

    lastRefreshAtByKey.set(key, now);
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
          lastUnknownAccountSnapshotAccessToken =
            accountId === null && (webSnapshot.accountId ?? null) === null
              ? accessToken
              : null;
        }
      } catch (err) {
        if (deps.isUnauthorizedError?.(err)) {
          if (await isRefreshStillCurrent(accessToken, accountId)) {
            await clearCachedSnapshot();
          }
          return;
        }
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
    let accessToken: string | null;
    try {
      accessToken = await deps.readAccessToken();
    } catch (err) {
      deps.onRefreshError(err);
      return await deps.readCachedSnapshot();
    }
    if (!accessToken) {
      await clearCachedSnapshot();
      return null;
    }

    let accountId: string | null = null;
    try {
      accountId = await deps.readAccountId();
    } catch (err) {
      deps.onRefreshError(err);
    }

    const cachedSnapshot = await deps.readCachedSnapshot();
    const cachedAccountId = cachedSnapshot?.accountId ?? null;
    if (cachedSnapshot && (cachedAccountId !== accountId
      || (accountId === null && lastUnknownAccountSnapshotAccessToken !== accessToken))) {
      await clearCachedSnapshot();
      if (!readOptions?.fresh) {
        void triggerRefresh(accessToken, accountId);
        return null;
      }
    }
    if (readOptions?.fresh) {
      // A request already in flight may have observed quota before the reset. Let it settle,
      // then fetch again without the UI read throttle; credential checks still guard publication.
      await refreshInFlightByKey.get(refreshKey(accessToken, accountId))?.promise;
      if (!await isRefreshStillCurrent(accessToken, accountId)) return null;
      await triggerRefresh(accessToken, accountId, true);
      return await isRefreshStillCurrent(accessToken, accountId) ? deps.readCachedSnapshot() : null;
    }
    void triggerRefresh(accessToken, accountId);
    return cachedSnapshot;
  };
}
