import assert from 'node:assert/strict';
export default {
  name: 'provider-name-search', entry: './fixture.tsx', viewport: { width: 1000, height: 900 },
  real: 'Production custom endpoint name search, complete bundled catalog, and existing supplier configuration wizard',
  notCovered: 'Real credentials, OAuth, model discovery and persistence. Host reads are fixtures. Native app coexistence is verified separately.',
  cases: {
    default: { about: 'Supplier matches appear directly below the free-text name' },
    custom: { about: 'Unmatched names remain valid custom endpoint names' },
    jump: { about: 'Selecting DeepSeek opens its existing configuration form' },
  },
  async check(page, ui) {
    const input = page.getByRole('combobox');
    const query = ui.case === 'custom' ? 'My private gateway' : 'dee';
    await input.fill(query);
    await page.getByText(await ui.t('settings.providers.custom.nameSearchHint'), { exact: true }).waitFor();
    assert.equal(await page.getByText('匹配的供应商', { exact: true }).count(), 0);
    if (ui.case === 'custom') {
      assert.equal(await page.getByRole('option').count(), 0);
      assert.equal(await input.inputValue(), query);
    } else {
      const option = page.getByRole('option', { name: /DeepSeek/ }).first();
      await option.waitFor();
      if (ui.case === 'jump') {
        await option.click();
        await page.getByRole('button', { name: await ui.t('settings.providers.wizard.next'), exact: true }).waitFor();
        assert.equal(await page.getByRole('combobox').count(), 0);
      }
    }
  },
};
