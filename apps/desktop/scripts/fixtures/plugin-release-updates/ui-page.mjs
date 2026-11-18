export default {
  name: 'plugin-release-updates', entry: './fixture.tsx',
  viewport: { width: 760, height: 360 },
  real: 'GitHub Release settings section',
  notCovered: 'GitHub sign-in, download and installation are supplied by fixture IPC',
  cases: {
    default: { about: 'Checked release with installed and upstream versions' },
    progress: { about: 'Download progress shows the bytes transferred' },
  },
  async check(page, ui) {
    await page.getByRole('button', { name: await ui.t('settings.ghosts.detail.githubRelease.check'), exact: true }).click();
    const update = page.getByRole('button', { name: await ui.t('settings.ghosts.detail.githubRelease.update'), exact: true });
    await update.waitFor();
    if (ui.case === 'progress') {
      await update.click();
      await page.getByText('50%', { exact: true }).waitFor();
    }
  },
};
