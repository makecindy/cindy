import sharp from 'sharp';
// UI integration regression: ProjectIcon in the real picker must clip opaque white
// image corners. Previous automatic-image coverage only checked that an img existed.
// A white square with a dark rounded tile is the minimal input from the reported bug.
const avatarData = 'data:image/png;base64,' + (await sharp(Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><path fill="white" d="M0 0h64v64H0z"/><rect width="64" height="64" rx="16" fill="#101015"/></svg>',
)).png().toBuffer()).toString('base64');
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
    // #11034: real picker hook -> move menu. Existing scenes only supplied
    // existing paths; a single exists:false row exposed a dead destination.
    'move-missing': {
      about: 'Missing directories are absent while valid recent projects remain selectable regardless of sidebar visibility',
      data: { workdirs: [
        { path: 'D:/work/cindy', exists: true, lastUsedAt: '' },
        { path: 'D:/removed/cindy', exists: false, lastUsedAt: '' },
        { path: 'D:/archive/cindy', lastUsedAt: '' },
      ] },
    },
    'move-all-missing': {
      about: 'Only missing projects produces the empty state without losing folder browsing',
      data: { workdirs: [{ path: 'D:/removed/cindy', exists: false, lastUsedAt: '' }] },
    },
  },
  async ready(page) { await page.getByTestId('open-picker').waitFor(); },
  async check(page, ui) {
    await page.getByTestId('open-picker').click();
    if (ui.case === 'move-all-missing') {
      await page.getByText(await ui.t('ccAgent.sidebar.sessionMenu.noProjects'), { exact: true }).waitFor();
      assert.equal(await page.getByRole('menuitem', { name: /D:\/removed\/cindy/ }).count(), 0);
      await ui.capture('project-menu');
      await page.getByRole('menuitem', { name: await ui.t('ccAgent.sidebar.sessionMenu.browseProjectFolder') }).click();
      assert.equal(await page.getByTestId('selected-path').textContent(), 'browse');
      return;
    }
    await page.getByText('D:/work/cindy', { exact: true }).waitFor();
    if (ui.case === 'move-missing') {
      assert.equal(await page.getByRole('menuitem', { name: /D:\/removed\/cindy/ }).count(), 0);
      assert.equal(await page.getByRole('menuitem', { name: /D:\/archive\/cindy/ }).getAttribute('aria-disabled'), null);
    }
    if (!ui.case.startsWith('move')) {
      const project = page.getByRole('button').filter({ hasText: '项目新名称 · Cindy' });
      if (ui.case === 'automatic') {
        const image = project.locator('img');
        await image.waitFor();
        await image.evaluate(img => img.decode());
        await ui.capture('project-menu');
        const box = await image.boundingBox();
        assert.ok(box);
        const { data, info } = await sharp(await page.screenshot()).removeAlpha().raw().toBuffer({ resolveWithObject: true });
        const scale = info.width / await page.evaluate(() => innerWidth);
        const pixel = (x, y) => {
          const offset = (Math.floor(y * scale) * info.width + Math.floor(x * scale)) * info.channels;
          return [...data.subarray(offset, offset + 3)];
        };
        const background = pixel(box.x - 2, box.y + 1);
        for (const [x, y] of [
          [box.x + 0.5, box.y + 0.5],
          [box.x + box.width - 0.5, box.y + 0.5],
          [box.x + 0.5, box.y + box.height - 0.5],
          [box.x + box.width - 0.5, box.y + box.height - 0.5],
        ]) {
          assert.ok(pixel(x, y).every((channel, i) => Math.abs(channel - background[i]) <= 3),
            'Image corners must reveal the surrounding menu instead of opaque image pixels');
        }
      }
      else await project.locator('[data-project-monogram]').getByText('CY', {exact: true}).waitFor();
      await page.getByRole('button').filter({ hasText: 'D:/archive/cindy' }).locator('[data-project-monogram]').getByText('AC', {exact: true}).waitFor();
    }
    if (ui.case !== 'automatic') await ui.capture('project-menu');
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
