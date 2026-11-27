import assert from 'node:assert/strict';
export default {
  name: 'auxiliary-model-save',
  entry: './fixture.tsx',
  viewport: { width: 880, height: 520 },
  real: 'AuxiliaryModelSection, model selectors, save controls, feedback and theme tokens',
  notCovered: 'Model requests, account data and persistence are replaced by local fixture replies',
  stubs: {
    'src/renderer/contexts/AuthContext': { partial: 'export const useAuth = () => ({ mode: "cloud", dataOwnerId: null, dataOwnerGeneration: 0 });' },
    'src/renderer/hooks/useProviders': 'export const useProviders = () => ({ providers: [], providerOrder: [] });',
  },
  cases: {
    default: { about: 'A 422 on first save leaves automatic selection active' },
    modified: { about: 'A 422 from a backup leaves the previous custom chain active' },
    testing: { about: 'A pending test keeps the draft inactive' },
  },
  async check(page, ui) {
    const key = suffix => ui.t('settings.auxiliaryModels.' + suffix);
    if (ui.case === 'modified') {
      await page.getByRole('button', { name: await key('fallback2.ariaLabel') }).click();
      await page.getByText(await key('emptySlot'), { exact: true }).click();
    } else {
      await page.getByRole('combobox', { name: await key('title') }).click();
      await page.getByRole('option', { name: await key('customize') }).click();
    }
    await page.getByRole('button', { name: await key('save'), exact: true }).click();
    const feedback = page.locator('[data-auxiliary-save-feedback]');
    await feedback.getByText(await key(ui.case === 'testing' ? 'testingHint' : ui.case === 'modified' ? 'failedKeep' : 'failedAuto')).waitFor();
    const picker = page.getByRole('button', { name: await key('preferred.ariaLabel') });
    assert.ok((await feedback.boundingBox()).y < (await picker.boundingBox()).y);
    if (ui.case === 'modified') {
      const detail = feedback.getByRole('button', { name: await ui.t('chat.errorBanner.networkShowRaw') });
      await detail.click();
      await feedback.getByText('Long provider detail.', { exact: false }).waitFor();
      await feedback.getByRole('button', { name: await ui.t('chat.errorBanner.networkHideRaw') }).click();
    }
    if (ui.case !== 'testing') await feedback.getByText('HTTP 422', { exact: false }).waitFor();
  },
};
