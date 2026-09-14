import { describe, expect, it, vi } from 'vitest';

import type { XaiSubscriptionUsageSnapshot } from '../../../shared/xaiSubscriptionUsage';
import {
  createXaiSubscriptionUsageReader,
  type XaiSubscriptionCredentialInfo,
} from '../xaiSubscriptionUsageRefresh';

class UnauthorizedError extends Error {}
class RateLimitedError extends Error {}

function makeSnapshot(updatedAt: number): XaiSubscriptionUsageSnapshot {
  return { planLabel: 'SuperGrok Heavy', creditUsagePercent: 2, source: 'cli-billing', updatedAt };
}

function makeDeps(overrides: Partial<{
  credentials: XaiSubscriptionCredentialInfo | null;
  cached: XaiSubscriptionUsageSnapshot | null;
  fetchSnapshot: ReturnType<typeof vi.fn>;
}> = {}) {
  const recordSnapshot = vi.fn().mockResolvedValue(undefined);
  const clearSnapshot = vi.fn().mockResolvedValue(undefined);
  const fetchSnapshot = overrides.fetchSnapshot
    ?? vi.fn().mockResolvedValue(makeSnapshot(1));
  const deps = {
    readCredentials: vi.fn(async () => (
      overrides.credentials === undefined
        ? { accessToken: 'token-a' }
        : overrides.credentials
    )),
    fetchSnapshot,
    recordSnapshot,
    clearSnapshot,
    readCachedSnapshot: vi.fn().mockResolvedValue(overrides.cached ?? null),
    now: () => 1_000_000,
    isUnauthorizedError: (err: unknown) => err instanceof UnauthorizedError,
    isRateLimitedError: (err: unknown) => err instanceof RateLimitedError,
    onRefreshError: vi.fn(),
  };
  return { deps, recordSnapshot, clearSnapshot, fetchSnapshot };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('createXaiSubscriptionUsageReader', () => {
  it('returns the cached snapshot immediately and refreshes in the background', async () => {
    const cached = makeSnapshot(0);
    const fresh = makeSnapshot(2);
    const { deps, recordSnapshot } = makeDeps({
      cached,
      fetchSnapshot: vi.fn().mockResolvedValue(fresh),
    });
    const reader = createXaiSubscriptionUsageReader(deps, { throttleMs: 1_000 });

    await expect(reader.read()).resolves.toBe(cached);
    await settle();
    expect(recordSnapshot).toHaveBeenCalledWith(fresh);
  });

  it('clears on logout and on explicit credential change before refetching', async () => {
    const { deps, clearSnapshot, fetchSnapshot } = makeDeps({
      cached: makeSnapshot(0),
    });
    const reader = createXaiSubscriptionUsageReader(deps, { throttleMs: 1 });

    deps.readCredentials = vi.fn(async () => null);
    await reader.syncForCredentialChange();
    expect(clearSnapshot).toHaveBeenCalledOnce();
    expect(fetchSnapshot).not.toHaveBeenCalled();

    clearSnapshot.mockClear();
    deps.readCredentials = vi.fn(async () => ({ accessToken: 'token-b' }));
    await reader.syncForCredentialChange();
    expect(clearSnapshot).toHaveBeenCalledOnce();
    await settle();
    expect(fetchSnapshot).toHaveBeenCalledWith({ accessToken: 'token-b' });
  });

  it('clears the snapshot on 401 and does not treat it as a login failure here', async () => {
    const { deps, clearSnapshot } = makeDeps({
      cached: makeSnapshot(0),
      fetchSnapshot: vi.fn().mockRejectedValue(new UnauthorizedError()),
    });
    const reader = createXaiSubscriptionUsageReader(deps, { throttleMs: 1 });
    await reader.read();
    await settle();
    expect(clearSnapshot).toHaveBeenCalled();
  });

  it('backs off on 429 and skips fetches until the window elapses', async () => {
    let now = 1_000_000;
    const fetchSnapshot = vi.fn().mockRejectedValue(new RateLimitedError());
    const { deps } = makeDeps({ fetchSnapshot });
    deps.now = () => now;
    const reader = createXaiSubscriptionUsageReader(deps, {
      throttleMs: 1,
      rateLimitBackoffInitialMs: 5_000,
    });

    reader.triggerRefresh();
    await settle();
    expect(fetchSnapshot).toHaveBeenCalledOnce();

    fetchSnapshot.mockClear();
    reader.triggerRefresh();
    await settle();
    expect(fetchSnapshot).not.toHaveBeenCalled();

    now += 5_001;
    reader.triggerRefresh();
    await settle();
    expect(fetchSnapshot).toHaveBeenCalledOnce();
  });

  it('does not refetch inside the throttle window', async () => {
    const fetchSnapshot = vi.fn().mockResolvedValue(makeSnapshot(1));
    const { deps } = makeDeps({ fetchSnapshot });
    const reader = createXaiSubscriptionUsageReader(deps, { throttleMs: 60_000 });
    await reader.read();
    await settle();
    fetchSnapshot.mockClear();
    reader.triggerRefresh();
    await settle();
    expect(fetchSnapshot).not.toHaveBeenCalled();
  });

  it('replays the latest account after an in-flight refresh is superseded by login', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchSnapshot = vi.fn(async (creds: XaiSubscriptionCredentialInfo) => {
      if (creds.accessToken === 'token-a') await gate;
      return makeSnapshot(1);
    });
    const { deps, recordSnapshot } = makeDeps({ fetchSnapshot });
    const reader = createXaiSubscriptionUsageReader(deps, { throttleMs: 1 });

    await reader.read();
    deps.readCredentials = vi.fn(async () => ({ accessToken: 'token-b' }));
    await reader.syncForCredentialChange();
    release();
    await settle();
    await settle();

    expect(fetchSnapshot).toHaveBeenCalledWith({ accessToken: 'token-b' });
    expect(recordSnapshot).toHaveBeenCalledWith(makeSnapshot(1));
  });

  it('keeps throttle after 401 so the next turn does not immediately refetch', async () => {
    const fetchSnapshot = vi.fn().mockRejectedValue(new UnauthorizedError());
    const { deps } = makeDeps({ fetchSnapshot });
    const reader = createXaiSubscriptionUsageReader(deps, { throttleMs: 60_000 });
    await reader.read();
    await settle();
    fetchSnapshot.mockClear();
    reader.triggerRefresh();
    await settle();
    expect(fetchSnapshot).not.toHaveBeenCalled();
  });

  it('clears the old snapshot before reading the new credential so a later read cannot leak it', async () => {
    let cached: XaiSubscriptionUsageSnapshot | null = {
      planLabel: 'OLD',
      creditUsagePercent: 9,
    };
    const { deps, clearSnapshot } = makeDeps({ cached });
    deps.clearSnapshot = vi.fn(async () => {
      cached = null;
    });
    deps.readCachedSnapshot = vi.fn(async () => cached);
    deps.readCredentials = vi.fn(async () => ({ accessToken: 'token-b' }));
    const reader = createXaiSubscriptionUsageReader(deps, { throttleMs: 1 });
    const sync = reader.syncForCredentialChange();
    await settle();
    expect(deps.clearSnapshot).toHaveBeenCalled();
    await expect(reader.read()).resolves.toBeNull();
    await sync;
  });

  it('replays the same token after a clear invalidates the in-flight generation', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let fetches = 0;
    const fetchSnapshot = vi.fn(async () => {
      fetches += 1;
      if (fetches === 1) await gate;
      return makeSnapshot(fetches);
    });
    const { deps, recordSnapshot } = makeDeps({ fetchSnapshot });
    const reader = createXaiSubscriptionUsageReader(deps, { throttleMs: 1 });
    const first = reader.read();
    await settle();
    await reader.syncForCredentialChange();
    release();
    await first;
    await settle();
    await settle();
    expect(fetchSnapshot.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(recordSnapshot).toHaveBeenCalled();
  });

  it('does not let a late stale read overwrite a newer queued account', async () => {
    let releaseFetchA!: () => void;
    const fetchAGate = new Promise<void>((resolve) => {
      releaseFetchA = resolve;
    });
    let releaseCache!: () => void;
    const cacheGate = new Promise<void>((resolve) => {
      releaseCache = resolve;
    });
    let cacheWaits = 0;
    const fetchSnapshot = vi.fn(async (creds: XaiSubscriptionCredentialInfo) => {
      if (creds.accessToken === 'token-a') await fetchAGate;
      return makeSnapshot(creds.accessToken === 'token-b' ? 2 : 1);
    });
    const { deps, recordSnapshot } = makeDeps({ fetchSnapshot });
    deps.readCachedSnapshot = vi.fn(async () => {
      cacheWaits += 1;
      if (cacheWaits >= 2) await cacheGate;
      return null;
    });
    const reader = createXaiSubscriptionUsageReader(deps, { throttleMs: 1 });

    const first = reader.read();
    await settle();
    const lateRead = reader.read();
    await settle();
    deps.readCredentials = vi.fn(async () => ({ accessToken: 'token-b' }));
    await reader.syncForCredentialChange();
    releaseCache();
    await lateRead;
    releaseFetchA();
    await first;
    await settle();
    await settle();
    await settle();

    expect(fetchSnapshot).toHaveBeenCalledWith({ accessToken: 'token-b' });
    expect(recordSnapshot).toHaveBeenCalledWith(makeSnapshot(2));
  });

  it('does not queue a second fetch for the same in-flight token', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchSnapshot = vi.fn(async () => {
      await gate;
      return makeSnapshot(1);
    });
    const { deps } = makeDeps({ fetchSnapshot });
    const reader = createXaiSubscriptionUsageReader(deps, { throttleMs: 1 });
    const first = reader.read();
    const second = reader.read();
    await Promise.all([first, second]);
    release();
    await settle();
    expect(fetchSnapshot).toHaveBeenCalledOnce();
  });
});
