import assert from 'node:assert/strict';

export default {
  name: 'conversation-search',
  entry: './fixture.tsx',
  viewport: { width: 360, height: 340 },
  real: 'SearchResultsBody, SearchResultRow, TaskTagDots and theme tokens',
  notCovered: 'Live database search, device-link transport and the mobile native screen',
  cases: {
    default: { about: 'Labels beside short/long search titles; untagged and old-host results' },
    narrow: { about: 'Labels stay visible in the narrow sidebar', viewport: { width: 260, height: 340 } },
  },
  async check(page) {
    const row = page.locator('[data-session-id="fixture-1"]');
    for (const name of ['Important', 'Later']) {
      const dot = row.getByLabel(name, { exact: true });
      assert(await dot.isVisible(), `${name} label remains visible`);
      const dotBox = await dot.boundingBox();
      const rowBox = await row.boundingBox();
      assert(dotBox && rowBox && dotBox.x + dotBox.width <= rowBox.x + rowBox.width,
        'labels remain inside the row');
    }
    await row.getByRole('button').click();
    assert.equal(await page.locator('body').getAttribute('data-selected-session'), 'fixture-1');
  },
};
