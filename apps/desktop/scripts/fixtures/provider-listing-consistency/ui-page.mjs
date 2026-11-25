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
    'connection-icons': { about: 'Two connections to the same GLM model use distinct marks in Settings and in the picker' },
    'same-account-twice-here': { about: 'Two connections of one login on this computer: one entry in both surfaces' },
    'hidden-provider': { about: 'A provider hidden from the picker is folded under 已隐藏 at the end of the list, found by search, and still selectable' },
    'hidden-provider-settings': { about: 'Settings folds hidden and disabled providers into two groups that start closed; each detail says what the state means and how to undo it' },
    'plugin-providers': { about: 'Providers that plugins offer are listed after this computer’s own with a plugin badge; hidden and turned-off ones go into the same two groups, and the detail offers what an ordinary provider does' },
  },
  async ready(page) {
    await page.locator('[data-listed-source]').first().waitFor();
  },
  async check(page, ui) {
    if (ui.case === 'connection-icons') {
      await page.locator('[data-listed-source="local:glm-work"]').click();
      await page.getByRole('button', { name: await ui.t('settings.providers.detail.moreActionsAria') }).click();
      await page.getByRole('menuitem', { name: await ui.t('settings.providers.menu.appearance') }).click();
      const dialog = page.getByRole('dialog');
      assert.equal(await dialog.getByRole('radio').first().getAttribute('aria-label'), 'Cindy AI');
      const work = dialog.getByRole('radio', { name: await ui.t('settings.providers.menu.connectionIcon.work'), exact: true });
      assert.ok(await work.isChecked());
      await ui.capture('connection-appearance', { locator: dialog });
      const magpie = dialog.getByRole('radio', { name: 'Magpie', exact: true });
      await magpie.hover();
      await page.getByRole('tooltip', { name: 'Magpie' }).waitFor();
      await magpie.check();
      assert.equal(await work.isChecked(), false);
      await page.keyboard.press('ArrowLeft');
      assert.equal(await magpie.isChecked(), false);
      assert.equal(await dialog.getByRole('radio', { checked: true }).count(), 1);
      const png = await page.evaluate(() => {
        const canvas = document.createElement('canvas');
        canvas.width = 64; canvas.height = 32;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = 'teal'; ctx.fillRect(0, 0, 64, 32);
        return canvas.toDataURL().split(',')[1];
      });
      await dialog.locator('input[type=file]').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
      await dialog.locator('img').first().waitFor();
      await dialog.getByRole('button', { name: await ui.t('settings.providers.custom.cancel'), exact: true }).click();
      await page.locator('[data-picker] button').first().click();
      const mark = id => page.locator(`[data-rail-item="provider:glm-${id}"] svg path`).first().getAttribute('d');
      assert.notEqual(await mark('personal'), await mark('work'));
      await ui.capture('connection-icons-in-picker');
      return;
    }
    if (ui.case === 'plugin-providers') {
      const rows = page.locator('[data-testid="plugin-engine-provider-row"]');
      await rows.first().waitFor();
      assert.equal(await rows.count(), 1, 'only the plugin provider still in the model picker sits in the regular list');
      assert.equal(await page.locator('[data-testid="plugin-engine-provider-detail"]').count(), 0, 'an ordinary provider stays the default selection');
      await ui.capture('plugin-row-in-list');
      assert.ok(await rows.first().locator('img').count(), 'the row draws the plugin’s own icon when it has one');
      await rows.first().click();
      await page.locator('[data-testid="provider-usage-module"]').waitFor();
      assert.ok(await page.locator('[data-testid="plugin-engine-provider-detail"] img').count(), 'so does the detail header');
      await ui.capture('plugin-provider-detail');
      await page.locator('[data-provider-rail-group="suspended"] > button').click();
      await page.locator('[data-plugin-engine="zcode-plugin:zcode"]').click();
      await page.getByText(await ui.t('settings.providers.plugin.suspendedBanner')).waitFor();
      assert.equal(await page.locator('[data-testid="plugin-engine-models"]').count(), 0, 'a turned-off plugin provider lists no models');
      await ui.capture('plugin-provider-disabled');
      await page.locator('[data-provider-rail-group="hidden"] > button').click();
      await page.locator('[data-plugin-engine="agy-plugin:agy"]').click();
      await page.getByText(await ui.t('settings.providers.plugin.hiddenBanner')).waitFor();
      await ui.capture('plugin-provider-hidden');
      return;
    }
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
