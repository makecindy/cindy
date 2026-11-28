import assert from 'node:assert/strict';

export default {
  name: 'privacy-screen-permission',
  entry: './fixture.tsx',
  viewport: { width: 640, height: 600 },
  real: 'AwayFromComputerSection and its preview failure, permission action and focus recheck.',
  notCovered: 'The OS permission decision and the input helper are simulated.',
  cases: { default: { about: 'The running Cindy copy is denied access on macOS 27.3.' } },
  async check(page, ui) {
    await page.getByRole('button', { name: await ui.t('settings.windowBehavior.awayGuard.preview') }).click();
    const alert = page.getByRole('alert');
    await alert.getByText(await ui.t('settings.windowBehavior.awayGuard.permissionMissing')).waitFor();
    assert.match(await alert.innerText(), /\/Applications\/Cindy Personal\.app/);
    await ui.capture('permission-denied');
    await alert.getByRole('button', { name: await ui.t('regionScreenshot.permission.openSettings') }).click();
    await page.waitForFunction(() => document.documentElement.dataset.openedPermission === 'accessibility');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    assert.ok(await alert.isVisible());
    await ui.emit('systemGrant');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await alert.waitFor({ state: 'hidden' });
  },
};
