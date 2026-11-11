import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clearAllProviderShareCatalogs,
  evictProviderShareCatalogs,
  getCachedProviderShareCatalogs,
  isProviderShareCatalogComplete,
  parseProviderShareCatalogPayload,
  parseProviderShareCatalogs,
  refreshProviderShareCatalogs,
  subscribeProviderShareCatalogs,
  type ProviderShareCatalogEntry,
} from '@/device-link/providerShareCatalogCache';

const anthropic = {
  id: 'anthropic',
  name: 'Anthropic',
  agents: ['claude-code', 'pi'],
  connected: true,
  remoteInvocationEnabled: true,
  models: {
    'claude-code': [
      { id: 'claude-x', name: 'Claude X', contextWindow: 200_000, efforts: ['low', 'high'], defaultEffort: 'high' },
      { id: '', name: 'Broken', contextWindow: 1, efforts: [] },
    ],
  },
  routing: { 'claude-code': { wireProtocol: 'anthropic-messages' } },
};
const other = { ...anthropic, id: 'other', name: 'Other' };

const rawShare = (patch: Record<string, unknown> = {}) => ({
  agentDeviceId: 'share:share-1',
  shareId: 'share-1',
  providerId: 'anthropic',
  providerLabel: 'Anthropic',
  deviceName: "Magi's Mac Mini",
  owner: { displayName: 'Magi', avatarUrl: null },
  status: 'active',
  hostOnline: true,
  catalog: {
    providers: [anthropic, other],
    providerOrder: ['anthropic'],
    modelVisibilityOverrides: { 'claude-code:anthropic:claude-x': true, junk: 'yes' },
  },
  ...patch,
});

const withRemaining = (share: ReturnType<typeof rawShare>, remainingMs = 1000) => ({
  ...share,
  catalog: { ...(share.catalog as Record<string, unknown>),
    providerContinuity: { stale: true, remainingMs } },
});

afterEach(() => {
  clearAllProviderShareCatalogs();
  vi.useRealTimers();
});

it('keeps the favorite identity for this share and drops one that names another share', () => {
  const favoriteSource = {
    shareId: 'share-1', memberId: 'member-1', providerId: 'anthropic', owner: { region: 'global' as const },
  };
  expect(parseProviderShareCatalogs({ shares: [rawShare({ favoriteSource })] })[0]?.favoriteSource)
    .toEqual(favoriteSource);
  const dropped = parseProviderShareCatalogs({ shares: [rawShare({
    favoriteSource: { ...favoriteSource, shareId: 'other' },
  })] })[0];
  expect(dropped?.favoriteSource).toBeUndefined();
  expect(dropped?.shareId).toBe('share-1');
});

// Unit: failed refreshes used to keep re-exporting one share catalog indefinitely.
it('expires a retained share catalog after its original budget and never revives it from a failed refresh', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] });
  const snapshot = rawShare();
  const first = { ...snapshot, catalog: { ...snapshot.catalog, providerContinuity: { stale: true, remainingMs: 1000 } } };
  await refreshProviderShareCatalogs('host', async () => ({ shares: [first] }));
  await vi.advanceTimersByTimeAsync(700);
  await refreshProviderShareCatalogs('host', async () => ({ shares: [rawShare({ hostOnline: false, catalog: null })] }));
  expect(getCachedProviderShareCatalogs('host')?.[0].payload?.providers).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(301);
  expect(getCachedProviderShareCatalogs('host')?.[0].payload).toBeNull();
  await refreshProviderShareCatalogs('host', async () => ({ shares: [rawShare({ catalog: null })] }));
  expect(getCachedProviderShareCatalogs('host')?.[0].payload).toBeNull();
  await refreshProviderShareCatalogs('host', async () => ({ shares: [rawShare({ status: 'paused' })] }));
  expect(getCachedProviderShareCatalogs('host')?.[0].payload).toBeNull();
});

// Unit: a suspended JS runtime can wake after the wall-clock deadline but before
// the expiry timer callback runs. The synchronous cache read must not hand the
// expired payload back while it is retiring that same entry.
// Minimal input: one catalog with 1s remaining, jump the wall clock past it.
it('does not return an expired catalog when the expiry timer has not run yet', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] });
  const snapshot = rawShare();
  await refreshProviderShareCatalogs('host', async () => ({ shares: [{ ...snapshot,
    catalog: { ...snapshot.catalog, providerContinuity: { stale: true, remainingMs: 1000 } } }] }));
  vi.setSystemTime(Date.now() + 1001);
  expect(getCachedProviderShareCatalogs('host')?.[0].payload).toBeNull();
});

it('defers a getter-discovered expiry notification until after the synchronous read', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] });
  const snapshot = rawShare();
  await refreshProviderShareCatalogs('host', async () => ({ shares: [{ ...snapshot,
    catalog: { ...snapshot.catalog, providerContinuity: { stale: true, remainingMs: 1000 } } }] }));
  const events = vi.fn();
  const off = subscribeProviderShareCatalogs('host', events);
  vi.setSystemTime(Date.now() + 1001);
  expect(getCachedProviderShareCatalogs('host')?.[0].payload).toBeNull();
  // A mounted React consumer must not be updated while the getter is running.
  expect(events).not.toHaveBeenCalled();
  await Promise.resolve();
  expect(events).toHaveBeenCalledTimes(1);
  expect(events.mock.calls[0][0]?.[0]?.payload).toBeNull();
  off();
});

describe('provider share catalog parsing', () => {
  it('keeps only the shared provider, drops invalid models and fills routing like Desktop', () => {
    const payload = parseProviderShareCatalogPayload(rawShare().catalog, 'anthropic');
    expect(payload?.providers.map((provider) => provider.id)).toEqual(['anthropic']);
    expect(payload?.providers[0].models['claude-code']?.map((model) => model.id)).toEqual(['claude-x']);
    expect(payload?.providers[0].routing).toEqual({
      'claude-code': { wireProtocol: 'anthropic-messages' },
      pi: {},
    });
    expect(payload?.modelVisibilityOverrides).toEqual({ 'claude-code:anthropic:claude-x': true });
    // 入参不被改写。
    expect(anthropic.models['claude-code']).toHaveLength(2);
  });

  it('treats unreadable catalogs as missing and readable ones without the shared provider as empty', () => {
    expect(parseProviderShareCatalogPayload(null, 'anthropic')).toBeNull();
    expect(parseProviderShareCatalogPayload({ providers: 'x' }, 'anthropic')).toBeNull();
    for (const providers of [
      [],
      [other],
      [{ ...anthropic, connected: 'yes' }],
      [{ ...anthropic, routing: { pi: { wireProtocol: 'smtp' } } }],
      [{ ...anthropic, models: { 'claude-code': 'x' } }],
    ]) {
      expect(parseProviderShareCatalogPayload({ providers }, 'anthropic')).toEqual({ providers: [] });
    }
  });

  it('parses the received list, skipping invalid shares and keeping only nickname identity', () => {
    const entries = parseProviderShareCatalogs({
      shares: [
        rawShare(),
        rawShare({ shareId: 'paused', agentDeviceId: 'share:paused', status: 'paused', catalog: null }),
        rawShare({ shareId: 'bad', agentDeviceId: 'share:other' }),
        rawShare({ shareId: 'nameless', agentDeviceId: 'share:nameless', owner: { displayName: '' } }),
      ],
    });
    expect(entries.map((entry) => [entry.agentDeviceId, entry.status, entry.payload ? 'catalog' : null])).toEqual([
      ['share:share-1', 'active', 'catalog'],
      ['share:paused', 'paused', null],
    ]);
    expect(entries[0]).toMatchObject({ providerLabel: 'Anthropic', ownerName: 'Magi', providerId: 'anthropic' });
    // 分享者的电脑名不带进手机的分享条目(provider-sharing.md §6)。
    expect(entries[0]).not.toHaveProperty('deviceName');
    expect(parseProviderShareCatalogs({ nope: true })).toEqual([]);
  });
});

describe('provider share catalog cache', () => {
  it('caches per controlled computer and notifies mounted pickers', async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeProviderShareCatalogs('controlled', listener);
    const entries = await refreshProviderShareCatalogs('controlled', async () => ({ shares: [rawShare()] }));
    expect(entries).toHaveLength(1);
    expect(getCachedProviderShareCatalogs('controlled')).toBe(entries);
    expect(getCachedProviderShareCatalogs('elsewhere')).toBeUndefined();
    expect(listener).toHaveBeenCalledWith(entries);
    unsubscribe();
  });

  it('keeps known shares and marks the list incomplete while a region is still loading', async () => {
    const second = rawShare({ shareId: 'share-2', agentDeviceId: 'share:share-2' });
    await refreshProviderShareCatalogs('host', async () => ({ ready: true, shares: [rawShare(), second] }));
    expect(getCachedProviderShareCatalogs('host')).toHaveLength(2);
    expect(isProviderShareCatalogComplete('host')).toBe(true);

    await refreshProviderShareCatalogs('host', async () => ({ ready: false, shares: [rawShare()] }));
    expect(getCachedProviderShareCatalogs('host')?.map(share => share.agentDeviceId))
      .toEqual(['share:share-1', 'share:share-2']);
    expect(isProviderShareCatalogComplete('host')).toBe(false);

    await refreshProviderShareCatalogs('host', async () => ({ ready: true, shares: [rawShare()] }));
    expect(getCachedProviderShareCatalogs('host')?.map(share => share.agentDeviceId)).toEqual(['share:share-1']);
    expect(isProviderShareCatalogComplete('host')).toBe(true);
  });

  it('retires a retained missing share at its original directory deadline and never renews it on partial reads', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] });
    const a = withRemaining(rawShare({ shareId: 'a', agentDeviceId: 'share:a' }));
    const b = withRemaining(rawShare({ shareId: 'b', agentDeviceId: 'share:b' }));
    const c = withRemaining(rawShare({ shareId: 'c', agentDeviceId: 'share:c' }));
    const events = vi.fn();
    const off = subscribeProviderShareCatalogs('host', events);
    await refreshProviderShareCatalogs('host', async () => ({ ready: true, shares: [a, b] }));
    await vi.advanceTimersByTimeAsync(500);
    await refreshProviderShareCatalogs('host', async () => ({ ready: false, shares: [c] }));
    expect(getCachedProviderShareCatalogs('host')?.map(share => share.agentDeviceId))
      .toEqual(['share:c', 'share:a', 'share:b']);

    await vi.advanceTimersByTimeAsync(400);
    await refreshProviderShareCatalogs('host', async () => ({ ready: false, shares: [c] }));
    expect(getCachedProviderShareCatalogs('host')?.map(share => share.agentDeviceId))
      .toEqual(['share:c', 'share:a', 'share:b']);

    await vi.advanceTimersByTimeAsync(100);
    expect(getCachedProviderShareCatalogs('host')?.map(share => share.agentDeviceId)).toEqual(['share:c']);
    expect(getCachedProviderShareCatalogs('host')?.[0].payload).not.toBeNull();
    expect(events.mock.calls.at(-1)?.[0].map((share: ProviderShareCatalogEntry) => share.agentDeviceId))
      .toEqual(['share:c']);
    off();
  });

  it('removes a retained share immediately when a complete list omits it', async () => {
    const a = withRemaining(rawShare({ shareId: 'a', agentDeviceId: 'share:a' }));
    const c = withRemaining(rawShare({ shareId: 'c', agentDeviceId: 'share:c' }));
    await refreshProviderShareCatalogs('host', async () => ({ ready: true, shares: [a] }));
    await refreshProviderShareCatalogs('host', async () => ({ ready: false, shares: [c] }));
    expect(getCachedProviderShareCatalogs('host')?.map(share => share.agentDeviceId))
      .toEqual(['share:c', 'share:a']);

    await refreshProviderShareCatalogs('host', async () => ({ ready: true, shares: [c] }));
    expect(getCachedProviderShareCatalogs('host')?.map(share => share.agentDeviceId)).toEqual(['share:c']);
  });

  it('starts a bounded absence window when a present entry had no readable catalog', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] });
    const a = withRemaining(rawShare({ shareId: 'a', agentDeviceId: 'share:a' }), 1000);
    const c = withRemaining(rawShare({ shareId: 'c', agentDeviceId: 'share:c' }), 1000);
    await refreshProviderShareCatalogs('host', async () => ({ ready: true, shares: [a] }));
    await vi.advanceTimersByTimeAsync(1001);
    expect(getCachedProviderShareCatalogs('host')?.[0].payload).toBeNull();

    await refreshProviderShareCatalogs('host', async () => ({ ready: false,
      shares: [{ ...a, catalog: null }, c] }));
    expect(getCachedProviderShareCatalogs('host')?.[0].payload).toBeNull();

    await refreshProviderShareCatalogs('host', async () => ({ ready: false, shares: [c] }));
    expect(getCachedProviderShareCatalogs('host')?.map(share => share.agentDeviceId))
      .toEqual(['share:c', 'share:a']);
    await vi.advanceTimersByTimeAsync(30 * 60_000 - 1);
    expect(getCachedProviderShareCatalogs('host')?.map(share => share.agentDeviceId))
      .toEqual(['share:c', 'share:a']);
    await vi.advanceTimersByTimeAsync(1);
    expect(getCachedProviderShareCatalogs('host')?.map(share => share.agentDeviceId)).toEqual(['share:c']);
  });

  it.each(['wall', 'mono'] as const)('notifies subscribers when a synchronous read prunes an expired retained entry (%s clock)', async clock => {
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] });
    const a = withRemaining(rawShare({ shareId: 'a', agentDeviceId: 'share:a' }), 1000);
    const c = withRemaining(rawShare({ shareId: 'c', agentDeviceId: 'share:c' }), 60_000);
    await refreshProviderShareCatalogs('host', async () => ({ ready: true, shares: [a] }));
    await refreshProviderShareCatalogs('host', async () => ({ ready: false, shares: [c] }));
    const events = vi.fn();
    const off = subscribeProviderShareCatalogs('host', events);
    events.mockClear();

    const wallStart = Date.now(), monoStart = performance.now();
    const restore = clock === 'wall'
      ? vi.spyOn(Date, 'now').mockReturnValue(wallStart + 1001)
      : vi.spyOn(performance, 'now').mockReturnValue(monoStart + 1001);
    try {
      expect(getCachedProviderShareCatalogs('host')?.map(share => share.agentDeviceId)).toEqual(['share:c']);
      expect(getCachedProviderShareCatalogs('host')?.map(share => share.agentDeviceId)).toEqual(['share:c']);
      expect(events).not.toHaveBeenCalled();
      await Promise.resolve();
      expect(events).toHaveBeenCalledTimes(1);
      expect(events.mock.calls[0][0].map((share: ProviderShareCatalogEntry) => share.agentDeviceId))
        .toEqual(['share:c']);
    } finally {
      restore.mockRestore();
      off();
    }
  });

  it('starts the absence window from the last present observation, not the first missing read', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] });
    const a = rawShare({ shareId: 'a', agentDeviceId: 'share:a', catalog: null });
    const c = rawShare({ shareId: 'c', agentDeviceId: 'share:c', catalog: null });
    await refreshProviderShareCatalogs('host', async () => ({ ready: true, shares: [a] }));
    await vi.advanceTimersByTimeAsync(29 * 60_000);
    await refreshProviderShareCatalogs('host', async () => ({ ready: false, shares: [c] }));
    expect(getCachedProviderShareCatalogs('host')?.map(share => share.agentDeviceId))
      .toEqual(['share:c', 'share:a']);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getCachedProviderShareCatalogs('host')?.map(share => share.agentDeviceId)).toEqual(['share:c']);
  });

  it('clears the cache and notifies mounted pickers on an explicit provider-share denial', async () => {
    await refreshProviderShareCatalogs('host', async () => ({ ready: true,
      shares: [withRemaining(rawShare({ shareId: 'a', agentDeviceId: 'share:a' }))] }));
    const events = vi.fn();
    const off = subscribeProviderShareCatalogs('host', events);
    await expect(refreshProviderShareCatalogs('host', async () => {
      throw Object.assign(new Error('[ACCESS_REVOKED] denied'), { code: 'ACCESS_REVOKED' });
    })).rejects.toThrow('ACCESS_REVOKED');
    expect(getCachedProviderShareCatalogs('host')).toBeUndefined();
    expect(events).toHaveBeenLastCalledWith([]);
    off();
  });

  it('clears mounted pickers when the controlled computer is evicted', async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeProviderShareCatalogs('controlled', listener);
    await refreshProviderShareCatalogs('controlled', async () => ({ shares: [rawShare()] }));
    listener.mockClear();
    evictProviderShareCatalogs('controlled');
    expect(listener).toHaveBeenCalledWith([]);
    expect(getCachedProviderShareCatalogs('controlled')).toBeUndefined();
    unsubscribe();
  });

  it('shares one in-flight read', async () => {
    let resolve!: (value: unknown) => void;
    const fetcher = vi.fn(() => new Promise((done) => { resolve = done; }));
    const first = refreshProviderShareCatalogs('controlled', fetcher);
    const second = refreshProviderShareCatalogs('controlled', fetcher);
    await Promise.resolve();
    resolve({ shares: [] });
    expect(await first).toEqual([]);
    expect(await second).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('treats an older Desktop without the channel as having no shares', async () => {
    await refreshProviderShareCatalogs('controlled', async () => ({ shares: [rawShare()] }));
    const entries = await refreshProviderShareCatalogs('controlled', async () => {
      throw Object.assign(new Error('not allowed'), { code: 'CHANNEL_NOT_ALLOWED' });
    });
    expect(entries).toEqual([]);
    expect(getCachedProviderShareCatalogs('controlled')).toEqual([]);
  });

  it('keeps the last catalog when a read fails or a share is momentarily unreadable', async () => {
    const first = await refreshProviderShareCatalogs('controlled', async () => ({ shares: [rawShare()] }));
    await expect(refreshProviderShareCatalogs('controlled', async () => {
      throw Object.assign(new Error('timeout'), { code: 'INVOKE_TIMEOUT' });
    })).rejects.toThrow('timeout');
    expect(getCachedProviderShareCatalogs('controlled')).toBe(first);
    const next = await refreshProviderShareCatalogs('controlled', async () => ({
      shares: [rawShare({ hostOnline: false, catalog: null })],
    }));
    expect(next[0].hostOnline).toBe(false);
    expect(next[0].payload).toBe(first[0].payload);
    // 读到了但对方关了「允许被远程调用」(分享者电脑过滤后为空):用空目录,不沿用旧的。
    const closed = await refreshProviderShareCatalogs('controlled', async () => ({
      shares: [rawShare({ catalog: { providers: [] } })],
    }));
    expect(closed[0].payload).toEqual({ providers: [] });
    // 分享被删除后不再带回旧目录。
    expect(await refreshProviderShareCatalogs('controlled', async () => ({ shares: [] }))).toEqual([]);
  });

  it('drops results that arrive after the controlled computer was evicted or the account changed', async () => {
    let resolve!: (value: unknown) => void;
    const pending = refreshProviderShareCatalogs('controlled', () => new Promise((done) => { resolve = done; }));
    evictProviderShareCatalogs('controlled');
    await Promise.resolve();
    resolve({ shares: [rawShare()] });
    await pending;
    expect(getCachedProviderShareCatalogs('controlled')).toBeUndefined();

    await refreshProviderShareCatalogs('controlled', async () => ({ shares: [rawShare()] }));
    clearAllProviderShareCatalogs();
    expect(getCachedProviderShareCatalogs('controlled')).toBeUndefined();
  });
});
