import { afterEach, expect, it, vi } from 'vitest';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { pluginCatalogMemory, pluginCatalogOwnerKey, resetPluginCatalogMemoryForTest } from '../lib/pluginCatalogMemory';
import { schedulePluginCatalogPrewarm } from '../lib/prewarmPluginCatalog';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); resetPluginCatalogMemoryForTest(); });

// Unit: login preheat must use the page's exact owner/language bucket, and must
// not scan/count a market the user has not opened. The navigation suite only
// exercises mounted routes and cannot cover idle work or owner changes.
it('prewarms installed data and recommendations once per owner, sharing the page bucket', async () => {
  vi.useFakeTimers();
  setDataOwnerGeneration('warm-owner', 31);
  const snapshot = vi.fn(async () => ({ items: [], unavailableReason: null, customSourceNames: [], unavailableCustomSourceNames: [] }));
  const recommendations = vi.fn(async () => []);
  const query = vi.fn();
  vi.stubGlobal('window', { electronAPI: { pluginMarket: { snapshot, recommendations, query }, setApplicationMenuLocale: vi.fn().mockResolvedValue(undefined) } });
  const input = { mode: 'cloud' as const, ownerId: 'warm-owner', generation: 31, locale: 'en' };
  schedulePluginCatalogPrewarm(input);
  await vi.advanceTimersByTimeAsync(300);
  await vi.dynamicImportSettled();
  const memory = pluginCatalogMemory(pluginCatalogOwnerKey(input.mode, input.ownerId, input.generation, input.locale), 'local');
  expect(memory.snapshot?.items).toEqual([]);
  expect(memory.todayLoaded).toBe(true);
  expect(snapshot).toHaveBeenCalledOnce();
  expect(recommendations).toHaveBeenCalledOnce();
  expect(query).not.toHaveBeenCalled();
  schedulePluginCatalogPrewarm(input);
  await vi.runOnlyPendingTimersAsync();
  expect(snapshot).toHaveBeenCalledOnce();
});

it('does not fetch or publish data after the owner changes before idle execution', async () => {
  vi.useFakeTimers();
  setDataOwnerGeneration('outgoing-owner', 41);
  const snapshot = vi.fn();
  vi.stubGlobal('window', { electronAPI: { pluginMarket: { snapshot } } });
  schedulePluginCatalogPrewarm({ mode: 'cloud', ownerId: 'outgoing-owner', generation: 41, locale: 'en' });
  setDataOwnerGeneration(null, 42);
  await vi.runOnlyPendingTimersAsync();
  expect(snapshot).not.toHaveBeenCalled();
});
