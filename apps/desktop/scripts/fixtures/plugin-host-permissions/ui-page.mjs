import assert from 'node:assert/strict';

export default {
  name: 'plugin-host-permissions', entry: './fixture.tsx', viewport: { width: 640, height: 780 },
  real: 'GhostInstallConsentHost, PermissionSummary and the production Host permission projection with real translations and themed dialogs.',
  notCovered: 'Synthetic plugin permissions; no plugin is installed. Native installation, receipt persistence and detached windows are covered by unit tests.',
  stubs: {
    'src/renderer/contexts/AuthContext': 'export const useAuth = () => ({ mode: "cloud", dataOwnerId: "fixture", dataOwnerGeneration: 1 }); export const useOptionalAuthUser = () => null; export const useOptionalAuthDeviceId = () => "fixture"; export const useOptionalDataOwnerGeneration = () => ({ dataOwnerId: "fixture", generation: 1 });',
  },
  cases: { default: { about: 'Installation confirmation — synthetic plugin permissions' }, details: { about: 'Plugin permission details — synthetic plugin permissions' },
    'inherit-install': { about: 'Full environment inheritance in the existing install dialog — labelled synthetic sample' },
    'inherit-details': { about: 'Full environment inheritance in plugin permission details — labelled synthetic sample' } },
  async check(page, ui) {
    const inheritEnv = ui.case.startsWith('inherit-');
    const install = ui.case === 'default' || ui.case === 'inherit-install';
    if (install) {
      await ui.emit('hostConsent', { inheritEnv });
    } else if (inheritEnv) {
      await page.locator('summary').filter({ hasText: await ui.t('settings.ghosts.detail.permissionsTitle') }).click();
    } else if (!inheritEnv) {
      await page.getByRole('button', { name: await ui.t('settings.ghosts.detail.viewAllPermissions'), exact: true }).click();
    }
    const dialog = inheritEnv && !install ? page.locator('main') : page.getByRole(install ? 'alertdialog' : 'dialog');
    await dialog.waitFor();
    if (inheritEnv) {
      await dialog.getByText(await ui.t('settings.ghosts.perm.nodeInheritEnv'), { exact: true }).waitFor();
      await dialog.getByText(await ui.t('settings.ghosts.perm.nodeInheritEnvDetail'), { exact: true }).waitFor();
      await ui.capture('environment-permissions');
      return;
    }
    await dialog.getByText(await ui.t('settings.ghosts.perm.hostUi.capabilities.draft'), { exact: true }).waitFor();
    await dialog.getByText(await ui.t('settings.ghosts.perm.hostTools_usage'), { exact: true }).waitFor();
    await dialog.getByText(await ui.t('settings.ghosts.perm.hostTools_usageDetail'), { exact: true }).waitFor();
    await dialog.getByText(await ui.t('settings.ghosts.perm.hostTools_usageDetail'), { exact: true }).scrollIntoViewIfNeeded();
    assert.doesNotMatch(await dialog.innerText(), /capability:|contribution:|"position"|\{"/);
    await ui.capture('permissions');
  },
};
