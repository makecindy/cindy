export default {
  name: 'plugin-github-install',
  entry: './fixture.tsx',
  viewport: { width: 760, height: 620 },
  real: 'Add Plugin menu, GitHub URL form, error recovery and shared permission confirmation',
  notCovered: 'GitHub network, actual credentials and filesystem install',
  cases: {
    default: { about: 'Install by exact Release tag after GitHub sign-in feedback' },
    narrow: { about: 'Same install flow on a narrow surface', viewport: { width: 360, height: 620 } },
  },
  async check(page, ui) {
    await page.getByRole('button', { name: await ui.t('settings.ghosts.page.addPluginAria') }).click();
    await ui.capture('menu');
    await page.getByRole('menuitem', { name: await ui.t('settings.ghosts.page.githubInstall.label') }).click();
    const input = page.getByRole('textbox', { name: await ui.t('settings.ghosts.page.githubInstall.url') });
    await input.fill('https://github.com/example/plugin');
    const submit = page.getByRole('button', { name: await ui.t('settings.ghosts.page.githubInstall.submit') });
    await submit.click();
    await page.getByRole('button', { name: await ui.t('settings.ghosts.detail.githubRelease.connect') }).waitFor();
    await ui.capture('sign-in');
    await input.fill('https://github.com/example/plugin/releases/tag/v1.2.3');
    await submit.click();
    const approval = page.getByRole('alertdialog');
    await approval.waitFor();
    await ui.capture('confirmation');
    await approval.getByRole('button', { name: 'Install example' }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="install-result"]')?.textContent === 'example-plugin');
  },
};
