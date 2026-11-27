import assert from 'node:assert/strict';

export default {
  name: 'auxiliary-model-settings',
  entry: './fixture.tsx',
  viewport: { width: 1040, height: 820 },
  real: 'AuxiliaryModelSection, remote capability hook, OneshotModelPinPicker, ModelSelector, themes and translations',
  notCovered: 'Real device connections, persisted preferences, credentials and model inference. Host APIs supply isolated scenario data.',
  stubs: {
    'src/renderer/contexts/AuthContext': `export const useAuth = () => ({ mode: 'cloud', dataOwnerId: null, user: { id: 'preview-owner', name: 'Preview' } });
      export const useOptionalAuthDeviceId = () => 'preview-local';
      export const useOptionalDataOwnerGeneration = () => 0;
      export const useOptionalAuthUser = () => null;
      export const AuthProvider = ({ children }) => children;`,
  },
  cases: {
    default: { about: 'A remote preferred model and a local backup in the actual auxiliary settings card' },
    'pick-remote': { about: 'Open the shared model picker, browse the remote provider and save its exact device route' },
  },
  async ready(page) {
    await page.locator('[data-setting-id="settings.auxiliaryModels.preferred.label"]').waitFor();
  },
  async check(page, ui) {
    if (ui.case === 'default') return;
    await page.locator('[data-setting-id="settings.auxiliaryModels.preferred.label"]').click();
    await page.getByRole('button', { name: /MacMiniMagpie/ }).first().waitFor();
    await page.getByRole('button', { name: /MacMiniMagpie/ }).first().click();
    const option = page.getByRole('option').filter({ hasText: 'GPT-5.4 mini' }).first();
    await option.waitFor();
    await ui.capture('remote-model-picker');
    await option.click();
    const preferred = page.locator('[data-setting-id="settings.auxiliaryModels.preferred.label"]');
    await page.locator('[data-setting-id="settings.auxiliaryModels.preferred.label"]')
      .filter({ hasText: 'Mac Mini' }).waitFor();
    assert.ok((await preferred.textContent()).includes('Mac Mini'), 'The saved route must retain the remote computer');
    await ui.capture('remote-model-saved');
  },
};
