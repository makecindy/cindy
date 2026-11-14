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
      about: 'Opt-in rule, custom days validation, one count refresh per save, and reset',
    },
    unavailable: {
      about: 'A failed preview shows a recoverable error, without fabricated task counts',
    },
    'many-tasks': {
      about: 'Large archive counts without task rows or list navigation',
    },
  },
  async check(page, ui) {
    if (ui.case === 'unavailable') {
      await page.getByText(await ui.t('taskManagement.loadFailed'), { exact: true }).waitFor();
      return;
    }
    if (ui.case === 'many-tasks') {
      await page
        .getByText(await ui.t('taskManagement.candidateCount', { count: 100000 }), { exact: true })
        .waitFor();
      await page
        .getByText(await ui.t('taskManagement.keptCount', { count: 200000 }), { exact: true })
        .waitFor();
      // The sole button is settings reset; counts must not allocate task rows or tabs.
      assert.equal(await page.getByRole('button').count(), 1);
      return;
    }
    const toggle = page.getByRole('switch', {
      name: await ui.t('taskManagement.enabled'),
      exact: true,
    });
    await page
      .getByText(await ui.t('taskManagement.candidateCount', { count: 0 }), { exact: true })
      .waitFor();
    assert.equal(await toggle.getAttribute('aria-checked'), 'false');
    const select = page.getByRole('combobox');
    await select.click();
    await page
      .getByRole('option', { name: await ui.t('taskManagement.customDays'), exact: true })
      .click();
    const input = page.getByRole('spinbutton');
    await input.fill('0');
    await input.press('Tab');
    await page.getByText(await ui.t('taskManagement.invalidDays'), { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.archiveFixture.writes.length), 0);
    await input.fill('21');
    const beforeSave = await page.evaluate(() => window.archiveFixture.previewReads());
    await input.press('Tab');
    await page.waitForFunction(() => window.archiveFixture.settings().days === 21);
    assert.equal(await page.evaluate(() => window.archiveFixture.previewReads()), beforeSave + 1);
    await toggle.click();
    await page.waitForFunction(() => window.archiveFixture.settings().enabled);
    await page
      .getByText(await ui.t('taskManagement.candidateCount', { count: 1 }), { exact: true })
      .waitFor();
    await select.click();
    await page
      .getByRole('option', { name: await ui.t('taskManagement.days7'), exact: true })
      .click();
    await page
      .getByText(await ui.t('taskManagement.candidateCount', { count: 2 }), { exact: true })
      .waitFor();
    await ui.capture('enabled-counts');
    await page
      .getByRole('button', { name: await ui.t('taskManagement.reset'), exact: true })
      .click();
    await page.waitForFunction(
      () =>
        !window.archiveFixture.settings().enabled && window.archiveFixture.settings().days === 7,
    );
    await page
      .getByText(await ui.t('taskManagement.candidateCount', { count: 0 }), { exact: true })
      .waitFor();
  },
};
