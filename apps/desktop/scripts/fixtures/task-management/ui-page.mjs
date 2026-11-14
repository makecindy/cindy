import assert from 'node:assert/strict';

export default {
  name: 'task-management',
  entry: './fixture.tsx',
  viewport: { width: 1100, height: 850 },
  real: 'TaskManagementSection, settings definitions, Switch, Select, Input, translations and theme tokens',
  notCovered: 'Real database, IPC owner fencing, automatic scans and lifecycle cleanup',
  stubs: {
    'src/renderer/contexts/AuthContext': `export const useAuth = () => ({ dataOwnerId: 'fixture-account', dataOwnerGeneration: 1, dataOwnerRecoveryEpoch: 0 });`,
  },
  cases: {
    default: {
      about: 'Inline days and switch, custom days validation and reset without preview scans',
    },
    unavailable: {
      about: 'Failed settings reads disable controls and recover on the next settings notification',
    },
    enabled: {
      about: 'An enabled rule keeps its days and switch together without an archive preview',
    },
  },
  async check(page, ui) {
    const toggle = page.getByRole('switch', {
      name: await ui.t('taskManagement.enabled'),
      exact: true,
    });
    const select = page.getByRole('combobox');
    if (ui.case === 'unavailable') {
      await page.getByText(await ui.t('taskManagement.loadFailed'), { exact: true }).waitFor();
      assert.ok(await toggle.isDisabled());
      assert.ok(await select.isDisabled());
      await ui.capture('load-error');
      await page.evaluate(() => window.archiveFixture.recover());
      await page.getByText(await ui.t('taskManagement.loadFailed'), { exact: true }).waitFor({ state: 'hidden' });
    }
    await page.waitForFunction(() => {
      const toggle = document.querySelector('[role="switch"]');
      return toggle && !toggle.disabled;
    });
    // User-requested compact settings (browser tier): the real controls share a
    // line in narrow and wide layouts, and opening/changing rules never scans tasks.
    const daysBox = await select.boundingBox();
    const toggleBox = await toggle.boundingBox();
    assert.ok(Math.abs(daysBox.y + daysBox.height / 2 - toggleBox.y - toggleBox.height / 2) < 1);
    assert.equal(await page.getByRole('heading', { name: await ui.t('taskManagement.preview'), exact: true }).count(), 0);
    assert.equal(await page.evaluate(() => window.archiveFixture.previewReads()), 0);
    if (ui.case !== 'default') {
      assert.equal(await toggle.getAttribute('aria-checked'), String(ui.case === 'enabled'));
      return;
    }
    assert.equal(await toggle.getAttribute('aria-checked'), 'false');
    await select.click();
    await page
      .getByRole('option', { name: await ui.t('taskManagement.customDays'), exact: true })
      .click();
    const input = page.getByRole('spinbutton');
    await input.fill('0');
    await input.press('Tab');
    await page.getByText(await ui.t('taskManagement.invalidDays'), { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.archiveFixture.writes.length), 0);
    assert.ok(await toggle.isDisabled());
    await input.fill('21');
    await input.press('Tab');
    await page.waitForFunction(() => window.archiveFixture.settings().days === 21);
    assert.equal(await page.evaluate(() => window.archiveFixture.writes.length), 1);
    await toggle.click();
    await page.waitForFunction(() => window.archiveFixture.settings().enabled);
    await ui.capture('custom-days');
    await select.click();
    await page
      .getByRole('option', { name: await ui.t('taskManagement.days7'), exact: true })
      .click();
    await page.waitForFunction(() => window.archiveFixture.settings().days === 7);
    await ui.capture('enabled-rule');
    await page
      .getByRole('button', { name: await ui.t('taskManagement.reset'), exact: true })
      .click();
    await page.waitForFunction(
      () =>
        !window.archiveFixture.settings().enabled && window.archiveFixture.settings().days === 7,
    );
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    assert.equal(await page.evaluate(() => window.archiveFixture.previewReads()), 0);
  },
};
