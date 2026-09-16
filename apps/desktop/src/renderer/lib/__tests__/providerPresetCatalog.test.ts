import { BUNDLED_CATALOG } from '../../../../../../packages/model-providers/test/catalog-fixture.js';
import { afterEach, expect, it, vi } from 'vitest';
import { SERVER_CATALOG, installServerCatalog, providerModelsForRoute } from '@cindy/model-providers';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { loadProviderPresetCatalog } from '../providerPresetCatalog';

afterEach(() => vi.unstubAllGlobals());
it('installs the main process publication for renderer adapter lookups and clears withdrawn metadata', async () => {
  const catalog = structuredClone(BUNDLED_CATALOG);
  const rows = catalog.providerModelCatalog!.providers.openrouter;
  const listProviderPresets = vi.fn().mockResolvedValue({ presets: catalog.presets, catalog });
  vi.stubGlobal('window', { electronAPI: { maker: { listProviderPresets } } });
  await loadProviderPresetCatalog();
  expect(providerModelsForRoute(rows[0].upstream).some(row => row.id === rows[0].id)).toBe(true);
  const empty = { ...catalog, providerModelCatalog: { ...catalog.providerModelCatalog!, providers: {} }, presets: [] };
  listProviderPresets.mockResolvedValue({ presets: [], catalog: empty });
  await loadProviderPresetCatalog();
  expect(providerModelsForRoute(rows[0].upstream)).toEqual([]);
  expect(SERVER_CATALOG.presets).toEqual([]);
});
it('rejects a late publication after the renderer changes owner', async () => {
  installServerCatalog(BUNDLED_CATALOG);
  let resolve!: (value: unknown) => void;
  vi.stubGlobal('window', { electronAPI: { maker: { listProviderPresets: () => new Promise(done => { resolve = done; }) } } });
  const pending = loadProviderPresetCatalog();
  setDataOwnerGeneration('next-owner');
  resolve({ presets: [], catalog: { version: 'late', providers: [] } });
  await expect(pending).rejects.toThrow(/owner/i);
  expect(SERVER_CATALOG.version).toBe(BUNDLED_CATALOG.version);
});

it('shares one in-flight publication between consumers in the same owner', async () => {
  let resolve!: (value: unknown) => void;
  const listProviderPresets = vi.fn(() => new Promise(done => { resolve = done; }));
  vi.stubGlobal('window', { electronAPI: { maker: { listProviderPresets } } });
  const first = loadProviderPresetCatalog();
  const second = loadProviderPresetCatalog();
  resolve({ presets: BUNDLED_CATALOG.presets, catalog: BUNDLED_CATALOG });
  expect(await first).toBe(await second);
  expect(listProviderPresets).toHaveBeenCalledTimes(1);
});
