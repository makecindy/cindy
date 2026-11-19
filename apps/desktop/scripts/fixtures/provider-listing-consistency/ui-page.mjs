import assert from 'node:assert/strict';
import settings from '../provider-share-sources/ui-page.mjs';

// Guard for one source-listing rule: the same computers must give the same entries in
// Settings and in the model picker. Before the shared rule, each surface folded differently.
export default {
  name: 'provider-listing-consistency',
  entry: './fixture.tsx',
  viewport: { width: 1280, height: 760 },
  real: 'ProvidersSection list, ModelSelector rail and the shared listedSourceFolds rule',
  notCovered: 'Live device catalogs, shares received from other accounts, run-location choice (which computer represents an equal source)',
  stubs: {
    ...settings.stubs,
    'src/renderer/hooks/useProviders': 'export const useProviders = () => window.listingFixture.snapshot;',
    'src/renderer/hooks/useControllableDevices': { partial: 'export const useControllableDevices = () => window.listingFixture.devices;' },
    'src/renderer/hooks/useDevicesProviders': 'export const useDevicesProviders = ids => new Map(ids.flatMap(id => window.listingFixture.catalogs.has(id) ? [[id, window.listingFixture.catalogs.get(id)]] : []));',
    'src/renderer/hooks/useAgentCapabilities': { partial: 'const state = { capabilities: { hasFastMode: false, availableModels: [], effortLevels: [{ id: "high", displayName: "High" }], permissionModes: [] }, loading: false, error: null }; export const useAgentCapabilities = () => state;' },
  },
  cases: {
    default: { about: 'Equal sources on other computers are listed once, identically in Settings and the picker' },
    'same-account-twice-here': { about: 'Two connections of one login on this computer: one entry in both surfaces' },
  },
  async ready(page) {
    await page.locator('[data-listed-source]').first().waitFor();
  },
  async check(page, ui) {
    const settingsEntries = (await page.locator('[data-listed-source]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-listed-source')))).sort();
    await page.locator('[data-picker] button').first().click();
    await page.getByRole('listbox').waitFor();
    const pickerEntries = (await page.locator('[data-rail-item^="provider:"], [data-rail-item^="remote:"]').evaluateAll(nodes => nodes.map(node => {
      const key = node.getAttribute('data-rail-item');
      return key.startsWith('provider:') ? `local:${key.slice('provider:'.length)}` : key.slice('remote:'.length);
    }))).sort();
    assert.deepEqual(pickerEntries, settingsEntries, 'Settings and the model picker must list the same sources');
    assert.deepEqual(settingsEntries, ['local:anthropic', 'local:openai', 'mini:openai', 'rog:xai']);
    await ui.capture('both-surfaces');
  },
};
