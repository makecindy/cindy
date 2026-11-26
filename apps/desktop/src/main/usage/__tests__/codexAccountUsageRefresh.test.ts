import { describe, expect, it, vi } from 'vitest';
import { createCodexAccountUsageSnapshotReader } from '../codexAccountUsageRefresh';
import type { RateLimitSnapshot } from '../../usageBroadcaster';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeSnapshot(source: string, accountId: string | null = 'account-id'): RateLimitSnapshot {
  return { source, updatedAt: 1, accountId };
}

describe('createCodexAccountUsageSnapshotReader', () => {
  it('fresh reads wait out a pre-reset request and bypass the UI throttle', async () => {
    // Reset recovery needs a post-reset response, not the 100% request already in flight.
    let cached = { ...makeSnapshot('openai-web'), secondary: { usedPercent: 100 } };
    const oldRequest = deferred<RateLimitSnapshot | null>();
    const fresh = { ...cached, secondary: { usedPercent: 0 } };
    const fetchWebUsageSnapshot = vi.fn().mockReturnValueOnce(oldRequest.promise).mockResolvedValue(fresh);
    const reader = createCodexAccountUsageSnapshotReader({
      readCredentials: async () => ({ accessToken: 'token', accountId: 'account-id' }),
      fetchWebUsageSnapshot, recordSnapshot: async value => { cached = value as typeof cached; },
      clearSnapshot: async () => {}, readCachedSnapshot: async () => cached,
      now: () => 10_000, onRefreshError: vi.fn(),
    });
    await reader();
    const recovery = reader({ fresh: true });
    oldRequest.resolve(cached);
    await expect(recovery).resolves.toBe(fresh);
    expect(fetchWebUsageSnapshot).toHaveBeenCalledTimes(2);
  });

  it('returns cached snapshot before the web refresh settles', async () => {
    const cached = makeSnapshot('cached');
    const web = makeSnapshot('openai-web');
    const fetchDeferred = deferred<RateLimitSnapshot | null>();
    const recordSnapshot = vi.fn().mockResolvedValue(undefined);
    const reader = createCodexAccountUsageSnapshotReader({
      readCredentials: async () => ({ accessToken: 'token', accountId: 'account-id' }),
      fetchWebUsageSnapshot: vi.fn().mockReturnValue(fetchDeferred.promise),
      recordSnapshot,
      clearSnapshot: vi.fn().mockResolvedValue(undefined),
      readCachedSnapshot: vi.fn().mockResolvedValue(cached),
      now: () => 10_000,
      onRefreshError: vi.fn(),
    });

    await expect(reader()).resolves.toBe(cached);
    expect(recordSnapshot).not.toHaveBeenCalled();

    fetchDeferred.resolve(web);
    await fetchDeferred.promise;
    await vi.waitFor(() => expect(recordSnapshot).toHaveBeenCalledWith(web));
  });

  it('coalesces concurrent refreshes and throttles repeated reads', async () => {
    let now = 10_000;
    const firstWeb = makeSnapshot('first');
    const fetchDeferred = deferred<RateLimitSnapshot | null>();
    const fetchWebUsageSnapshot = vi.fn().mockReturnValueOnce(fetchDeferred.promise);
    const reader = createCodexAccountUsageSnapshotReader(
      {
        readCredentials: async () => ({ accessToken: 'token', accountId: 'account-id' }),
        fetchWebUsageSnapshot,
        recordSnapshot: vi.fn().mockResolvedValue(undefined),
        clearSnapshot: vi.fn().mockResolvedValue(undefined),
        readCachedSnapshot: vi.fn().mockResolvedValue(makeSnapshot('cached')),
        now: () => now,
        onRefreshError: vi.fn(),
      },
      { throttleMs: 10_000 },
    );

    await Promise.all([reader(), reader()]);
    await vi.waitFor(() => expect(fetchWebUsageSnapshot).toHaveBeenCalledTimes(1));

    fetchDeferred.resolve(firstWeb);
    await fetchDeferred.promise;
    await vi.waitFor(() => expect(fetchWebUsageSnapshot).toHaveBeenCalledTimes(1));

    now += 9_999;
    await reader();
    expect(fetchWebUsageSnapshot).toHaveBeenCalledTimes(1);

    now += 2;
    fetchWebUsageSnapshot.mockResolvedValueOnce(makeSnapshot('second'));
    await reader();
    await vi.waitFor(() => expect(fetchWebUsageSnapshot).toHaveBeenCalledTimes(2));
  });

  it('keeps cached reads available when background refresh fails', async () => {
    const onRefreshError = vi.fn();
    const cached = makeSnapshot('cached');
    const reader = createCodexAccountUsageSnapshotReader({
      readCredentials: async () => ({ accessToken: 'token', accountId: 'account-id' }),
      fetchWebUsageSnapshot: vi.fn().mockRejectedValue(new Error('offline')),
      recordSnapshot: vi.fn().mockResolvedValue(undefined),
      clearSnapshot: vi.fn().mockResolvedValue(undefined),
      readCachedSnapshot: vi.fn().mockResolvedValue(cached),
      now: () => 10_000,
      onRefreshError,
    });

    await expect(reader()).resolves.toBe(cached);
    await vi.waitFor(() => expect(onRefreshError).toHaveBeenCalledWith(expect.any(Error)));
  });

  it('does not throttle the next refresh when the access token is missing', async () => {
    let now = 10_000;
    const fetchWebUsageSnapshot = vi.fn().mockResolvedValue(makeSnapshot('openai-web'));
    const recordSnapshot = vi.fn().mockResolvedValue(undefined);
    const clearSnapshot = vi.fn().mockResolvedValue(undefined);
    const readCredentials = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ accessToken: 'token', accountId: 'account-id' });
    const reader = createCodexAccountUsageSnapshotReader(
      {
        readCredentials,
        fetchWebUsageSnapshot,
        recordSnapshot,
        clearSnapshot,
        readCachedSnapshot: vi.fn().mockResolvedValue(makeSnapshot('cached')),
        now: () => now,
        onRefreshError: vi.fn(),
      },
      { throttleMs: 10_000 },
    );

    await reader();
    await vi.waitFor(() => expect(readCredentials).toHaveBeenCalledTimes(1));
    expect(clearSnapshot).toHaveBeenCalledTimes(1);
    expect(fetchWebUsageSnapshot).not.toHaveBeenCalled();

    now += 1;
    await reader();
    await vi.waitFor(() => expect(fetchWebUsageSnapshot).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(recordSnapshot).toHaveBeenCalledWith(makeSnapshot('openai-web')));
  });

  it('does not throttle the next refresh when reading the access token fails', async () => {
    let now = 10_000;
    const fetchWebUsageSnapshot = vi.fn().mockResolvedValue(makeSnapshot('openai-web'));
    const recordSnapshot = vi.fn().mockResolvedValue(undefined);
    const readCredentials = vi.fn()
      .mockRejectedValueOnce(new Error('keychain unavailable'))
      .mockResolvedValue({ accessToken: 'token', accountId: 'account-id' });
    const onRefreshError = vi.fn();
    const reader = createCodexAccountUsageSnapshotReader(
      {
        readCredentials,
        fetchWebUsageSnapshot,
        recordSnapshot,
        clearSnapshot: vi.fn().mockResolvedValue(undefined),
        readCachedSnapshot: vi.fn().mockResolvedValue(makeSnapshot('cached')),
        now: () => now,
        onRefreshError,
      },
      { throttleMs: 10_000 },
    );

    await expect(reader()).resolves.toEqual(makeSnapshot('cached'));
    await vi.waitFor(() => expect(onRefreshError).toHaveBeenCalledWith(expect.any(Error)));
    expect(fetchWebUsageSnapshot).not.toHaveBeenCalled();

    now += 1;
    await reader();
    await vi.waitFor(() => expect(fetchWebUsageSnapshot).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(recordSnapshot).toHaveBeenCalledWith(makeSnapshot('openai-web')));
  });

  it.each([false, true])('clears cached usage when the account id changed (fresh=%s)', async fresh => {
    let cached: RateLimitSnapshot | null = makeSnapshot('cached', 'old-account');
    const web = makeSnapshot('openai-web', 'new-account');
    const fetchWebUsageSnapshot = vi.fn().mockResolvedValue(web);
    const clearSnapshot = vi.fn(async () => { cached = null; });
    const reader = createCodexAccountUsageSnapshotReader(
      {
        readCredentials: async () => ({ accessToken: 'token', accountId: 'new-account' }),
        fetchWebUsageSnapshot,
        recordSnapshot: vi.fn(async (value: RateLimitSnapshot) => { cached = value; }),
        clearSnapshot,
        readCachedSnapshot: async () => cached,
        now: () => 10_000,
        onRefreshError: vi.fn(),
      },
      { throttleMs: 10_000 },
    );

    await expect(reader({ fresh })).resolves.toBe(fresh ? web : null);
    expect(clearSnapshot).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(fetchWebUsageSnapshot).toHaveBeenCalledTimes(1));
  });

  it('clears cached usage when the cached account id becomes unknown', async () => {
    const fetchWebUsageSnapshot = vi.fn().mockResolvedValue(makeSnapshot('openai-web', null));
    const clearSnapshot = vi.fn().mockResolvedValue(undefined);
    const reader = createCodexAccountUsageSnapshotReader(
      {
        readCredentials: async () => ({ accessToken: 'token', accountId: null }),
        fetchWebUsageSnapshot,
        recordSnapshot: vi.fn().mockResolvedValue(undefined),
        clearSnapshot,
        readCachedSnapshot: vi.fn().mockResolvedValue(makeSnapshot('cached', 'old-account')),
        now: () => 10_000,
        onRefreshError: vi.fn(),
      },
      { throttleMs: 10_000 },
    );

    await expect(reader()).resolves.toBeNull();
    expect(clearSnapshot).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(fetchWebUsageSnapshot).toHaveBeenCalledWith({
      accessToken: 'token',
      accountId: null,
    }));
  });

  it('does not reuse null-account cached usage until the current token refreshes it', async () => {
    let cachedSnapshot: RateLimitSnapshot | null = makeSnapshot('cached-old', null);
    const refreshedSnapshot = makeSnapshot('openai-web', null);
    const fetchWebUsageSnapshot = vi.fn().mockResolvedValue(refreshedSnapshot);
    const recordSnapshot = vi.fn().mockImplementation(async (snapshot: RateLimitSnapshot) => {
      cachedSnapshot = snapshot;
    });
    const clearSnapshot = vi.fn().mockImplementation(async () => {
      cachedSnapshot = null;
    });
    const reader = createCodexAccountUsageSnapshotReader(
      {
        readCredentials: async () => ({ accessToken: 'token-b', accountId: null }),
        fetchWebUsageSnapshot,
        recordSnapshot,
        clearSnapshot,
        readCachedSnapshot: vi.fn().mockImplementation(async () => cachedSnapshot),
        now: () => 10_000,
        onRefreshError: vi.fn(),
      },
      { throttleMs: 10_000 },
    );

    await expect(reader()).resolves.toBeNull();
    expect(clearSnapshot).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(recordSnapshot).toHaveBeenCalledWith(refreshedSnapshot));

    await expect(reader()).resolves.toEqual(refreshedSnapshot);
    expect(clearSnapshot).toHaveBeenCalledTimes(1);
    expect(fetchWebUsageSnapshot).toHaveBeenCalledTimes(1);
  });

  it('starts a new refresh after account switch and drops stale in-flight results', async () => {
    let accessToken = 'token-a';
    let accountId = 'account-a';
    let cachedSnapshot: RateLimitSnapshot | null = makeSnapshot('cached', 'account-a');
    const accountADeferred = deferred<RateLimitSnapshot | null>();
    const accountBDeferred = deferred<RateLimitSnapshot | null>();
    const fetchWebUsageSnapshot = vi.fn(({ accessToken: token }) =>
      token === 'token-a' ? accountADeferred.promise : accountBDeferred.promise,
    );
    const recordSnapshot = vi.fn().mockResolvedValue(undefined);
    const clearSnapshot = vi.fn().mockImplementation(async () => {
      cachedSnapshot = null;
    });
    const reader = createCodexAccountUsageSnapshotReader(
      {
        readCredentials: async () => ({ accessToken, accountId }),
        fetchWebUsageSnapshot,
        recordSnapshot,
        clearSnapshot,
        readCachedSnapshot: vi.fn().mockImplementation(async () => cachedSnapshot),
        now: () => 10_000,
        onRefreshError: vi.fn(),
      },
      { throttleMs: 10_000 },
    );

    await expect(reader()).resolves.toEqual(makeSnapshot('cached', 'account-a'));
    await vi.waitFor(() => expect(fetchWebUsageSnapshot).toHaveBeenCalledWith({
      accessToken: 'token-a',
      accountId: 'account-a',
    }));

    accessToken = 'token-b';
    accountId = 'account-b';
    await expect(reader()).resolves.toBeNull();
    await vi.waitFor(() => expect(fetchWebUsageSnapshot).toHaveBeenCalledWith({
      accessToken: 'token-b',
      accountId: 'account-b',
    }));

    accountADeferred.resolve(makeSnapshot('openai-web-a', 'account-a'));
    await accountADeferred.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(recordSnapshot).not.toHaveBeenCalledWith(makeSnapshot('openai-web-a', 'account-a'));

    accountBDeferred.resolve(makeSnapshot('openai-web-b', 'account-b'));
    await accountBDeferred.promise;
    await vi.waitFor(() =>
      expect(recordSnapshot).toHaveBeenCalledWith(makeSnapshot('openai-web-b', 'account-b')),
    );
    expect(recordSnapshot).toHaveBeenCalledTimes(1);
  });

  it('clears cached usage when the background refresh reports unauthorized', async () => {
    const unauthorized = new Error('unauthorized');
    const clearSnapshot = vi.fn().mockResolvedValue(undefined);
    const onRefreshError = vi.fn();
    const reader = createCodexAccountUsageSnapshotReader({
      readCredentials: async () => ({ accessToken: 'token', accountId: 'account-id' }),
      fetchWebUsageSnapshot: vi.fn().mockRejectedValue(unauthorized),
      recordSnapshot: vi.fn().mockResolvedValue(undefined),
      clearSnapshot,
      readCachedSnapshot: vi.fn().mockResolvedValue(makeSnapshot('cached')),
      now: () => 10_000,
      isUnauthorizedError: (err) => err === unauthorized,
      onRefreshError,
    });

    await expect(reader()).resolves.toEqual(makeSnapshot('cached'));
    await vi.waitFor(() => expect(clearSnapshot).toHaveBeenCalledTimes(1));
    expect(onRefreshError).not.toHaveBeenCalled();
  });

  // Adaptive throttling: idle polls stay on 30m cadence, turn activity switches to 5m,
  // crossing resetsAt triggers a single re-check after 5m, and failures back off exponentially.
  it('throttles idle polls for 30m, shortens to 5m after turn activity, and rechecks once across reset boundary', async () => {
    let now = 1_000_000;
    const resetSec = Math.floor((now + 10 * 60_000) / 1000);
    let cached: RateLimitSnapshot = {
      ...makeSnapshot('cached'),
      primary: { usedPercent: 50, resetsAt: resetSec },
    };
    const fetchWebUsageSnapshot = vi.fn(async () => ({
      ...makeSnapshot('openai-web'),
      primary: { usedPercent: 50, resetsAt: resetSec },
    }));
    const reader = createCodexAccountUsageSnapshotReader({
      readCredentials: async () => ({ accessToken: 'token', accountId: 'account-id' }),
      fetchWebUsageSnapshot,
      recordSnapshot: async (snap) => { cached = snap; },
      clearSnapshot: async () => {},
      readCachedSnapshot: async () => cached,
      now: () => now,
      onRefreshError: vi.fn(),
    });

    // Cold read fetches immediately.
    await reader();
    await vi.waitFor(() => expect(fetchWebUsageSnapshot).toHaveBeenCalledTimes(1));

    // Passive poll at +8m stays throttled (idle TTL = 30m, reset at +10m not yet crossed).
    now += 8 * 60_000;
    await reader();
    expect(fetchWebUsageSnapshot).toHaveBeenCalledTimes(1);

    // Crossing resetsAt (+10m, age >= 5m) triggers one re-check even while idle.
    now += 2 * 60_000;
    await reader();
    await vi.waitFor(() => expect(fetchWebUsageSnapshot).toHaveBeenCalledTimes(2));

    // Stale reset timestamp after refresh does not cause a loop.
    now += 6 * 60_000;
    await reader();
    expect(fetchWebUsageSnapshot).toHaveBeenCalledTimes(2);

    // Real turn activity switches to the 5m active cadence (age is already 6m >= 5m).
    await reader({ activity: true });
    await vi.waitFor(() => expect(fetchWebUsageSnapshot).toHaveBeenCalledTimes(3));

    // Another turn within 5m is throttled, then triggers at +5m.
    now += 4 * 60_000;
    await reader({ activity: true });
    expect(fetchWebUsageSnapshot).toHaveBeenCalledTimes(3);
    now += 60_000;
    await reader();
    await vi.waitFor(() => expect(fetchWebUsageSnapshot).toHaveBeenCalledTimes(4));

    // Without further turns, idle polls wait the full 30m.
    now += 29 * 60_000;
    await reader();
    expect(fetchWebUsageSnapshot).toHaveBeenCalledTimes(4);
    now += 60_000;
    await reader();
    await vi.waitFor(() => expect(fetchWebUsageSnapshot).toHaveBeenCalledTimes(5));
  });

  it('backs off exponentially on transient failures while fresh reads still bypass backoff', async () => {
    let now = 1_000_000;
    let cached = makeSnapshot('cached');
    const onRefreshError = vi.fn();
    const fetchWebUsageSnapshot = vi.fn()
      .mockRejectedValueOnce(new Error('503'))
      .mockRejectedValueOnce(new Error('503'))
      .mockResolvedValue(makeSnapshot('recovered'));
    const reader = createCodexAccountUsageSnapshotReader({
      readCredentials: async () => ({ accessToken: 'token', accountId: 'account-id' }),
      fetchWebUsageSnapshot,
      recordSnapshot: async (snap) => { cached = snap; },
      clearSnapshot: async () => {},
      readCachedSnapshot: async () => cached,
      now: () => now,
      onRefreshError,
    });

    await reader({ activity: true });
    await vi.waitFor(() => expect(onRefreshError).toHaveBeenCalledTimes(1));

    // Inside 5m backoff: even active read is suppressed.
    now += 4 * 60_000;
    await reader({ activity: true });
    expect(fetchWebUsageSnapshot).toHaveBeenCalledTimes(1);

    // At 5m: retries once, fails -> doubles backoff to 10m.
    now += 60_000;
    await reader({ activity: true });
    await vi.waitFor(() => expect(onRefreshError).toHaveBeenCalledTimes(2));

    now += 9 * 60_000;
    await reader({ activity: true });
    expect(fetchWebUsageSnapshot).toHaveBeenCalledTimes(2);

    // Fresh recovery read bypasses backoff immediately and resets it on success.
    await expect(reader({ fresh: true })).resolves.toEqual(makeSnapshot('recovered'));
    expect(fetchWebUsageSnapshot).toHaveBeenCalledTimes(3);
  });

  it('recovers when the wall clock jumps backwards past the last refresh timestamp', async () => {
    let now = 10_000_000;
    const fetchWebUsageSnapshot = vi.fn().mockResolvedValue(makeSnapshot('openai-web'));
    const reader = createCodexAccountUsageSnapshotReader({
      readCredentials: async () => ({ accessToken: 'token', accountId: 'account-id' }),
      fetchWebUsageSnapshot,
      recordSnapshot: async () => {},
      clearSnapshot: async () => {},
      readCachedSnapshot: async () => makeSnapshot('cached'),
      now: () => now,
      onRefreshError: vi.fn(),
    });

    await reader();
    await vi.waitFor(() => expect(fetchWebUsageSnapshot).toHaveBeenCalledTimes(1));

    // Minor backward jitter (<60s) stays throttled; major jump (>60s) allows a fresh read.
    now -= 30_000;
    await reader();
    expect(fetchWebUsageSnapshot).toHaveBeenCalledTimes(1);

    now -= 120_000;
    await reader();
    await vi.waitFor(() => expect(fetchWebUsageSnapshot).toHaveBeenCalledTimes(2));
  });
});
