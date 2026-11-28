import assert from 'node:assert/strict';

export default {
  name: 'svn-review',
  entry: './fixture.tsx',
  viewport: { width: 420, height: 360 },
  real: 'Review panel, diff lines, source and action controls',
  notCovered: 'SVN execution and session lookup (integration test)',
  cases: { default: { about: 'Read a working-copy edit in the existing Review tab', data: {} } },
  async check(page, ui) {
    await page.getByText('SVN', { exact: true }).waitFor();
    await page.getByText('WalkSpeed = 6', { exact: false }).last().waitFor();
    assert.equal(await page.locator('[data-review-file-id]').count(), 1);
    await ui.capture('working-copy');
  },
};
