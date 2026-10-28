import assert from 'node:assert/strict';
export default {
  name: 'sidebar-task-presentation',
  entry: './sidebar-fixture.tsx',
  viewport: { width: 360, height: 700 },
  real: 'Production sidebar task presentation factory, partition policy and styles',
  notCovered:
    'Native sidebar tree, database, app deployment and navigation (verified separately in installed Desktop)',
  cases: {
    default: { about: 'Normal project above collapsed internal tasks' },
    'pinned-project': {
      about: 'Project and child both pinned under a specific project filter',
      data: { pinnedProject: true },
    },
  },
  async check(page, ui) {
    const add = page.getByRole('button', {
      name: await ui.t('ccAgent.sidebar.addProjectFolder'),
      exact: true,
    });
    assert.equal(await add.isVisible(), true);
    await add.click();
    await page.waitForFunction(
      () =>
        document.querySelector('[data-project-picker-calls]')?.dataset.projectPickerCalls === '1',
    );
    const header = page.locator('[data-sidebar-internal-tasks] > button');
    assert.equal(await header.getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('[data-sidebar-internal-content]').count(), 0);
    assert.equal(await page.locator('[data-sidebar-task-id="normal"]').count(), 1);
    await header.click();
    assert.equal(await header.getAttribute('aria-expanded'), 'true');
    assert.equal(
      await page
        .locator('[data-sidebar-task-id="child"][data-sidebar-task-kind="delegated"]')
        .count(),
      1,
    );
    assert.equal(await page.getByRole('button', { name: '父任务: Cindy' }).count(), 1);
    assert.equal(
      await page
        .locator('[data-sidebar-task-id="manual"][data-sidebar-task-kind="ordinary"]')
        .count(),
      1,
    );
    await ui.capture('expanded');
    await header.click();
    assert.equal(await page.locator('[data-sidebar-internal-content]').count(), 0);
  },
};
