export default {
  name: 'model-advanced', entry:'./model-advanced-fixture.tsx',
  viewport:{width:1000,height:800},
  real:'ModelAdvancedDrawer, buildUnionRows, bundled per-engine reasoning metadata, preference writes, themes and translations',
  notCovered:'Account entitlement and live model calls; host context, speed availability and price read/write responses are in-memory fixture inputs; no real persistence or billing',
  cases:{
    'pricing-controls':{about:'Native currency and reset focus during deferred saves'},
    'pricing-controls-narrow':{about:'Currency and reset focus at 320px',viewport:{width:320,height:800}},
    pricing:{about:'Inline token prices, invalid required values revert, zero saves, reset restores reference'},
    'pricing-narrow':{about:'Inline token pricing at 320px width',viewport:{width:320,height:800}},
    default:{about:'GPT-6 Astra with Codex Ultrafast entitlement'},
    narrow:{about:'Model compaction at phone width', viewport:{width:320,height:800}},
    sol:{about:'GPT-6.1 Sol with Codex Ultrafast entitlement'},
    'legacy-sol':{about:'GPT-6 Sol reasoning metadata'},
    unavailable:{about:'Account has not enabled Ultrafast'},
    'owner-repair':{about:'Same-owner generation change recovers an in-flight image capability save'},
  },
  async check(page,ui) {
    if (ui.case.startsWith('pricing')) {
      const input = page.locator('[data-model-price-input]').first();
      await input.waitFor();
      await page.waitForFunction(() => document.querySelector('[data-model-price-input]')?.value === '2');
      const pricing = input.locator('xpath=ancestor::section[1]');
      await pricing.scrollIntoViewIfNeeded();
      await ui.capture('pricing-reference', { locator: pricing });
      if (ui.case.startsWith('pricing-controls')) {
        const currency = pricing.getByRole('combobox');
        await currency.focus();
        await currency.selectOption('CNY');
        await page.waitForFunction(() => document.querySelector('section[aria-busy]')?.getAttribute('aria-busy') === 'true');
        if (!await currency.evaluate(el => !el.disabled && document.activeElement === el)) throw Error('Currency lost focus during save');
        await page.keyboard.press('Tab');
        if (!await input.evaluate(el => document.activeElement === el)) throw Error('Tab did not reach price input during currency save');
        await page.keyboard.press('Shift+Tab');
        if (!await currency.evaluate(el => document.activeElement === el)) throw Error('Shift+Tab did not return to currency during save');
        await ui.capture('currency-saving', { locator: pricing });
        await page.evaluate(() => window.__uiPage.emit('settlePriceMutation'));
        await page.waitForFunction(() => document.querySelector('section[aria-busy]')?.getAttribute('aria-busy') === 'false');
        if (!await currency.evaluate(el => document.activeElement === el)) throw Error('Currency lost focus after save');
        const reset = pricing.getByRole('button', { name: await ui.t('settings.providers.models.priceOverride.resetShort'), exact: true });
        await reset.click();
        if (!await reset.evaluate(el => !el.disabled && document.activeElement === el)) throw Error('Reset lost focus during pending work');
        await ui.capture('reset-pending', { locator: pricing });
        await page.evaluate(() => window.__uiPage.emit('settlePriceMutation'));
        await page.waitForFunction(() => document.querySelector('section[aria-busy]')?.getAttribute('aria-busy') === 'false');
        if (!await input.evaluate(el => document.activeElement === el && el.value === '2')) throw Error('Reset did not settle focus on the price input');
        await ui.capture('controls-settled', { locator: pricing });
        return;
      }

      await input.fill('');
      await input.press('Enter');
      if (await input.inputValue() !== '' || !await input.evaluate(el => document.activeElement === el)) throw Error('Enter submitted the Settings draft');
      await input.press('Escape');
      await page.waitForFunction(() => document.querySelector('[data-model-price-input]')?.value === '2');
      await ui.capture('pricing-invalid-restored', { locator: pricing });
      await input.fill('0');
      await input.press('Tab');
      const reset = pricing.getByRole('button', { name: await ui.t('settings.providers.models.priceOverride.resetShort'), exact: true });
      await page.waitForFunction(() => document.querySelector('section[aria-busy]')?.getAttribute('aria-busy') === 'false');
      if (await reset.isDisabled()) throw Error('Valid zero did not enable reset');
      await ui.capture('pricing-custom-zero', { locator: pricing });
      await input.fill('8');
      await input.press('Escape');
      await page.waitForFunction(() => document.querySelector('section[aria-busy]')?.getAttribute('aria-busy') === 'false');
      if (await input.inputValue() !== '8' || await input.evaluate(el => document.activeElement === el)) throw Error('Escape did not blur and save the draft');
      await ui.capture('pricing-escape-saved', { locator: pricing });
      await reset.click();
      await page.waitForFunction(() => document.querySelector('[data-model-price-input]')?.value === '2');
      await ui.capture('pricing-reset', { locator: pricing });
      return;
    }
    const ultra=page.getByRole('radio',{name:await ui.t('effortLevels.ultra'),exact:true});
    await ultra.waitFor();
    const clipped=await ultra.evaluate(el=>{
      const group=el.closest('[role=radiogroup]');
      const box=el.getBoundingClientRect(), bounds=group.getBoundingClientRect();
      return box.left<bounds.left || box.right>bounds.right || group.scrollWidth>group.clientWidth+1;
    });
    await ui.capture('initial');
    if(clipped) throw Error('Reasoning options are clipped or require horizontal scrolling');
    await ultra.click();
    if(await ultra.getAttribute('aria-checked')!=='true') throw Error('Ultra default was not saved');
    const speed = page.getByText(await ui.t('newChat.modelSelector.speed.ultrafast'), {exact:true});
    const capability = await speed.locator('..').textContent();
    const expected = ['unavailable', 'legacy-sol'].includes(ui.case) ? 'unsupported' : 'supported';
    if (!capability?.includes(await ui.t(`settings.providers.models.advanced.${expected}`))) {
      throw Error('Ultrafast capability does not match the account');
    }
    await ui.capture('ultra-selected');
    const imageInput = page.getByRole('button', { name: await ui.t('settings.providers.models.advanced.imageInput'), exact: true });
    await imageInput.click();
    await ui.capture('image-input-options');
    await page.getByRole('menuitemradio', { name: await ui.t('settings.providers.models.advanced.unsupported'), exact: true }).click();
    if (ui.case === 'owner-repair') {
      if (!(await imageInput.isDisabled())) throw Error('In-flight image save should disable the control');
      await page.evaluate(() => window.__uiPage.emit('authChanged', {}));
      await page.waitForFunction(label => {
        const button = [...document.querySelectorAll('button')].find(el => el.getAttribute('aria-label') === label);
        return button && !button.disabled;
      }, await ui.t('settings.providers.models.advanced.imageInput'));
      await ui.capture('image-input-owner-recovered');
    }
    if (!(await imageInput.textContent()).includes(await ui.t('settings.providers.models.advanced.unsupported'))) throw Error('Explicit image input false was not shown');
    await imageInput.click();
    await page.getByRole('menuitemradio', { name: await ui.t('settings.providers.models.advanced.imageCapability.default'), exact: true }).click();
    const compaction = page.locator('[data-model-compaction]');
    await compaction.locator('summary').click();
    const trigger = compaction.getByRole('button');
    await trigger.click();
    await ui.capture('compaction-options');
    await page.getByRole('menuitemradio', { name: '80%', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-model-compaction] button')?.textContent?.includes('80%'));
    await compaction.scrollIntoViewIfNeeded();
    await ui.capture('model-compaction');
    await ui.capture('model-compaction-closeup', { locator: compaction });
    await trigger.click();
    await page.getByRole('menuitemradio', { name: await ui.t('settings.providers.models.advanced.restoreDefault'), exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-model-compaction] button')?.textContent?.includes('90%'));
    await compaction.scrollIntoViewIfNeeded();
    await ui.capture('default-compaction');
    await ui.capture('default-compaction-closeup', { locator: compaction });
  },
};
