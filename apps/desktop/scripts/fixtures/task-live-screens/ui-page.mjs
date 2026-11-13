import assert from 'node:assert/strict';
export default {
  name: 'task-live-screens',
  entry: './fixture.tsx',
  viewport: { width: 320, height: 640 },
  real: 'TaskLiveScreenButtons, taskLiveScreenEntries, plugin identity, translations, tooltip and confirm dialog',
  notCovered:
    'Static device and installed-plugin lists; no real device transport, plugin installation or opening a task tab',
  cases: {
    default: {
      about: 'One usable provider and one missing provider, with a duplicate legacy install key',
    },
  },
  async check(page, ui) {
    await page
      .getByRole('button', { name: 'Device Simulator · iPhone Air', exact: true })
      .waitFor();
    const title = await ui.t('remoteDesktop.liveScreenPlugin.install.title', {
      plugin: 'Other device plugin',
    });
    await page.getByRole('button', { name: title, exact: true }).waitFor();
    assert.equal(await page.getByRole('button').count(), 2);
    await page.getByRole('button', { name: title, exact: true }).click();
    await page.getByRole('alertdialog').waitFor();
    await ui.capture('setup');
  },
};
