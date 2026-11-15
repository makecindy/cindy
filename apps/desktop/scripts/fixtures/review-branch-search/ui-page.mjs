import assert from 'node:assert/strict';

// #10633: jsdom cannot measure popup wrapping or narrow sidebar toolbar overlap.
// Render the production selector/header, with two names differing only at the suffix.
export default {
  name: 'review-branch-search',
  entry: './fixture.tsx',
  viewport: { width: 800, height: 540 },
  real: 'BranchBaseDropdown, ReviewDiffListHeader, standard Input/Popover/menu rows, themes and translations',
  notCovered: 'Git operations, diff fetching, remote transport and full Desktop lifecycle',
  cases: Object.fromEntries(
    [320, 420, 600].map((width) => [
      width === 320 ? 'default' : `sidebar-${width}`,
      {
        about: 'Long similar branch names remain distinguishable without widening the toolbar',
        data: { width },
      },
    ]),
  ),
  async check(page, ui) {
    const trigger = page.getByTestId('review-branch-base-control').getByRole('button');
    const before = await trigger.boundingBox();
    const actions = await page.getByTestId('review-diff-list-header-actions').boundingBox();
    assert.ok(
      before.x + before.width <= actions.x,
      'Branch trigger must not overlap toolbar actions',
    );
    await trigger.click();
    await page.getByRole('dialog').or(page.getByRole('menu')).waitFor();
    await ui.capture('branches');
    const search = page.getByRole('combobox');
    assert.equal(await search.count(), 1, 'Branch picker needs a search field');
    assert.equal(await search.evaluate((el) => document.activeElement === el), true);
    const option = page.getByRole('option').filter({ hasText: 'comparison-second' });
    assert.equal(
      await option.getAttribute('title'),
      'feature/shared-long-prefix-for-review-comparison-second',
    );
    assert.equal(await option.evaluate((el) => el.scrollWidth <= el.clientWidth), true);
    await search.fill('COMPARISON-SECOND');
    assert.equal(await page.getByRole('option').count(), 1);
    await ui.capture('filtered');
    await search.press('Enter');
    assert.match(await trigger.textContent(), /comparison-second/);
    assert.deepEqual(await trigger.boundingBox(), before, 'Selection must not resize the toolbar');
    await trigger.click();
    assert.equal(await search.inputValue(), '');
    const expectActiveHighlight = async () => {
      await page.waitForFunction(
        () => {
          const input = document.querySelector('[role="combobox"]');
          const row = document.getElementById(input?.getAttribute('aria-activedescendant'));
          const layer = document.querySelector('[data-menu-highlight-layer]');
          if (!row?.hasAttribute('data-menu-active') || !layer) return false;
          const rowBox = row.getBoundingClientRect();
          const layerBox = layer.getBoundingClientRect();
          return (
            getComputedStyle(layer).opacity === '1' &&
            Math.abs(rowBox.y - layerBox.y) < 1 &&
            Math.abs(rowBox.height - layerBox.height) < 1
          );
        },
        undefined,
        { timeout: 1500 },
      );
    };
    await expectActiveHighlight();
    const scrollTop = await page.getByRole('listbox').evaluate((el) => el.scrollTop);
    await search.press('ArrowUp');
    await expectActiveHighlight();
    assert.equal(
      await page.getByRole('listbox').evaluate((el) => el.scrollTop),
      scrollTop,
      'Adjacent keyboard highlight must update without a scroll event',
    );
    const activeId = await search.getAttribute('aria-activedescendant');
    assert.equal(
      await page.locator(`[id="${activeId}"]`).textContent(),
      'feature/shared-long-prefix-for-review-comparison-first',
    );
    await page.locator(`[id="${activeId}"]`).hover();
    await expectActiveHighlight();
    await search.press('ArrowDown');
    await expectActiveHighlight();
    assert.match(
      await page.locator('[role="option"][data-menu-active]').textContent(),
      /comparison-second/,
      'Keyboard navigation must reclaim the highlight from the stationary pointer',
    );
    await ui.capture('keyboard-highlight');
    await search.press('ArrowUp');
    await expectActiveHighlight();
    await search.press('ArrowUp');
    await search.press('ArrowUp');
    const lastId = await search.getAttribute('aria-activedescendant');
    const last = page.locator(`[id="${lastId}"]`);
    assert.equal(await last.textContent(), 'feature/branch-19');
    const lastBox = await last.boundingBox();
    const listBox = await page.getByRole('listbox').boundingBox();
    assert.ok(
      lastBox.y >= listBox.y && lastBox.y + lastBox.height <= listBox.y + listBox.height + 1,
      'Keyboard navigation must scroll the active branch into view',
    );
    await search.fill('no-such-branch');
    assert.equal(await page.getByRole('option').count(), 0);
    assert.equal(
      await page.getByRole('status').textContent(),
      await ui.t('newChat.branchChip.noMatch'),
    );
    await ui.capture('empty');
    await search.press('Escape');
    await page.waitForFunction(
      (el) => document.activeElement === el,
      await trigger.elementHandle(),
    );
    await trigger.click();
  },
};
