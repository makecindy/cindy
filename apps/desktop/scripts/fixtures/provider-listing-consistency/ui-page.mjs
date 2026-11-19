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
    'hidden-provider': { about: 'A provider hidden from the picker is folded under 已隐藏 at the end of the list, found by search, and still selectable' },
    'hidden-provider-settings': { about: 'Settings folds hidden and disabled providers into two groups that start closed; each detail says what the state means and how to undo it' },
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
    if (ui.case.startsWith('hidden-provider')) {
      // Hidden and disabled providers are folded into two groups in Settings, so what stays in
      // the regular list is exactly what the picker rail offers.
      assert.deepEqual(pickerEntries, settingsEntries, 'the regular Settings list matches the picker rail');
      assert.deepEqual(settingsEntries, ['local:openai', 'mini:xai']);
      const toggle = page.locator('[data-hidden-models-toggle]');
      await toggle.waitFor();
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
      assert.equal(await page.getByRole('option', { name: /Fable/ }).count(), 0, 'hidden models stay folded until asked for');
      if (ui.case === 'hidden-provider') {
        await toggle.scrollIntoViewIfNeeded();
        await ui.capture('hidden-folded');
        // Search reaches hidden providers without opening the fold first.
        const search = page.getByRole('textbox', { name: await ui.t('newChat.modelSelector.search.placeholderAll') });
        await search.fill('fab');
        await page.getByRole('option', { name: /Fable/ }).waitFor();
        await ui.capture('hidden-found-by-search');
        await search.fill('');
        await toggle.waitFor();
        assert.equal(await toggle.getAttribute('aria-expanded'), 'false', 'clearing the search folds it again');
        await toggle.click();
        await page.getByRole('option', { name: /Fable/ }).waitFor();
        await page.getByRole('option', { name: /Fable/ }).scrollIntoViewIfNeeded();
        await ui.capture('hidden-expanded');
        return;
      }
      await page.keyboard.press('Escape');
      // Settings: both groups start folded and carry their counts.
      for (const group of ['hidden', 'suspended']) {
        const header = page.locator(`[data-provider-rail-group="${group}"] > button`);
        assert.equal(await header.getAttribute('aria-expanded'), 'false', `${group} group starts folded`);
      }
      assert.equal(await page.locator('[data-listed-source="local:anthropic"]').count(), 0);
      await ui.capture('settings-groups-folded');
      await page.locator('[data-provider-rail-group="suspended"] > button').click();
      await page.locator('[data-listed-source="local:anthropic-work"]').click();
      await page.getByText(await ui.t('settings.providers.detail.suspendedBanner')).waitFor();
      await ui.capture('disabled-in-settings');
      await page.locator('[data-provider-rail-group="hidden"] > button').click();
      await page.locator('[data-listed-source="local:anthropic"]').click();
      await page.getByText(await ui.t('settings.providers.detail.hiddenBanner')).waitFor();
      await ui.capture('hidden-in-settings');
      return;
    }
    assert.deepEqual(pickerEntries, settingsEntries, 'Settings and the model picker must list the same sources');
    assert.deepEqual(settingsEntries, ['local:anthropic', 'local:openai', 'mini:openai', 'rog:xai']);
    await ui.capture('both-surfaces');
  },
};
