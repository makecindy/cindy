import assert from 'node:assert/strict';
export default {
  name: 'remote-bot-save-recovery', entry: './fixture.tsx', viewport: { width: 440, height: 880 },
  real: 'BotSettings, autosave, the shared leave confirmation, theme and translations',
  notCovered: 'Live devices, real network timeout duration, host persistence and model catalog; synthetic profile and rejected save',
  stubs: {
    'src/renderer/contexts/AuthContext': { partial: 'export const useAuth = () => ({ dataOwnerId: "fixture", mode: "local", user: null });' },
    'src/renderer/features/bots/companionCloudStore': 'export const useCompanionCloud = () => ({ enabled: false, actors: [], demotedBotIds: [] }); export const companionCloudApi = {}; export const getCompanionCloudSnapshot = () => null; export const refreshCompanionCloud = async () => null;',
    'src/renderer/hooks/useProviderOnboarding': 'export const useProviderOnboarding = () => ({ visible: false });',
  },
  cases: { default: { about: 'Remote timeout, continued editing and discard without another save' } },
  async ready(page) { await page.locator('[data-save-recovery]').waitFor(); },
  async check(page, ui) {
    // Use the actual editable profile to exercise the same autosave boundary as models.
    await page.getByRole('button', { name: await ui.t('bots.profile.title'), exact: true }).click();
    await page.getByRole('textbox').first().fill('Linux draft');
    await page.getByRole('alert').filter({ hasText: await ui.t('bots.autosave.remoteUnconfirmed') }).waitFor();
    await ui.capture('save-unconfirmed');
    await page.locator('[data-close]').click();
    await page.getByRole('button', { name: await ui.t('bots.autosave.continueEditing'), exact: true }).click();
    assert.equal(await page.locator('[data-closed]').count(), 0);
    await page.locator('[data-close]').click();
    await page.getByText(await ui.t('bots.autosave.remoteUnsavedDescription'), { exact: true }).waitFor();
    await ui.capture('leave-confirmation');
    await page.getByRole('button', { name: await ui.t('bots.autosave.discard'), exact: true }).click();
    await page.locator('[data-closed]').waitFor();
    assert.equal(await page.locator('html').getAttribute('data-fixture-writes'), '1', 'Leaving must not retry the failed save');
  },
};
