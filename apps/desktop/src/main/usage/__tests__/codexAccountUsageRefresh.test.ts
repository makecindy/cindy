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
      readAccessToken: async () => 'token', readAccountId: async () => 'account-id',
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
      readAccessToken: vi.fn().mockResolvedValue('token'),
      readAccountId: vi.fn().mockResolvedValue('account-id'),
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
        readAccessToken: vi.fn().mockResolvedValue('token'),
        readAccountId: vi.fn().mockResolvedValue('account-id'),
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
      readAccessToken: vi.fn().mockResolvedValue('token'),
      readAccountId: vi.fn().mockResolvedValue('account-id'),
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
    const readAccessToken = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue('token');
    const reader = createCodexAccountUsageSnapshotReader(
      {
        readAccessToken,
        readAccountId: vi.fn().mockResolvedValue('account-id'),
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
    await vi.waitFor(() => expect(readAccessToken).toHaveBeenCalledTimes(1));
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
    const readAccessToken = vi.fn()
      .mockRejectedValueOnce(new Error('keychain unavailable'))
      .mockResolvedValue('token');
    const onRefreshError = vi.fn();
    const reader = createCodexAccountUsageSnapshotReader(
      {
        readAccessToken,
        readAccountId: vi.fn().mockResolvedValue('account-id'),
        fetchWebUsageSnapshot,
        recordSnapshot,
        clearSnapshot: vi.fn().mockResolvedValue(undefined),
        readCachedSnapshot: vi.fn().mockResolvedValue(makeSnapshot('cached')),
        now: () => now,
        onRefreshError,
      },
      { throttleMs: 10_000 },
    );

    await reader();
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
        readAccessToken: vi.fn().mockResolvedValue('token'),
        readAccountId: vi.fn().mockResolvedValue('new-account'),
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
        readAccessToken: vi.fn().mockResolvedValue('token'),
        readAccountId: vi.fn().mockResolvedValue(null),
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
        readAccessToken: vi.fn().mockResolvedValue('token-b'),
        readAccountId: vi.fn().mockResolvedValue(null),
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
        readAccessToken: vi.fn().mockImplementation(async () => accessToken),
        readAccountId: vi.fn().mockImplementation(async () => accountId),
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
      readAccessToken: vi.fn().mockResolvedValue('token'),
      readAccountId: vi.fn().mockResolvedValue('account-id'),
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
});
