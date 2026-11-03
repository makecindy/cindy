import assert from 'node:assert/strict';
export default {
  name: 'plugin-development', entry: './fixture.tsx', viewport: { width: 900, height: 900 },
  real: 'Installed plugin details, development identity label, browser selection and permission rows',
  notCovered: 'Native registration, actual accounts and PDF preview; host data is simulated.',
  stubs: {
    'src/renderer/contexts/AuthContext': `export const useAuth = () => ({ mode: 'cloud', dataOwnerId: 'fixture', dataOwnerGeneration: 1, isAuthenticated: true, user: { id: 'fixture-user', membershipKind: 'personal' } }); export const useOptionalAuthUser = () => null; export const useOptionalAuthDeviceId = () => 'fixture'; export const useOptionalDataOwnerGeneration = () => ({ dataOwnerId: 'fixture', generation: 1 });`,
    'src/renderer/contexts/PluginReviewUpdatesContext': `const value = { updates: [], refresh: async () => {}, markRead: async () => {} }; export const usePluginReviewUpdates = () => value;`,
  },
  cases: {
    default: { about: 'Development instance and browser selection' },
    narrow: { about: 'Development details at phone width', viewport: { width: 360, height: 900 } },
    authoring: { about: 'Choose the exact local or market instance before submission', viewport: { width: 360, height: 900 } },
    market: { about: 'Market details do not offer in-place file updates' },
    permissions: { about: 'Explicit auto-tool and native-host permission rows', viewport: { width: 360, height: 900 } },
  },
  async check(page, ui) {
    if (ui.case === 'permissions') return;
    if (ui.case === 'authoring') {
      const local = page.getByRole('region', { name: await ui.t('settings.ghosts.contribution.localVersion'), exact: true });
      await local.getByRole('combobox').click();
      await page.getByRole('option', { name: `1.1.0 · ${await ui.t('settings.ghosts.page.origin.local')}`, exact: true }).click();
      const button = local.getByRole('button', { name: await ui.t('settings.ghosts.contribution.submitVersion', { version: '1.1.0' }), exact: true });
      await button.waitFor();
      await ui.capture('local-selected');
      await button.click();
      assert.equal(await page.locator('html').getAttribute('data-submitted-instance'), '_ns__local__example');
      return;
    }
    if (ui.case === 'market') {
      await page.getByRole('button', { name: await ui.t('settings.ghosts.detail.moreActions'), exact: true }).click();
      assert.equal(await page.getByRole('menuitem', { name: await ui.t('settings.ghosts.detail.updateFromFile'), exact: true }).count(), 0);
      await ui.capture('market-actions');
      return;
    }

    assert.ok((await page.locator('main').innerText()).includes(await ui.t('settings.ghosts.detail.localDevelopment')));
    const button = page.getByRole('button', { name: await ui.t('settings.ghosts.detail.browserUse'), exact: true });
    await button.click();
    await page.getByRole('status').filter({ hasText: await ui.t('settings.ghosts.detail.browserActivated') }).waitFor();
    await ui.capture('browser-selected');
  },
};
