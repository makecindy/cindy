import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderView } from '@cindy/model-providers/registry';

beforeEach(() => { vi.resetModules(); vi.useFakeTimers(); });
afterEach(() => vi.useRealTimers());
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const catalog = (id: string) => ({ providers: [{ id } as ProviderView] });
const flush = async () => { await vi.advanceTimersByTimeAsync(50); };

describe('catalog invalidation under a slow device link', () => {
  it.each(['cancel', 'clear', 'dispose'] as const)('does not revive blocked work after %s', async (action) => {
    const { createDeviceCatalogRefresh } = await import('@/device-link/deviceCatalogRefresh');
    let available = false;
    const readProviders = vi.fn(async () => catalog('new'));
    const refresh = createDeviceCatalogRefresh({ readProviders, readCapabilities: async () => null,
      connectionEpoch: () => 1, canRead: () => available });
    refresh.notify('a');
    await flush();
    if (action === 'cancel') refresh.cancel('a');
    else refresh[action]();
    available = true;
    refresh.wake('a');
    refresh.wake();
    await vi.advanceTimersByTimeAsync(30000);
    expect(readProviders).not.toHaveBeenCalled();
    refresh.dispose();
  });
  it('invalidates but does not send background catalog reads to an unavailable peer', async () => {
    const { createDeviceCatalogRefresh } = await import('@/device-link/deviceCatalogRefresh');
    let available = false;
    const readProviders = vi.fn(async (_id: string) => catalog('new'));
    const readCapabilities = vi.fn(async (_id: string, _agent: string) => null);
    const refresh = createDeviceCatalogRefresh({ readProviders, readCapabilities,
      connectionEpoch: () => 1, canRead: (id) => id !== 'a' || available });
    refresh.notify('a');
    refresh.notify('b');
    await flush();
    expect(readProviders).toHaveBeenCalledExactlyOnceWith('b');
    expect(readCapabilities.mock.calls.every(([id]) => id === 'b')).toBe(true);
    available = true;
    // Recovery needs no second provider notification or picker remount.
    await vi.advanceTimersByTimeAsync(2000);
    expect(readProviders).toHaveBeenCalledWith('a');
    refresh.dispose();
  });
  it.each(['peer', 'connection'] as const)('wakes pending work after long backoff on %s recovery without invalidating completed reads', async (scope) => {
    const { createDeviceCatalogRefresh } = await import('@/device-link/deviceCatalogRefresh');
    const cache = await import('@/device-link/deviceProvidersCache');
    let available = false;
    const readProviders = vi.fn(async (id: string) => catalog(id));
    const refresh = createDeviceCatalogRefresh({ readProviders, readCapabilities: async () => null,
      connectionEpoch: () => 1, canRead: (id) => id === 'healthy' || available });
    refresh.notify('pending');
    refresh.notify('healthy');
    await vi.advanceTimersByTimeAsync(60000);
    refresh.wake(); // Still unreadable: no RPC and no changed cache generation.
    expect(readProviders).toHaveBeenCalledExactlyOnceWith('healthy');
    const generation = cache.getDeviceProvidersGen('healthy');
    available = true;
    refresh.wake(scope === 'peer' ? 'pending' : undefined);
    await flush();
    expect(readProviders).toHaveBeenCalledTimes(2);
    expect(cache.getCachedDeviceProviders('pending')).toEqual(catalog('pending'));
    refresh.wake();
    await vi.advanceTimersByTimeAsync(30000);
    expect(readProviders).toHaveBeenCalledTimes(2);
    expect(cache.getDeviceProvidersGen('healthy')).toBe(generation);
    refresh.dispose();
  });
  it('does not miss recovery racing the blocked attempt settlement', async () => {
    const { createDeviceCatalogRefresh } = await import('@/device-link/deviceCatalogRefresh');
    let available = false;
    const readProviders = vi.fn(async () => catalog('new'));
    const refresh = createDeviceCatalogRefresh({ readProviders, readCapabilities: async () => null,
      connectionEpoch: () => 1, canRead: () => available });
    refresh.notify('a');
    vi.advanceTimersByTime(50); // Start gated runner without settling its promise.
    available = true;
    refresh.wake('a');
    await flush();
    expect(readProviders).toHaveBeenCalledExactlyOnceWith('a');
    refresh.dispose();
  });
  it('coalesces four notifications and serializes a burst during a read without committing stale results', async () => {
    const { createDeviceCatalogRefresh } = await import('@/device-link/deviceCatalogRefresh');
    const cache = await import('@/device-link/deviceProvidersCache');
    const caps = await import('@/session/agentCapabilitiesCache');
    const first = deferred<ReturnType<typeof catalog>>();
    const last = deferred<ReturnType<typeof catalog>>();
    const firstCaps = deferred<unknown>();
    const readProviders = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(last.promise);
    const readCapabilities = vi.fn().mockReturnValue(firstCaps.promise);
    const published = vi.fn();
    cache.subscribeDeviceProviders('a', published);
    const refresh = createDeviceCatalogRefresh({ readProviders, readCapabilities, connectionEpoch: () => 7 });
    for (let i = 0; i < 4; i++) { refresh.notify('a'); await vi.advanceTimersByTimeAsync(2); }
    await flush();
    expect(readProviders).toHaveBeenCalledTimes(1);
    expect(readCapabilities).toHaveBeenCalledTimes(3);
    // A mounted page joins the same capability read as the push refresh.
    const pageRead = vi.fn();
    const joined = caps.fetchAgentCapabilities('a', 'codex', pageRead);
    for (let i = 0; i < 10; i++) refresh.notify('a');
    await flush();
    expect(readProviders).toHaveBeenCalledTimes(1);
    first.resolve(catalog('stale'));
    await flush();
    expect(published).not.toHaveBeenCalled();
    expect(cache.getDeviceFetchEpoch('a')).toBeUndefined();
    expect(readProviders).toHaveBeenCalledTimes(1); // Whole batch still settling.
    firstCaps.resolve(null);
    await joined;
    await flush();
    expect(pageRead).not.toHaveBeenCalled();
    expect(readProviders).toHaveBeenCalledTimes(2);
    expect(readCapabilities).toHaveBeenCalledTimes(6);
    last.resolve(catalog('latest'));
    await flush();
    expect(published).toHaveBeenCalledExactlyOnceWith(catalog('latest'));
    expect(cache.getDeviceFetchEpoch('a')).toBe(7);
    refresh.dispose();
  });

  it('a mounted reader waits for the obsolete read instead of bypassing the refresh slot', async () => {
    const cache = await import('@/device-link/deviceProvidersCache');
    const old = deferred<ReturnType<typeof catalog>>();
    const first = cache.fetchDeviceProviders('a', () => old.promise);
    cache.invalidateDeviceProvidersForRefresh('a');
    const fetcher = vi.fn().mockResolvedValue(catalog('latest'));
    const reads = [cache.fetchDeviceProviders('a', fetcher), cache.fetchDeviceProviders('a', fetcher)];
    await flush();
    expect(fetcher).not.toHaveBeenCalled();
    old.resolve(catalog('obsolete'));
    await first;
    await Promise.all(reads);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(cache.getCachedDeviceProviders('a')).toEqual(catalog('latest'));
  });

  it.each([
    ['ordinary', 'resolve', 'background-first'], ['ordinary', 'reject', 'background-first'],
    ['fresh', 'resolve', 'background-first'], ['fresh', 'reject', 'background-first'],
    ['ordinary', 'resolve', 'fresh-first'], ['ordinary', 'reject', 'fresh-first'],
    ['fresh', 'resolve', 'fresh-first'], ['fresh', 'reject', 'fresh-first'],
  ])('shares one replacement after an obsolete %s read %ss with %s', async (kind, outcome, order) => {
    const cache = await import('@/device-link/deviceProvidersCache');
    const old = deferred<ReturnType<typeof catalog>>();
    const replacement = deferred<ReturnType<typeof catalog>>();
    const first = (kind === 'fresh' ? cache.fetchDeviceProvidersFresh : cache.fetchDeviceProviders)(
      'a', () => old.promise,
    ).catch(() => undefined);
    cache.invalidateDeviceProvidersForRefresh('a');
    const generation = cache.getDeviceProvidersGen('a');
    const fetcher = vi.fn(() => replacement.promise);
    const read = () => cache.fetchDeviceProviders('a', fetcher);
    const fresh = () => cache.fetchDeviceProvidersFresh('a', fetcher);
    const readers = order === 'background-first' ? [read(), fresh()] : [fresh(), read()];
    await flush();
    expect(fetcher).not.toHaveBeenCalled();
    if (outcome === 'reject') old.reject(new Error('timeout'));
    else old.resolve(catalog('obsolete'));
    await first;
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(cache.getDeviceProvidersGen('a')).toBe(generation);
    expect(cache.getCachedDeviceProviders('a')).toBeUndefined();
    replacement.resolve(catalog('latest'));
    expect(await Promise.all(readers)).toEqual([catalog('latest'), catalog('latest')]);
    expect(cache.getCachedDeviceProviders('a')).toEqual(catalog('latest'));
  });

  it('failed or cancelled reads cannot block another peer or resurrect a disposed owner', async () => {
    const { createDeviceCatalogRefresh } = await import('@/device-link/deviceCatalogRefresh');
    const cache = await import('@/device-link/deviceProvidersCache');
    const slow = deferred<ReturnType<typeof catalog>>();
    const readProviders = vi.fn((id: string) => id === 'a' ? slow.promise : Promise.resolve(catalog(id)));
    const refresh = createDeviceCatalogRefresh({ readProviders, readCapabilities: async () => null, connectionEpoch: () => 1 });
    refresh.notify('a');
    refresh.notify('b');
    await flush();
    expect(cache.getCachedDeviceProviders('b')).toEqual(catalog('b'));
    refresh.notify('a');
    refresh.dispose();
    slow.resolve(catalog('old-owner'));
    await flush();
    expect(cache.getCachedDeviceProviders('a')).toBeUndefined();
    expect(readProviders).toHaveBeenCalledTimes(2);
    const nextRead = vi.fn().mockRejectedValueOnce(new Error('timeout')).mockResolvedValue(catalog('new-owner'));
    const next = createDeviceCatalogRefresh({ readProviders: nextRead, readCapabilities: async () => null, connectionEpoch: () => 2 });
    next.notify('a');
    await flush();
    expect(cache.getDeviceFetchEpoch('a')).toBeUndefined();
    next.notify('a');
    await flush();
    expect(nextRead).toHaveBeenCalledTimes(2);
    expect(cache.getCachedDeviceProviders('a')).toEqual(catalog('new-owner'));
    expect(cache.getDeviceFetchEpoch('a')).toBe(2);
    next.dispose();
  });

  it('capability waiters are fenced when an account changes before the old read settles', async () => {
    const caps = await import('@/session/agentCapabilitiesCache');
    const old = deferred<unknown>();
    const oldRead = caps.fetchAgentCapabilities('a', 'pi', () => old.promise);
    await flush();
    caps.evictAgentCapabilitiesForDevice('a');
    const staleFetcher = vi.fn();
    const staleWaiter = caps.fetchAgentCapabilities('a', 'pi', staleFetcher).catch((e) => e.message);
    caps.resetAgentCapabilitiesCache();
    const freshFetcher = vi.fn().mockResolvedValue('fresh');
    const current = caps.fetchAgentCapabilities('a', 'pi', freshFetcher);
    old.resolve('stale');
    await oldRead;
    expect(await staleWaiter).toBe('Capabilities read superseded');
    expect(await current).toBe('fresh');
    expect(staleFetcher).not.toHaveBeenCalled();
    expect(freshFetcher).toHaveBeenCalledTimes(1);
  });
});
