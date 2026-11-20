import assert from 'node:assert/strict';
/* global document, innerHeight, getComputedStyle -- evaluated in the browser page */

// #8702 integration tier: real FolderPickerPopover/Radix/product CSS must keep
// footer actions reachable at 800x600. jsdom search/wheel tests cannot lay out the
// popover; a twelve-project menu is the smallest representative overflow input.
// Additional checks protect the active scroller, sticky search, focus and resize.
export default {
  name: 'project-picker-layout', entry: './picker-fixture.tsx',
  viewport: { width: 800, height: 600 },
  real: 'FolderPickerPopover, PopoverContent, product styles and browser scrolling',
  notCovered: 'Full App, real project persistence, native directory dialogs and device connections.',
  stubs: {
    'src/renderer/features/cc-agent/sidebar/ProjectIcon': 'export const ProjectIcon = () => null;',
    'src/renderer/features/cc-agent/hooks/useProjectInfo': 'export const useProjectInfo = () => undefined;',
    'src/renderer/lib/recentWorkdirsStore': 'export const recentWorkdirsStore = { remove: async () => {} };',
  },
  cases: {
    default: { about: 'Project menu: constrained height, wheel, search, keyboard and resize' },
    recent: { about: 'ChatInput recent-directory mode retains list scrolling and cancel/reopen' },
    schedule: { about: 'Real schedule ProjectChip selects a directory and restores dialogue/local destination' },
  },
  async ready(page) { await page.locator('[data-testid="open-picker"], [data-testid="schedule-trigger"]').waitFor(); },
  async check(page, ui) {
    const open = async () => {
      if (ui.case === 'schedule') await page.getByTestId('schedule-trigger').getByRole('button').click();
      else await page.getByTestId('open-picker').click();
      await page.getByRole('dialog').waitFor();
      await page.waitForFunction(() => document.getAnimations().every(a => a.playState !== 'running'));
    };
    const footerLabel = await ui.t(ui.case === 'recent' ? 'newChat.folderPicker.browseFolder'
      : ui.case === 'schedule' ? 'newChat.folderPicker.browseProjectFolder' : 'projectSettings.createTitle');
    const geometry = () => page.evaluate(() => {
      const menu = document.querySelector('[role="dialog"]');
      const rect = el => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height }; };
      const scroller = menu.querySelector('[data-folder-picker-scroll="true"]');
      const search = menu.querySelector('input');
      return {
        height: innerHeight, menu: rect(menu),
        footer: [...menu.querySelectorAll(':scope > button')].map(rect),
        scroll: scroller && { ...rect(scroller), topOffset: scroller.scrollTop, client: scroller.clientHeight, full: scroller.scrollHeight },
        search: search && rect(search),
        scrollableRegions: [...menu.querySelectorAll('div')].filter(el =>
          /auto|scroll/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 1,
        ).length,
      };
    });
    const footerFits = async () => {
      const g = await geometry();
      assert.ok(g.menu.top >= 0 && g.menu.bottom <= g.height + 1, JSON.stringify(g));
      assert.ok(g.footer.every(r => r.top >= g.menu.top && r.bottom <= g.height + 1), 'Footer actions must be in the window');
      assert.equal(g.scrollableRegions, 1, 'Use one physically scrollable region, without nested scrollbars');
      return g;
    };
    const wheel = async (locator, deltaY) => {
      await locator.hover();
      const before = (await geometry()).scroll.topOffset;
      await page.mouse.wheel(0, deltaY);
      await page.waitForFunction(({ before, deltaY }) => {
        const el = document.querySelector('[data-folder-picker-scroll="true"]');
        return deltaY > 0 ? el.scrollTop > before : el.scrollTop < before;
      }, { before, deltaY });
    };
    await open();
    await footerFits(); // This assertion fails on the trusted pre-fix main.
    if (ui.case === 'schedule') {
      await page.getByRole('textbox').fill('Project 9');
      await page.getByRole('button', { name: 'Project 9 /synthetic/project-9', exact: true }).click();
      const output = page.getByTestId('selected-path');
      assert.equal(await output.textContent(), '/synthetic/project-9');
      assert.equal(await output.getAttribute('data-kind'), 'project');
      assert.equal(await output.getAttribute('data-destination'), 'local');
      await open();
      await page.getByRole('button', { name: await ui.t('newChat.folderPicker.dialogue'), exact: true }).click();
      assert.equal(await output.textContent(), '');
      assert.equal(await output.getAttribute('data-kind'), 'dialogue');
      return;
    }
    if (ui.case === 'default') {
      const search = page.getByRole('textbox');
      await wheel(page.getByRole('button', { name: footerLabel, exact: true }), 180);
      await wheel(search, 120);
      await search.fill('Project');
      await page.waitForFunction(() => {
        const first = [...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent.startsWith('Project 0'));
        const input = document.querySelector('[role="dialog"] input');
        return first && first.getBoundingClientRect().top >= input.getBoundingClientRect().bottom;
      });
      const first = page.getByRole('button', { name: 'Project 0 /synthetic/project-0', exact: true });
      await search.focus();
      await search.press('Tab');
      assert.equal(await first.evaluate(el => el === document.activeElement), true);
      const firstBox = await first.boundingBox(), searchBox = await search.boundingBox();
      assert.ok(firstBox.y >= searchBox.y + searchBox.height - 1, 'Keyboard focus must clear the sticky search');
      await first.press('Shift+Tab');
      assert.equal(await search.evaluate(el => el === document.activeElement), true);
      await search.press('Enter');
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      assert.equal(await page.getByTestId('selected-path').textContent(), '/synthetic/project-0');
      await open();
      assert.equal(await page.getByRole('textbox').inputValue(), '', 'Reopen clears search');
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForFunction(() => {
      const scroller = document.querySelector('[data-folder-picker-scroll="true"]');
      return scroller && scroller.clientHeight === 252;
    });
    await footerFits();
    const heading = page.getByText(await ui.t(ui.case === 'recent' ? 'newChat.folderPicker.recent' : 'newChat.folderPicker.projects'), { exact: true });
    // Five recent rows overflow by only 28px: leave room for each wheel action.
    const step = ui.case === 'recent' ? 4 : 60;
    await wheel(heading, step);
    await wheel(page.locator('[data-folder-picker-scroll="true"]'), step);
    if (ui.case === 'default') await wheel(page.getByRole('textbox'), 60);
    await wheel(page.getByRole('button', { name: footerLabel, exact: true }), -step);
    await page.setViewportSize({ width: 800, height: 600 });
    await page.waitForFunction(() => document.querySelector('[role="dialog"]').getBoundingClientRect().bottom <= innerHeight + 1);
    await footerFits();
    if (ui.case === 'default') {
      await page.getByRole('button', { name: footerLabel, exact: true }).click();
      assert.equal(await page.getByTestId('selected-path').textContent(), 'create');
      await open();
      await page.getByRole('button', { name: await ui.t('newChat.projectPicker.addRemoteProject'), exact: true }).click();
      assert.equal(await page.getByTestId('selected-path').textContent(), 'remote');
    } else {
      await page.getByRole('button', { name: footerLabel, exact: true }).click();
      assert.equal(await page.getByRole('dialog').count(), 1, 'Cancel keeps recent picker open');
      await page.getByRole('dialog').press('Escape'); await open();
    }
    await ui.capture('validated-menu');
  },
};
