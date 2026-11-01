import assert from 'node:assert/strict';
export default {
  name: 'remote-desktop-input', entry: './fixture.tsx',
  viewport: { width: 1000, height: 700 },
  real: 'RemoteDesktopViewerWindow, DesktopViewerController, shared error classification and localized text',
  notCovered: 'Host API is a scenario fixture; actual XTest injection and Air-to-GX102 transport are not exercised',
  cases: {
    default: { about: 'Unsupported desktop input explains compatibility, not missing permission' },
    permission: { about: 'An actual missing permission retains the permission guidance' },
  },
  async check(page, ui) {
    const key = ui.case === 'permission' ? 'permissionHint' : 'inputUnsupported';
    await page.getByText(await ui.t(`remoteDesktop.${key}`), { exact: true }).waitFor();
    if (key === 'inputUnsupported') assert.equal(await page.getByText(await ui.t('remoteDesktop.permissionHint'), { exact: true }).count(), 0);
  },
};
