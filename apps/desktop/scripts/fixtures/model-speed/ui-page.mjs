export default {
  name: 'model-speed',
  entry: './model-speed-fixture.tsx',
  viewport: { width: 360, height: 500 },
  real: 'ModelConfigFlyout, SpeedIcon, speed menu, themes and translations',
  notCovered: 'Account entitlement, live model requests, database persistence and native mobile controls',
  cases: {
    default: { about: 'GPT-6 Astra: catalog reasoning levels and Ultrafast speed' },
    sol: { about: 'GPT-6.1 Sol: catalog reasoning levels and Ultrafast speed' },
    'remote-context': { about: '#9501: remote 1M is not replaced by local same-model 272K' },
  },
  async check(page, ui) {
    if (ui.case === 'remote-context') {
      const expected = await ui.t('newChat.modelSelector.meta.context', { value: '1M' });
      if (!(await page.locator('main').innerText()).includes(expected)) {
        throw new Error('Remote context window was replaced by local metadata');
      }
      await ui.capture('remote-context');
      return;
    }
    const button = page.getByRole('button', { name: await ui.t('newChat.modelSelector.speed.label'), exact: true });
    await button.click();
    await page.getByRole('menuitemradio', { name: await ui.t('newChat.modelSelector.speed.ultrafast'), exact: true }).waitFor();
    await ui.capture('speed-menu');
    await page.getByRole('menuitemradio', { name: await ui.t('newChat.modelSelector.speed.standard'), exact: true }).click();
    if (await button.getAttribute('title') !== await ui.t('newChat.modelSelector.speed.standard')) throw new Error('Standard selection was lost');
    await button.click();
    await page.getByRole('menuitemradio', { name: await ui.t('newChat.modelSelector.speed.fast'), exact: true }).click();
    if (await button.getAttribute('title') !== await ui.t('newChat.modelSelector.speed.fast')) throw new Error('Fast selection was lost');
    await button.click();
    await page.getByRole('menuitemradio', { name: await ui.t('newChat.modelSelector.speed.ultrafast'), exact: true }).click();
    if (await button.getAttribute('title') !== await ui.t('newChat.modelSelector.speed.ultrafast')) throw new Error('Ultrafast selection was lost');
    const slider = page.getByRole('slider');
    await slider.focus();
    await slider.press('End');
    if (await slider.getAttribute('aria-valuetext') !== 'Ultra') throw new Error('Catalog Ultra reasoning level was lost');
    await page.mouse.click(8, 8);
    await slider.hover();
    await ui.capture('ultra-reasoning');
  },
};
