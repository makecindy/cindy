import assert from 'node:assert/strict';

// PR #6032: real browser pointer capture/ResizeObserver and measured geometry;
// unit DOM mocks cannot prove selected-option visibility or native drag release.
export default {
  name: 'skillhub-category',
  entry: './skillhub-category-fixture.tsx',
  viewport: { width: 900, height: 420 },
  real: 'SkillCategoryFilterBar, SegmentedControl, native pointer events, ResizeObserver and themes',
  notCovered: 'SkillHub API data, routing, cards, installation and full application layout',
  cases: { default: { about: 'Release outside, horizontal drag, click selection and shrinking/expanding the available width' } },
  async ready(page) {
    await page.getByRole('radiogroup', { name: 'Categories' }).waitFor();
  },
  async check(page, ui) {
    const scroller = page.getByTestId('skill-category-filter-scroller');
    const centered = async () => {
      await page.waitForFunction(() => {
        const bar = document.querySelector('[data-testid="skill-category-filter-scroller"]');
        const selected = bar.querySelector('[aria-checked="true"]');
        const a = bar.getBoundingClientRect();
        const b = selected.getBoundingClientRect();
        return b.left >= a.left - 1 && b.right <= a.right + 1
          && Math.abs((b.left + b.right - a.left - a.right) / 2) < 2;
      });
    };
    await centered();
    assert.equal(await scroller.getByRole('button').count(), 0);
    let box = await scroller.boundingBox();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    const before = await scroller.evaluate((element) => element.scrollLeft);
    // Leave vertically before crossing the horizontal drag threshold, release
    // outside, then return: hovering must not start an orphaned drag.
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, box.y + box.height + 35);
    await page.mouse.up();
    await page.mouse.move(x - 60, y);
    assert.equal(await scroller.evaluate((element) => element.scrollLeft), before);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 60, y, { steps: 4 });
    await page.mouse.up();
    const dragged = await scroller.evaluate((element) => element.scrollLeft);
    assert.ok(dragged > before + 40);
    await page.mouse.move(x - 100, y);
    assert.equal(await scroller.evaluate((element) => element.scrollLeft), dragged);
    assert.equal(await scroller.locator('[aria-checked="true"]').textContent(), 'Category 5');
    await page.getByRole('radio', { name: 'Category 5', exact: true }).click();
    assert.equal(await scroller.evaluate((element) => element.scrollLeft), dragged);
    await page.getByRole('radio', { name: 'Category 6', exact: true }).click();
    await centered();
    assert.equal(await scroller.locator('[aria-checked="true"]').textContent(), 'Category 6');
    for (const width of [220, 560]) {
      await page.getByTestId('category-available-width').evaluate((element, size) => {
        element.style.width = size + 'px';
      }, width);
      await centered();
      await ui.capture('width-' + width);
    }
  },
};
