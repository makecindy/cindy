import assert from 'node:assert/strict';

export default {
  name: 'plugin-host-permissions', entry: './fixture.tsx', viewport: { width: 640, height: 780 },
  real: 'GhostInstallConsentHost, PermissionSummary and the production Host permission projection with real translations and themed dialogs.',
  notCovered: 'Synthetic plugin permissions; no plugin is installed. Native installation, receipt persistence and detached windows are covered by unit tests.',
  stubs: {
    'src/renderer/contexts/AuthContext': 'export const useAuth = () => ({ mode: "cloud", dataOwnerId: "fixture", dataOwnerGeneration: 1 }); export const useOptionalAuthUser = () => null; export const useOptionalAuthDeviceId = () => "fixture"; export const useOptionalDataOwnerGeneration = () => ({ dataOwnerId: "fixture", generation: 1 });',
  },
  cases: { default: { about: 'Installation confirmation — synthetic plugin permissions' }, details: { about: 'Plugin permission details — synthetic plugin permissions' } },
  async check(page, ui) {
    if (ui.case === 'default') {
      await ui.emit('hostConsent', {});
    } else {
      await page.getByRole('button', { name: await ui.t('settings.ghosts.detail.viewAllPermissions'), exact: true }).click();
    }
    const dialog = page.getByRole(ui.case === 'default' ? 'alertdialog' : 'dialog');
    await dialog.waitFor();
    await dialog.getByText(await ui.t('settings.ghosts.perm.hostUi.capabilities.draft'), { exact: true }).waitFor();
    assert.doesNotMatch(await dialog.innerText(), /capability:|contribution:|"position"|\{"/);
    await ui.capture('permissions');
  },
};
