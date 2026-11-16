import assert from 'node:assert/strict';

export default {
  name: 'unexecuted-tool-markup',
  entry: './fixture.tsx',
  viewport: { width: 320, height: 380 },
  real: 'ErrorBanner and ErrorMessageCard with the Pi text-only tool failure reason',
  notCovered: 'Provider, Windows GUI, SSH execution, full composer status and mobile native rendering',
  cases: { default: { about: 'Live and persisted guidance at narrow width' } },
  async check(page, ui) {
    const text = await ui.t('logic.errors.unexecutedToolMarkup');
    assert.equal(await page.getByText(text, { exact: true }).count(), 2);
    assert.equal(await page.getByText('fallback', { exact: true }).count(), 0);
  },
};
