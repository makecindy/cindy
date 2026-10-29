import assert from 'node:assert/strict';

export default {
  name: 'provider-usage',
  entry: './provider-usage-fixture.tsx',
  viewport: { width: 960, height: 1000 },
  real: 'ProviderUsageSection, usage filters, breakdown tables, segmented control, daily bars, heatmap, translations and themes',
  notCovered: 'Live usage retrieval, remote management, share mutations and actual device connectivity',
  cases: {
    default: { about: 'One card with people, current computers and models; removed-computer history stays in totals' },
    'no-group': { about: 'Provider without a group offers people and models only' },
  },
  async ready(page) {
    await page.getByRole('tabpanel').waitFor();
  },
  async check(page, ui) {
    const tabs = page.getByRole('tablist', { name: await ui.t('providerGroup.usage.title') });
    const pick = async (dimension) => tabs.getByRole('tab', { name: await ui.t(`providerGroup.usage.stack.${dimension}`) }).click();
    assert.equal(await page.getByRole('tabpanel').count(), 1);
    assert.equal(await page.getByTestId('provider-usage-computer').count(), 0);
    assert.equal(await page.getByTestId('provider-usage-model').count(), 0);
    const summary = await page.getByTestId('provider-usage-summary').textContent();
    if (ui.case === 'no-group') {
      assert.equal(await tabs.getByRole('tab').count(), 2);
      assert.equal(await page.getByRole('combobox', { name: await ui.t('providerGroup.usage.filter.computerAria') }).count(), 0);
    } else {
      await page.getByRole('combobox', { name: await ui.t('providerGroup.usage.filter.computerAria') }).click();
      const list = page.getByRole('listbox');
      await list.waitFor();
      assert.equal(await list.getByRole('option').count(), 3);
      assert.equal(await list.getByRole('option', { name: /Retired Studio/ }).count(), 0);
      await ui.capture('computer-filter');
      await page.keyboard.press('Escape');
      await pick('computer');
      assert.equal(await page.getByTestId('provider-usage-row').count(), 0);
      assert.deepEqual(await page.getByTestId('provider-usage-computer').evaluateAll((rows) => rows.map((row) => row.dataset.computerKey)), ['local', 'device:studio', '']);
      await ui.capture('by-computer');
    }
    await pick('model');
    assert.equal(await page.getByTestId('provider-usage-computer').count(), 0);
    assert.equal(await page.getByTestId('provider-usage-model').count(), 2);
    assert.equal(await page.getByTestId('provider-usage-summary').textContent(), summary);
    await ui.capture('by-model');
    await pick('party');
    assert.equal(await page.getByTestId('provider-usage-row').count(), 2);
  },
};
