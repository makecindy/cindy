import assert from 'node:assert/strict';
export default {
  name: 'task-live-screens',
  entry: './fixture.tsx',
  viewport: { width: 320, height: 640 },
  real: 'TaskLiveScreenButtons, TaskLiveScreenNotices, useAutoOpenTaskLiveScreens, the in-place plugin install, plugin identity, translations and tooltip',
  notCovered:
    'Static device and installed-plugin lists; no real device transport, Main install confirmation, finished installation or opening a task tab',
  stubs: {
    'src/renderer/features/right-sidebar/lib/openPluginTaskTab': 'export async function openPluginTaskTab() {}',
  },
  cases: {
    default: {
      about: 'One usable provider and one missing provider, with a duplicate legacy install key; the ask waits above the composer',
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
    const notice = page.locator('[data-banner-kind="task-live-screen-plugin"]');
    await notice.waitFor();
    assert.ok((await notice.innerText()).includes(title));
    const action = await ui.t('remoteDesktop.liveScreenPlugin.install.action');
    // One click starts the install right here; nothing leaves the task.
    await notice.getByRole('button', { name: action, exact: true }).click();
    await notice.locator('button[aria-busy="true"]').waitFor();
    await ui.capture('installing');
  },
};
