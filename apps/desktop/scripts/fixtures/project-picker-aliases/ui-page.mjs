import { readFileSync } from 'node:fs';
const avatarData = 'data:image/png;base64,' + readFileSync(new URL('../../../../mobile/assets/bot-presets/cindy.png', import.meta.url)).toString('base64');
import assert from 'node:assert/strict';

export default {
  name: 'project-picker-aliases', entry: './picker-fixture.tsx', viewport: { width: 620, height: 440 },
  real: 'useProjectPickerOptions, useProjectAliases, FolderPickerPopover and SessionProjectMoveSubmenu',
  notCovered: 'Real database persistence, full new-task submission and task relocation; fixture host supplies saved aliases and paths.',
  stubs: {'src/renderer/contexts/AuthContext': {partial: 'export const useAuth = () => ({dataOwnerId: "fixture", isAuthenticated: false});'}},
  cases: {
    automatic: {data: {avatarData}, about: 'Auto image and theme-based initials in the real project picker'},
    default: { about: 'New-task project picker displays the saved alias and selects the original directory' },
    move: { about: 'Move-task menu displays the same saved alias and selects the original directory' },
    'move-explicit-project': { about: 'Explicit membership is disabled even when execution uses a checkout' },
  },
  async ready(page) { await page.getByTestId('open-picker').waitFor(); },
  async check(page, ui) {
    await page.getByTestId('open-picker').click();
    await page.getByText('D:/work/cindy', { exact: true }).waitFor();
    if (!ui.case.startsWith('move')) {
      const project = page.getByRole('button').filter({ hasText: '项目新名称 · Cindy' });
      if (ui.case === 'automatic') await project.locator('img').waitFor();
      else await project.locator('[data-project-monogram]').getByText('CY', {exact: true}).waitFor();
      await page.getByRole('button').filter({ hasText: 'D:/archive/cindy' }).locator('[data-project-monogram]').getByText('AC', {exact: true}).waitFor();
    }
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
