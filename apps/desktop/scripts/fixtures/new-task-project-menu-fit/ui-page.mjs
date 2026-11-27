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
    // Review on #13341: here both the section above the actions and the list scroll.
    // With the pointer kept on project rows, wheeling past the list's end must move
    // the section too, otherwise the rows it hides stay unreachable.
    'row-wheel-short': {
      // 560px: the section scrolls while part of the list is still on screen.
      about: 'Window shorter than the menu needs: wheeling over project rows reaches the last project',
      viewport: { width: 1280, height: 560 },
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
    if (ui.case !== 'row-wheel-short') return;

    const section = menu.locator('[data-folder-picker-section]');
    const list = menu.locator('[data-folder-picker-scroll]');
    const sectionScrolls = await section.evaluate((el) => el.scrollHeight > el.clientHeight + 1);
    assert.ok(sectionScrolls, 'This window must be short enough for the section above the actions to scroll');
    // Keep the pointer just above the section's visible bottom, inside the part of the
    // list that is already on screen: that point stays over the list while the list and
    // then the section scroll.
    const box = await section.boundingBox();
    const listBox = await list.boundingBox();
    const visibleListTop = Math.max(box.y, listBox.y);
    const visibleListBottom = Math.min(box.y + box.height, listBox.y + listBox.height);
    assert.ok(visibleListBottom - visibleListTop >= 24,
      `Part of the project list must be on screen (visible ${Math.round(visibleListBottom - visibleListTop)}px)`);
    const x = box.x + box.width / 2;
    const y = visibleListBottom - 12;
    await page.mouse.move(x, y);
    // Runs in the page: a string body keeps this Node-side file free of browser globals.
    const overRow = () => page.evaluate(
      `Boolean(document.elementFromPoint(${x}, ${y})?.closest('[data-folder-picker-scroll]'))`,
    );
    assert.ok(await overRow(), 'The pointer must start on a project row');
    for (let i = 0; i < 40; i += 1) {
      await page.mouse.wheel(0, 120);
      await page.waitForTimeout(30);
    }
    assert.ok(await overRow(), 'The pointer must still be on a project row');
    const lastRow = list.locator('[data-folder-picker-index]').last();
    const visible = await lastRow.evaluate((row) => {
      const r = row.getBoundingClientRect();
      const s = row.closest('[data-folder-picker-section]').getBoundingClientRect();
      const l = row.closest('[data-folder-picker-scroll]').getBoundingClientRect();
      return r.top >= Math.max(s.top, l.top) - 1 && r.bottom <= Math.min(s.bottom, l.bottom) + 1;
    });
    await ui.capture('scrolled-to-last-project');
    assert.ok(visible, 'Wheeling over project rows must bring the last project fully into view');
    assert.ok(await section.evaluate((el) => el.scrollTop > 0), 'Reaching the last project must have scrolled the section');

    // The mirror case: wheel up with the pointer still on project rows. The list
    // scrolls back to its first project, then the section returns to the heading.
    for (let i = 0; i < 40; i += 1) {
      await page.mouse.wheel(0, -120);
      await page.waitForTimeout(30);
    }
    assert.ok(await overRow(), 'The pointer must still be on a project row after wheeling up');
    assert.equal(await list.evaluate((el) => el.scrollTop), 0, 'Wheeling up must bring the list back to its first project');
    assert.equal(await section.evaluate((el) => el.scrollTop), 0, 'Wheeling up must bring the section back to the heading');
    await ui.capture('scrolled-back-to-heading');
  },
};
