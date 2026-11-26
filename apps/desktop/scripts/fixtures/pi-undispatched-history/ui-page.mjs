import assert from 'node:assert/strict';

export default {
  name: 'pi-undispatched-history',
  entry: './fixture.tsx',
  viewport: { width: 420, height: 300 },
  real: 'Pi retry dispatch outcome and Desktop live, tail and history error components',
  notCovered: 'Native Pi process and database persistence',
  cases: { default: { about: 'Live refusal' }, tail: { about: 'Tail refusal' }, history: { about: 'Persisted refusal' } },
  async check(page, ui) {
    assert.ok(await page.getByText(await ui.t('chat.errorBanner.piRetryHistoryTooLarge'), { exact: true }).isVisible());
  },
};
