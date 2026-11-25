import assert from 'node:assert/strict';
import sharp from 'sharp';

// Regression: ba6b3003ef8 moved the sidebar tint to a child that excluded its
// parent's 1px border. jsdom and the blur performance specimen cannot detect
// the resulting bright native-backdrop leak. Exercise the real shell and CSS
// in Electron, including the minimum failing input: no wallpaper, visibility 0.
export default {
  name: 'sidebar-divider',
  entry: './fixture.tsx',
  viewport: { width: 800, height: 360 },
  real: 'ContentHeaderSlot, useChromeActionsOverlap, Sidebar, useSidebarMaterial, useWallpaperBackground and production theme/CSS',
  notCovered: 'Native macOS material generation; task list, account and update contents',
  stubs: {
    'src/renderer/components/sidebar/SidebarTopNav': 'export const SidebarTopNav = () => null;',
    'src/renderer/components/sidebar/UpdateBanner': 'export const UpdateBanner = () => null;',
    'src/renderer/components/sidebar/DatabaseSizeWarningBanner': 'export const DatabaseSizeWarningBanner = () => null;',
    'src/renderer/components/sidebar/NativeBuildBanner': 'export const NativeBuildBanner = () => null;',
    'src/renderer/components/sidebar/UserInfoSection': 'export const UserInfoSection = () => null;',
    'src/renderer/features/cc-agent/sidebar/conversationSearchContext': 'export const ConversationSearchProvider = ({ children }) => children;',
  },
  cases: {
    'empty-left': { about: '#11830: a preceding left pane owns zoomed chrome; empty route has no blank header' },
    'empty-top': { about: '#11830: a preceding top pane owns zoomed chrome; empty route has no blank header' },
    'empty-direct': { about: '#11830: chat directly beside the narrow sidebar retains its overflow header' },
    'inbox-zoom': { about: '#11830: 50% keeps inbox on the first row and 100% restores the chosen width' },
    'inbox-zoom-70': { about: '#11830: the approved 70% layout keeps the full toolbar on one row' },
    'inbox-peek': { about: '#11830: pinning reserves the same width as the expanded drawer' },
    'inbox-resize': { about: '#11830: dragging starts at the displayed divider and can still enter rail' },
    'inbox-normal': { about: '#8656: default 260px expanded sidebar at 100% keeps inbox in the top row' },
    'inbox-wide': { about: '#8656: 360px expanded sidebar at 50% keeps inbox in the top row' },
    default: { about: 'No wallpaper, 0% desktop visibility keeps the original backdrop: border must retain its tinted backing' },
    half: { about: '50% desktop visibility: the sidebar keeps its own tint at 85% of the main veil, separated only by its divider' },
    transparent: { about: '100% desktop visibility: both tints are clear; on macOS only the native sidebar frost remains' },
    wallpaper: { about: 'Wallpaper canvas and tint adjustment remain continuous at the border' },
    rail: { about: 'Narrow sidebar has the same backed hairline' },
    hidden: { about: 'Fully collapsed sidebar leaves no residual line' },
    peek: { about: 'Peek drawer border shares its frosted backing' },
  },
  async check(page, ui) {
    const aside = page.locator('aside.bg-sidebar');
    const bounds = await aside.boundingBox();
    assert.ok(bounds);
    if (ui.case.startsWith('empty-')) {
      const main = page.locator('[data-empty-route]');
      const header = main.locator('header');
      const content = page.locator('[data-full-page-content]');
      const direct = ui.case === 'empty-direct';
      await page.waitForFunction((direct) => !!document.querySelector('[data-empty-route] header') === direct, direct);
      const checkTop = async (hasHeader) => {
        const mainBox = await main.boundingBox();
        const contentBox = await content.boundingBox();
        assert.ok(mainBox && contentBox);
        assert.equal(contentBox.y - mainBox.y, hasHeader ? 46 : 0,
          'Full-page content only leaves a row when its own pane overlaps chrome');
      };
      await checkTop(direct);
      if (!direct) {
        await page.locator('[data-toggle-owner]').click();
        await header.waitFor();
        await checkTop(true);
        const hole = main.locator('[data-testid="content-header-rail-chrome-actions-hit-hole"]');
        assert.equal(await hole.evaluate(el => el.getBoundingClientRect().width), 20);
        await page.locator('[data-toggle-owner]').click();
        await header.waitFor({ state: 'detached' });
        await checkTop(false);
      }
      await ui.capture('empty-route-placement');
      return;
    }
    if (ui.case.startsWith('inbox-')) {
      const button = page.locator('[data-task-list-mode-toggle]');
      await button.waitFor();
      const zoom = ui.case === 'inbox-normal' ? 1 : ui.case === 'inbox-zoom-70' ? 0.7 : 0.5;
      const expectedWidth = ui.case === 'inbox-normal' ? 260 :
        ui.case === 'inbox-wide' ? 360 : zoom === 0.7 ? 280 : 324;
      const assertFirstRow = async (width, factor) => {
        const sidebar = await aside.boundingBox();
        const box = await button.boundingBox();
        assert.ok(sidebar && box);
        assert.ok(box.y < sidebar.y + 46, 'Inbox belongs in the first chrome row');
        assert.equal(sidebar.width, width);
        assert.ok(box.x >= sidebar.x + 78 / factor + 124 + 8 &&
          box.x + box.width <= sidebar.x + width - 8,
          'Inbox stays to the right of all four chrome buttons and clear of the resize handle');
      };
      await assertFirstRow(expectedWidth, zoom);
      if (ui.case === 'inbox-peek') {
        await page.waitForFunction(width =>
          document.querySelector('main').getBoundingClientRect().left === width, expectedWidth);
      }
      if (ui.case === 'inbox-resize') {
        const handle = await aside.locator('[class*="group/handle"]').boundingBox();
        assert.ok(handle);
        const startX = handle.x + 2;
        await page.mouse.move(startX, 180);
        await page.mouse.down();
        await page.mouse.move(startX - 20, 180);
        await assertFirstRow(expectedWidth, zoom);
        await page.mouse.up();
        assert.equal(await page.evaluate(() => localStorage.getItem('sidebar-width')), '260');
        await page.mouse.move(startX, 180);
        await page.mouse.down();
        await page.mouse.move(startX + 22, 180);
        await assertFirstRow(expectedWidth + 22, zoom);
        await page.mouse.up();
        assert.equal(await page.evaluate(() => localStorage.getItem('sidebar-width')), '346');
        await page.mouse.move(startX + 22, 180);
        await page.mouse.down();
        await page.mouse.move(90, 180);
        await button.waitFor({ state: 'detached' });
        await page.mouse.up();
        assert.equal((await aside.boundingBox()).width, 78);
        assert.equal(await page.evaluate(() => localStorage.getItem('sidebar-width')), '346');
        return;
      }
      await button.click();
      assert.equal(await button.getAttribute('aria-pressed'), 'true');
      await button.click();
      assert.equal(await button.getAttribute('aria-pressed'), 'false');
      await ui.capture('inbox-visible');
      if (ui.case === 'inbox-zoom') {
        await ui.emit('appearance', { windowZoom: 1 });
        await page.waitForFunction(() => document.querySelector('aside.bg-sidebar').getBoundingClientRect().width === 260);
        await assertFirstRow(260, 1);
        assert.equal(await page.evaluate(() => localStorage.getItem('sidebar-width')), '260');
      }
      return;
    }
    if (ui.case === 'hidden') {
      assert.equal(bounds.width, 0, 'Collapsed sidebar has no visible width');
      return;
    }
    assert.equal(bounds.width, ui.case === 'rail' ? 78 : 260);
    await page.mouse.move(700, 200);
    const { data, info } = await sharp(await page.screenshot({ scale: 'css' })).raw().toBuffer({ resolveWithObject: true });
    const x = Math.round(bounds.x + bounds.width) - 1;
    const pixel = (column) => Array.from(data.subarray((180 * info.width + column) * info.channels, (180 * info.width + column) * info.channels + 3));
    const border = pixel(x), tint = pixel(x - 8);
    const contrast = Math.max(...border.map((value, index) => Math.abs(value - tint[index])));
    // A 8–10% ink hairline changes at most 26 levels. Allow raster rounding,
    // but reject the >90-level untinted stripe on the neutral backdrop.
    assert.ok(contrast > 2 && contrast < 40, `Border must be a subtle line over sidebar tint: border=${border}, tint=${tint}`);
    if (ui.case === 'peek') return;
    const handle = aside.locator('[class*="group/handle"]');
    const line = handle.locator('div');
    const idle = await line.evaluate(el => getComputedStyle(el).backgroundColor);
    await handle.hover();
    await page.waitForFunction(() => {
      const line = document.querySelector('aside [class*="group/handle"] > div');
      return line && getComputedStyle(line).backgroundColor !== 'rgba(0, 0, 0, 0)';
    });
    await ui.capture('hover');
    await page.mouse.move(700, 200);
    await page.waitForFunction(color => getComputedStyle(document.querySelector('aside [class*="group/handle"] > div')).backgroundColor === color, idle);
  },
};
