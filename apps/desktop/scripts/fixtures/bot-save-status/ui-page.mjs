import assert from 'node:assert/strict';

export default {
  name: 'bot-save-status', entry: './fixture.tsx', viewport: { width: 448, height: 320 },
  real: 'BotSettingsSaveStatus, useBotSettingsAutosave and the production autosave scheduler',
  notCovered: 'Full settings drawer, host persistence, permissions, account switching and device transport; these use targeted unit coverage',
  cases: {
    default: { about: 'An unanswered save stops spinning and keeps its choice' },
    confirmed: { about: 'A confirmed model save explains when it applies' },
    profile: { about: 'A confirmed profile save never claims a model will apply next turn' },
  },
  async check(page, ui) {
    await page.clock.install();
    await page.getByRole('button', { name: ui.case === 'profile' ? 'Edit profile' : 'Edit model', exact: true }).click();
    await page.clock.runFor(1);
    await page.getByRole('status').getByText(await ui.t('bots.autosave.saving'), { exact: true }).waitFor();
    if (ui.case === 'default') {
      await page.clock.fastForward(30_000);
      await page.getByRole('alert').getByText(await ui.t('bots.autosave.unconfirmed'), { exact: false }).waitFor();
      assert.equal(await page.getByRole('status').count(), 0);
      await page.getByRole('button', { name: await ui.t('bots.autosave.retry'), exact: true }).click();
      await ui.capture('unconfirmed');
    } else {
      await page.evaluate(() => window.dispatchEvent(new Event('fixture:confirm-save')));
      await page.getByRole('status').getByText(await ui.t(ui.case === 'profile' ? 'bots.autosave.saved' : 'bots.autosave.savedModel'), { exact: true }).waitFor();
    }
  },
};
