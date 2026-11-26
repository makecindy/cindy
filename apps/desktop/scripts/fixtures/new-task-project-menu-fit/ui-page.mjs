import assert from 'node:assert/strict';

// Regression for the new-task project menu on short windows: the menu only capped its
// project list, so "新建项目" / "添加远程项目" at its bottom were pushed past the window
// edge (reported on Windows; the layout is the same on every platform).
// 600px is Cindy's minimum window height; 688px is a maximized 1080p screen at 150%.
const EDGE = 8;

async function assertInside(page, locator, label) {
  const box = await locator.boundingBox();
  assert.ok(box, `${label} must be rendered`);
  // The Electron engine has no Playwright viewport; read the page's own height.
  const height = await page.evaluate('window.innerHeight');
  assert.ok(box.y >= 0 && box.y + box.height <= height - EDGE + 0.5,
    `${label} must stay inside the window (bottom ${Math.round(box.y + box.height)}px, window ${height}px)`);
}

export default {
  name: 'new-task-project-menu-fit',
  entry: './project-menu-fixture.tsx',
  viewport: { width: 1280, height: 600 },
  real: 'FolderPickerPopover with the real Radix popover placement',
  notCovered: 'The full new-task page and its data sources; the pill is placed at the same offsets as on that page.',
  stubs: { 'src/renderer/contexts/AuthContext': { partial: 'export const useAuth = () => ({dataOwnerId: "fixture", isAuthenticated: false});' } },
  cases: {
    default: { about: 'Minimum window height keeps both bottom actions inside the window' },
    '1080p-150': {
      about: 'Maximized 1080p screen at 150% scaling',
      viewport: { width: 1280, height: 688 },
    },
  },
  async ready(page) { await page.getByTestId('open-project-menu').waitFor(); },
  async check(page, ui) {
    await page.getByTestId('open-project-menu').click();
    const menu = page.getByRole('dialog');
    await menu.waitFor();
    await ui.capture('project-menu');
    await assertInside(page, menu, 'Project menu');
    const action = async (key) => menu.getByRole('button', { name: await ui.t(key), exact: true });
    await assertInside(page, await action('projectSettings.createTitle'), 'New project action');
    await assertInside(page, await action('newChat.projectPicker.addRemoteProject'), 'Add remote project action');
  },
};
