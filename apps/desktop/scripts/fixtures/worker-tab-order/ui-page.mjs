import assert from 'node:assert/strict';
export default {
  name: 'worker-tab-order',
  entry: './worker-tab-order-fixture.tsx',
  viewport: { width: 800, height: 260 },
  real: 'WorkerListToolbar, SortableList, Worker tab-order preference, themes and translations',
  notCovered: 'Full Desktop restart, real account switching, remote host integration and mobile UI',
  stubs: {
    'src/renderer/hooks/useAppShortcut': `export const useAppShortcutDisplay = () => '';`,
  },
  cases: {
    default: { about: 'Pointer drag, keyboard reorder, click focus, and restoring order after remount' },
    narrow: { about: 'Horizontal overflow and drag at compact sidebar width', viewport: { width: 360, height: 260 } },
  },
  async check(page, ui) {
    const strip = page.getByTestId('worker-tabs-scroller');
    const ids = () => strip.locator('[data-sortable-id]').evaluateAll((els) => els.map((el) => el.dataset.sortableId));
    const tab = (id) => strip.locator(`[data-sortable-id="${id}"] [data-worker-tab]`);
    await tab('frontend').waitFor();
    await ui.capture('before');
    const a = await tab('frontend').boundingBox();
    const b = await tab('reviewer').boundingBox();
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(a.x + a.width / 2 + 8, a.y + a.height / 2, { steps: 4 });
    await page.waitForFunction(() => document.body.classList.contains('xdt-sorting'));
    await page.mouse.move(b.x + b.width - 8, b.y + b.height / 2, { steps: 20 });
    await page.waitForFunction(() => document.querySelector('[data-sortable-id]')?.getAttribute('data-sortable-id') === 'reviewer');
    await page.mouse.up();
    assert.deepEqual((await ids()).slice(0, 2), ['reviewer', 'frontend']);
    assert.equal(await page.getByTestId('focused-worker').textContent(), 'frontend');
    await page.mouse.move(10, 230);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Remount', exact: true }).click();
    assert.deepEqual((await ids()).slice(0, 2), ['reviewer', 'frontend']);
    await tab('frontend').focus();
    await page.keyboard.press('Alt+ArrowLeft');
    assert.deepEqual((await ids()).slice(0, 2), ['frontend', 'reviewer']);
    await tab('reviewer').click();
    assert.equal(await page.getByTestId('focused-worker').textContent(), 'reviewer');
    await tab('frontend').focus();
    await page.keyboard.press('Alt+ArrowRight');
    await ui.capture('reordered');
    if (ui.case === 'narrow') {
      const start = await tab('frontend').boundingBox();
      const viewport = await strip.boundingBox();
      await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
      await page.mouse.down();
      await page.mouse.move(start.x + start.width / 2 + 8, start.y + start.height / 2, { steps: 4 });
      await page.waitForFunction(() => document.body.classList.contains('xdt-sorting'));
      await page.mouse.move(viewport.x + viewport.width - 3, start.y + start.height / 2, { steps: 10 });
      await page.waitForFunction(() => {
        const el = document.querySelector('[data-testid="worker-tabs-scroller"]');
        return el.scrollLeft + el.clientWidth >= el.scrollWidth - 2;
      });
      // Keep the pointer at the viewport edge. Once the dragged item is last,
      // research has moved to its left; targeting research's old rectangle
      // would move the item backwards again.
      const endX = viewport.x + viewport.width - 2;
      await page.mouse.move(endX - 8, start.y + start.height / 2, { steps: 4 });
      await page.mouse.move(endX, start.y + start.height / 2, { steps: 8 });
      await page.waitForFunction(() => {
        const rows = document.querySelectorAll('[data-testid="worker-tabs-scroller"] [data-sortable-id]');
        return rows[rows.length - 1]?.getAttribute('data-sortable-id') === 'frontend';
      });
      await page.mouse.up();
      assert.equal((await ids()).at(-1), 'frontend');
      assert.equal(await page.getByTestId('focused-worker').textContent(), 'reviewer');
      await ui.capture('overflow-reordered');
    }
  },
};
