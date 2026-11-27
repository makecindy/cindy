import assert from 'node:assert/strict';

// Regression for the new-task page device menu on short windows: the menu only capped
// its device list, so at Cindy's 600px minimum window height (or a maximized 1080p
// screen at 150%, ~688px) its lower devices fell outside the window and could not be
// reached. The layout is the same on every platform.
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
  name: 'new-task-device-menu-fit',
  entry: './device-menu-fixture.tsx',
  viewport: { width: 1280, height: 600 },
  real: 'DeviceSwitcherPill with the real Radix popover placement',
  notCovered: 'The full new-task page, device discovery and switching; the pill is placed at the same offsets as on that page.',
  cases: {
    default: { about: 'Minimum window height: the menu stays inside the window and every device can be scrolled into view' },
    '1080p-150': {
      about: 'Maximized 1080p screen at 150% scaling',
      viewport: { width: 1280, height: 688 },
    },
  },
  async ready(page) { await page.getByTestId('create-agent-device-pill').waitFor(); },
  async check(page, ui) {
    await page.getByTestId('create-agent-device-pill').click();
    const menu = page.getByRole('dialog');
    await menu.waitFor();
    await assertInside(page, menu, 'Device menu');
    await ui.capture('device-menu');
    const last = menu.getByTestId('create-agent-device-option').last();
    await last.scrollIntoViewIfNeeded();
    await assertInside(page, last, 'Last device');
  },
};
