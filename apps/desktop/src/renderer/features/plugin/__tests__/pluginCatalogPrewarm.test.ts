import { afterEach, expect, it, vi } from 'vitest';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { pluginCatalogMemory, pluginCatalogOwnerKey, readLocalPluginSnapshot, readPluginRecommendations, refreshLocalPluginRecentUsage, resetPluginCatalogMemoryForTest } from '../lib/pluginCatalogMemory';
import { forgetFailedMarketIcon, mergePluginItems, readReusedMarketIcon } from '../lib/pluginBrowserCache';
import type { PluginMarketItem } from '../../../../shared/pluginMarket';
import { schedulePluginCatalogPrewarm } from '../lib/prewarmPluginCatalog';

const preloadPluginPage = vi.hoisted(() => vi.fn());
vi.mock('../GhostPluginRoute', () => ({ preloadPluginPage }));

afterEach(() => {
  preloadPluginPage.mockClear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetPluginCatalogMemoryForTest();
});

it('reuses signed icons across recommendations and search results in the same catalog partition', async () => {
  const memory = pluginCatalogMemory('first-owner', 'local');
  const item = {
    pluginId: 'plugin', ghostId: 'plugin-ghost', scope: 'public', publisherKind: 'official',
    releaseId: 'release-1', sourceType: 'server',
    icon: { mimeType: 'image/png', sizeBytes: 1024, sha256: 'a'.repeat(64),
      url: 'https://icons.invalid/recommended', thumbnailUrl: 'https://icons.invalid/thumb-a',
      expiresAt: '2099-01-01T00:00:00Z' },
  } as PluginMarketItem;
  const searchItem = { ...item, icon: { ...item.icon!, url: 'https://icons.invalid/search' } };
  const other = { ...item, pluginId: 'other-plugin', ghostId: 'other-ghost' };
  const withoutIcon = { ...item, pluginId: 'no-icon', icon: null };
  const recommendations = vi.fn()
    .mockResolvedValueOnce([item, other, withoutIcon])
    .mockRejectedValueOnce(new Error('temporary outage'))
    .mockResolvedValueOnce([searchItem]);
  const lookup = vi.fn().mockRejectedValue(new Error('would scan custom markets'));
  vi.stubGlobal('window', { electronAPI: { pluginMarket: { recommendations, lookup } } });
  memory.todayPool = await readPluginRecommendations(memory);
  const cachedPage = mergePluginItems([], [searchItem], false, memory.marketIcons);
  expect(cachedPage[0]?.icon).toBe(item.icon);
  expect(mergePluginItems([], [{ ...searchItem, releaseId: 'release-2' }], false, memory.marketIcons)[0]?.icon).toBe(searchItem.icon);
  expect(mergePluginItems([], [searchItem], false, pluginCatalogMemory('second-owner', 'local').marketIcons)[0]?.icon).toBe(searchItem.icon);
  forgetFailedMarketIcon(memory.marketIcons, cachedPage[0]!);
  await expect(readPluginRecommendations(memory, memory.todayPool)).rejects.toThrow('temporary outage');
  expect(memory.todayPool[0]?.icon).toBe(item.icon);
  const renewed = await readPluginRecommendations(memory, memory.todayPool);
  expect(renewed).toEqual([searchItem, { ...other, icon: null }, withoutIcon]);
  expect(readReusedMarketIcon(memory.marketIcons, cachedPage[0]!).icon).toBe(searchItem.icon);
  expect(recommendations).toHaveBeenCalledTimes(3);
  expect(recommendations).toHaveBeenNthCalledWith(1);
  expect(recommendations).toHaveBeenNthCalledWith(2, ['plugin', 'other-plugin']);
  expect(recommendations).toHaveBeenNthCalledWith(3, ['plugin', 'other-plugin']);

  memory.todayPool = renewed;
  const newRelease = { ...searchItem, releaseId: 'release-2', version: '2.0.0',
    icon: { ...searchItem.icon!, sha256: 'b'.repeat(64), thumbnailUrl: undefined } };
  recommendations.mockResolvedValueOnce([newRelease]);
  const updated = await readPluginRecommendations(memory, memory.todayPool);
  expect(updated).toEqual([newRelease, ...renewed.slice(1)]);
  expect(readReusedMarketIcon(memory.marketIcons, cachedPage[0]!).icon).toBe(searchItem.icon);
  expect(recommendations).toHaveBeenLastCalledWith(['plugin']);
  expect(lookup).not.toHaveBeenCalled();
});

// Unit / 工程约定 §7: start the page module and local history at idle even if
// the locale handshake is stalled. Mounted route tests cannot see that startup
// work or verify that it shares the page bucket and skips a full market query.
it('prewarms the plugin module and local history at idle before market data', async () => {
  setDataOwnerGeneration('warm-owner', 31);
  const requestIdle = vi.fn((_run: IdleRequestCallback, _options?: IdleRequestOptions) => 1);
  vi.stubGlobal('requestIdleCallback', requestIdle);
  const locale = Promise.withResolvers<void>();
  const recent = Promise.withResolvers<{ ids: string[] }>();
  const recentUsage = vi.fn(() => recent.promise);
  const snapshot = vi.fn(async () => ({ items: [], unavailableReason: null, customSourceNames: [], unavailableCustomSourceNames: [] }));
  const recommendations = vi.fn(async () => []);
  const query = vi.fn();
  vi.stubGlobal('window', { electronAPI: {
    ghosts: { recentUsage }, pluginMarket: { snapshot, recommendations, query },
    setApplicationMenuLocale: () => locale.promise,
  } });
  const input = { mode: 'cloud' as const, ownerId: 'warm-owner', generation: 31, locale: 'en' };
  schedulePluginCatalogPrewarm(input);
  expect(preloadPluginPage).not.toHaveBeenCalled();
  expect(requestIdle).toHaveBeenCalledWith(expect.any(Function), { timeout: 2_000 });
  requestIdle.mock.calls[0]![0]({ didTimeout: false, timeRemaining: () => 1 });
  expect(preloadPluginPage).toHaveBeenCalledOnce();
  await vi.dynamicImportSettled();
  const memory = pluginCatalogMemory(pluginCatalogOwnerKey(input.mode, input.ownerId, input.generation, input.locale), 'local');
  void refreshLocalPluginRecentUsage(memory, { dataOwnerId: input.ownerId, generation: input.generation });
  expect(recentUsage).toHaveBeenCalledOnce();
  recent.resolve({ ids: ['last-used'] });
  await vi.dynamicImportSettled();
  expect(memory.recentUsageIds).toEqual(['last-used']);
  expect(snapshot).not.toHaveBeenCalled();
  locale.resolve();
  await vi.dynamicImportSettled();
  expect(memory.snapshot?.items).toEqual([]);
  expect(memory.todayLoaded).toBe(true);
  expect(snapshot).toHaveBeenCalledOnce();
  expect(recommendations).toHaveBeenCalledOnce();
  expect(query).not.toHaveBeenCalled();
  schedulePluginCatalogPrewarm(input);
  expect(requestIdle).toHaveBeenCalledOnce();
  expect(recentUsage).toHaveBeenCalledOnce();
  expect(snapshot).toHaveBeenCalledOnce();
});

it('does not fetch or publish data after the owner changes before idle execution', async () => {
  vi.useFakeTimers();
  setDataOwnerGeneration('outgoing-owner', 41);
  const snapshot = vi.fn();
  const recentUsage = vi.fn();
  vi.stubGlobal('window', { electronAPI: { ghosts: { recentUsage }, pluginMarket: { snapshot } } });
  schedulePluginCatalogPrewarm({ mode: 'cloud', ownerId: 'outgoing-owner', generation: 41, locale: 'en' });
  setDataOwnerGeneration(null, 42);
  await vi.runOnlyPendingTimersAsync();
  expect(preloadPluginPage).not.toHaveBeenCalled();
  expect(recentUsage).not.toHaveBeenCalled();
  expect(snapshot).not.toHaveBeenCalled();
});

// Unit / Codex C1: Main reports source failures alongside successful custom
// results. Prewarm-only empty snapshots missed the warm-cache rejection and
// loss of partial data. The read entry must retain only failed source items.
it('accepts successful custom sources while retaining unavailable source projections', async () => {
  const memory = pluginCatalogMemory('partial-sources', 'local');
  type Item = NonNullable<typeof memory.snapshot>['items'][number];
  const item = (id: string, source: string | null, version = '1.0.0'): Item => ({ pluginId: id, ghostId: id, name: id,
    description: null, author: null, scope: 'public', organizationId: null, defaultInstall: false,
    releaseId: id, version, publishedAt: '2026-11-01T00:00:00Z', icon: null, installState: 'not-installed', enabled: null,
    sourceType: source === null ? 'server' : 'local-market', sourceMarketName: source });
  const official = item('official', null), failed = item('failed', 'unreachable');
  memory.snapshot = { items: [official, item('updated', 'working'), failed, item('removed', 'deleted')],
    unavailableReason: null, customSourceNames: ['working', 'unreachable', 'deleted'], unavailableCustomSourceNames: [] };
  const next = { items: [item('updated', 'working', '2.0.0'), item('added', 'new-source')],
    unavailableReason: 'official offline', customSourceNames: ['working', 'unreachable', 'new-source'],
    unavailableCustomSourceNames: ['unreachable'] };
  const snapshot = vi.fn().mockResolvedValue(next);
  vi.stubGlobal('window', { electronAPI: { pluginMarket: { snapshot } } });
  const result = await readLocalPluginSnapshot(memory, true);
  expect(result.items).toEqual([official, failed, ...next.items]);
  expect(result.items[0]).toBe(official);
  expect(result.items[1]).toBe(failed);
  expect(result.customSourceNames).toEqual(next.customSourceNames);
  expect(result.unavailableReason).toBe('official offline');
  memory.snapshot = result;
  expect(await readLocalPluginSnapshot(memory, true)).toBe(result);
  snapshot.mockResolvedValue({ ...next, items: [item('official', null, '3.0.0')],
    unavailableReason: null, customSourceNames: [], unavailableCustomSourceNames: [] });
  const recovered = await readLocalPluginSnapshot(memory, true);
  expect(recovered.items.map(item => item.pluginId)).toEqual(['official']);
  expect(recovered.items[0].version).toBe('3.0.0');
});

// Unit / C1 convergence: locale sync can read immediately after a forced
// request settles but before the page publishes it. A fresh timestamp must
// never make that second reader receive the previous snapshot.
it('publishes a completed snapshot with its freshness before a warm reader can reuse it', async () => {
  const memory = pluginCatalogMemory('atomic-snapshot', 'local');
  memory.snapshot = { items: [], unavailableReason: null, customSourceNames: [], unavailableCustomSourceNames: [] };
  const next = { ...memory.snapshot, customSourceNames: ['changed-off-page'] };
  const snapshot = vi.fn().mockResolvedValue(next);
  vi.stubGlobal('window', { electronAPI: { pluginMarket: { snapshot } } });
  const updated = await readLocalPluginSnapshot(memory, true);
  expect(await readLocalPluginSnapshot(memory)).toBe(updated);
  expect(snapshot).toHaveBeenCalledOnce();
});
