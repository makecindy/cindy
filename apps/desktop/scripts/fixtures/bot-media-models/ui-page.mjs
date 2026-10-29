import assert from 'node:assert/strict';

export default {
  name: 'bot-media-models', entry: './fixture.tsx', viewport: { width: 440, height: 960 },
  real: 'BotMediaModelEditor, themed Select/FormField/Button, five locales',
  notCovered: 'Runtime media routing, persistence and real devices; synthetic catalogs and local state only',
  cases: { 'vision-unavailable': { about: 'Vision catalog failure preserves other model choices and reset' }, unavailable: { about: 'Catalog failure retains selections and allows reset' }, default: { about: 'All three categories inherit app settings' }, override: { about: 'Explicit routes, no fallback, long model and provider label' } },
  async ready(page) { await page.locator('[data-media-settings-fixture] button[role="combobox"]:not(:disabled)').first().waitFor(); },
  async check(page, ui) {
    const selects = page.locator('[data-media-settings-fixture] button[role="combobox"]');
    assert.equal(await selects.count(), ui.case === 'default' ? 3 : 4);
    if (ui.case === 'unavailable' || ui.case === 'vision-unavailable') assert.ok(await page.getByRole('alert').isVisible());
    if (ui.case !== 'default') {
      const inherit = await ui.t('bots.mediaModels.inherit');
      await selects.first().click();
      await page.getByRole('option', { name: inherit, exact: true }).click();
      assert.equal(await selects.count(), 3, 'Resetting vision removes its fallback override');
    }
  },
};
