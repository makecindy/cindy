import assert from 'node:assert/strict';
export default {
  name: 'plugin-development', entry: './fixture.tsx', viewport: { width: 900, height: 900 },
  real: 'Installed plugin details, development identity label, browser selection and permission rows',
  notCovered: 'Native registration, actual accounts and PDF preview; host data is simulated.',
  stubs: {
    'src/renderer/contexts/AuthContext': `export const useAuth = () => ({ mode: 'cloud', dataOwnerId: 'fixture', dataOwnerGeneration: 1, isAuthenticated: true }); export const useOptionalAuthUser = () => null; export const useOptionalAuthDeviceId = () => 'fixture'; export const useOptionalDataOwnerGeneration = () => ({ dataOwnerId: 'fixture', generation: 1 });`,
  },
  cases: {
    default: { about: 'Development instance and browser selection' },
    narrow: { about: 'Development details at phone width', viewport: { width: 360, height: 900 } },
    permissions: { about: 'Explicit auto-tool and native-host permission rows', viewport: { width: 360, height: 900 } },
  },
  async check(page, ui) {
    if (ui.case === 'permissions') return;
    assert.ok((await page.locator('main').innerText()).includes(await ui.t('settings.ghosts.detail.localDevelopment')));
    const button = page.getByRole('button', { name: await ui.t('settings.ghosts.detail.browserUse'), exact: true });
    await button.click();
    await page.getByRole('status').filter({ hasText: await ui.t('settings.ghosts.detail.browserActivated') }).waitFor();
    await ui.capture('browser-selected');
  },
};
