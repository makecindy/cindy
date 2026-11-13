import assert from 'node:assert/strict';
export default {
  name: 'composer-add-menu', entry: './fixture.tsx', viewport: { width: 720, height: 1000 },
  real: 'ExtraDirsButton, MorphPopover, AtMentionPanel',
  notCovered: 'Live plugin discovery and file selection; entries are scenario data',
  cases: {
    default: { about: '#9573 regression: omitted height cap with a long list on a tall window' },
    'new-task': { about: 'Explicit 240px cap remains effective' },
    short: { about: 'Viewport still limits the default cap', viewport: { width: 720, height: 360 } },
  },
  async check(page, ui) {
    const panel = page.getByRole('group', { name: await ui.t('extraDirs.menuAria') });
    await panel.waitFor();
    const height = (await panel.boundingBox()).height;
    assert.ok(height <= (ui.case === 'new-task' ? 240 : 400) + 1, `Menu height: ${height}`);
    const scroller = page.locator('[data-composer-suggestion-panel] > div');
    const dimensions = await scroller.evaluate(el => ({ client: el.clientHeight, scroll: el.scrollHeight }));
    assert.ok(dimensions.scroll > dimensions.client, 'Long list must overflow internally');
    await scroller.hover();
    await page.mouse.wheel(0, 2000);
    await page.waitForFunction(() => document.querySelector('[data-composer-suggestion-panel] > div').scrollTop > 0);
    await ui.capture('scrolled');
    await page.locator('[data-composer-suggestion-search]').fill('notes-23');
    await page.waitForFunction(() => document.querySelector('[data-composer-suggestion-panel]').getBoundingClientRect().height < 200);
    assert.ok(await page.getByText('notes-23.md', { exact: true }).isVisible());
  },
};
