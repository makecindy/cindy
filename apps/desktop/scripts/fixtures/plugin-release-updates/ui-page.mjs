export default {
  name: 'plugin-release-updates', entry: './fixture.tsx',
  viewport: { width: 760, height: 360 },
  real: 'GitHub Release settings section',
  notCovered: 'GitHub sign-in, download and installation are supplied by fixture IPC',
  cases: { default: { about: 'Checked release with installed and upstream versions' } },
  async check(page, ui) {
    await page.getByRole('button', { name: await ui.t('settings.ghosts.detail.githubRelease.check'), exact: true }).click();
    await page.getByRole('button', { name: await ui.t('settings.ghosts.detail.githubRelease.update'), exact: true }).waitFor();
  },
};
