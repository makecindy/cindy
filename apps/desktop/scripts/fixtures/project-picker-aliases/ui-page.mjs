import assert from 'node:assert/strict';

export default {
  name: 'project-picker-aliases', entry: './picker-fixture.tsx', viewport: { width: 620, height: 440 },
  real: 'useProjectPickerOptions, useProjectAliases, FolderPickerPopover and SessionProjectMoveSubmenu',
  notCovered: 'Real database persistence, full new-task submission and task relocation; fixture host supplies saved aliases and paths.',
  cases: {
    default: { about: 'New-task project picker displays the saved alias and selects the original directory' },
    move: { about: 'Move-task menu displays the same saved alias and selects the original directory' },
    'move-explicit-project': { about: 'Explicit membership is disabled even when execution uses a checkout' },
  },
  async ready(page) { await page.getByTestId('open-picker').waitFor(); },
  async check(page, ui) {
    await page.getByTestId('open-picker').click();
    await page.getByText('D:/work/cindy', { exact: true }).waitFor();
    await ui.capture('project-menu');
    const renamed = page.getByText('项目新名称 · Cindy', { exact: true });
    assert.equal(await renamed.count(), 1, 'Saved alias must appear in the actual project menu');
    if (ui.case === 'move-explicit-project') {
      assert.equal(await page.getByRole('menuitem', { name: /项目新名称/ }).getAttribute('aria-disabled'), 'true');
      assert.equal(await page.getByTestId('selected-path').textContent(), '');
      await page.getByText('D:/archive/cindy', { exact: true }).click();
      assert.equal(await page.getByTestId('selected-path').textContent(), 'D:/archive/cindy');
      return;
    }
    await renamed.click();
    assert.equal(await page.getByTestId('selected-path').textContent(), 'D:/work/cindy');
  },
};
