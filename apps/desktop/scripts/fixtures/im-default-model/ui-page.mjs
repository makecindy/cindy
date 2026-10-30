import assert from 'node:assert/strict';

export default {
  name: 'im-default-model',
  entry: './fixture.tsx',
  viewport: { width: 660, height: 520 },
  real: 'IM defaults settings, real model selector, automatic model resolution and restore action',
  notCovered: 'Live credentials and model discovery; host supplies a catalog and settings writes',
  cases: {
    default: { about: 'Automatic selection shows the actual model' },
    'im-automatic': { about: 'Automatic selection shows the actual model' },
    'im-fixed': { about: 'Explicit choice can return to automatic without resetting permissions' },
    'im-unavailable': { about: 'No usable provider is explained without inventing a default' },
    'im-narrow': { about: 'Automatic selection at 320px', viewport: { width: 320, height: 640 } },
  },
  async ready(page) {
    await page.locator('section').waitFor();
  },
  async check(page, ui) {
    if (ui.case === 'im-fixed') {
      await page
        .getByRole('button', {
          name: await ui.t('settings.imBot.defaults.useAutomatic'),
          exact: true,
        })
        .click();
    }
    assert.ok(
      await page
        .getByText(await ui.t('settings.imBot.defaults.automatic'), { exact: true })
        .isVisible(),
    );
    if (ui.case === 'im-unavailable') {
      assert.ok(
        await page
          .getByText(await ui.t('settings.imBot.defaults.automaticUnavailable'), { exact: true })
          .isVisible(),
      );
    } else {
      assert.ok(await page.getByText('GPT-6.1-Sol', { exact: true }).isVisible());
    }
  },
};
