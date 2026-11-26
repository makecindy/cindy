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
    unsupported: { about: 'The latest same-source installed release does not support remote viewing; checking leaves the task in place' },
    update: { about: 'A compatible same-source release exists; checking starts its ordinary in-place update' },
    'legacy-update': { about: 'An old physical-root install can update from a legacy market detail without a namespace' },
    'install-unavailable': { about: 'An absent plugin with no available listing reports installation unavailability, not a missing update' },
  },
  async check(page, ui) {
    const scenario = await page.evaluate(() => window.__uiPage.ctx.case);
    if (scenario === 'install-unavailable') {
      const notice = page.locator('[data-banner-kind="task-live-screen-plugin"]');
      await notice.waitFor();
      await notice.getByRole('button', { name: await ui.t('remoteDesktop.liveScreenPlugin.install.action'), exact: true }).click();
      await page.getByText(await ui.t('newChat.pluginSuggestions.unavailable'), { exact: true }).waitFor();
      await ui.capture('install-unavailable');
      assert.ok(await notice.isVisible());
      return;
    }
    if (scenario !== 'default') {
      const notice = page.locator('[data-banner-kind="task-live-screen-plugin"]');
      const title = await ui.t('remoteDesktop.liveScreenPlugin.unsupported.title', { plugin: 'Device Simulator' });
      await notice.waitFor();
      assert.ok((await notice.innerText()).includes(title));
      await ui.capture('unsupported');
      await notice.getByRole('button', { name: await ui.t('remoteDesktop.liveScreenPlugin.unsupported.action'), exact: true }).click();
      if (scenario === 'update' || scenario === 'legacy-update') {
        await notice.locator('button[aria-busy="true"]').waitFor();
        await ui.capture('updating');
      } else {
        const result = page.getByText(await ui.t('remoteDesktop.liveScreenPlugin.unsupported.unavailable'), { exact: true });
        await result.waitFor();
        await ui.capture('no-compatible-update');
        assert.ok(await notice.isVisible());
      }
      return;
    }
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
