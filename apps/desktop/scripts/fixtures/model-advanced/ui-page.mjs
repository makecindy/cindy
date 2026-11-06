export default {
  name: 'model-advanced', entry:'./model-advanced-fixture.tsx',
  viewport:{width:1000,height:800},
  real:'ModelAdvancedDrawer, ModelPriceOverrideDialog, buildUnionRows, bundled per-engine reasoning metadata, preference writes, themes and translations',
  notCovered:'Account entitlement, live model calls and persistent quote storage; quote API, host context result and speed availability use fixtures',
  cases:{
    pricing:{about:'Inline API price editing through the unchanged quote API'},
    'pricing-narrow':{about:'Inline API prices at phone width', viewport:{width:320,height:800}},
    'image-unknown':{about:'Undeclared image input: two explicit choices, no default'},
    'image-unsupported':{about:'Unsupported catalog default restores inheritance'},
    'image-mixed':{about:'Different engine defaults require an explicit common choice'},
    'image-inherited':{about:'Mixed override provenance with the same effective image capability'},
    default:{about:'GPT-6 Astra with Codex Ultrafast entitlement'},
    narrow:{about:'Model compaction at phone width', viewport:{width:320,height:800}},
    sol:{about:'GPT-6.1 Sol with Codex Ultrafast entitlement'},
    'legacy-sol':{about:'GPT-6 Sol reasoning metadata'},
    unavailable:{about:'Account has not enabled Ultrafast'},
    'owner-repair':{about:'Same-owner generation change recovers an in-flight image capability save'},
  },
  async check(page,ui) {
    if (ui.case.startsWith('pricing')) {
      const price = page.getByRole('region', { name: await ui.t('settings.providers.models.advanced.pricing'), exact: true });
      const input = price.getByRole('spinbutton', { name: await ui.t('settings.providers.models.priceOverride.input'), exact: true });
      await input.waitFor();
      await page.waitForFunction(label => document.querySelector('input[aria-label="' + label + '"]')?.value === '1.2', await ui.t('settings.providers.models.priceOverride.input'));
      await price.scrollIntoViewIfNeeded();
      await ui.capture('pricing-initial', { locator: price });
      await input.fill('-1');
      await price.getByRole('heading', { name: await ui.t('settings.providers.models.advanced.pricing'), exact: true }).first().click();
      if (await input.inputValue() !== '1.2') throw Error('Invalid price was not restored');
      await input.fill('0');
      await page.keyboard.press('Enter');
      if (await input.inputValue() !== '0') throw Error('Enter submitted the inline field');
      await page.keyboard.press('Escape');
      const reset = price.getByRole('button', { name: await ui.t('settings.providers.models.priceOverride.resetShort'), exact: true });
      await reset.click();
      if (await input.inputValue() !== '1.2') throw Error('Reset did not restore the reference quote');
      await ui.capture('pricing-reset', { locator: price });
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
    const knownDefault = !['image-unknown', 'image-mixed', 'image-inherited'].includes(ui.case);
    if (ui.case === 'image-inherited' && !(await imageInput.textContent()).includes(await ui.t('settings.providers.models.advanced.supported'))) throw Error('Mixed override provenance must show its common effective capability');
    const defaultSupported = ui.case !== 'image-unsupported';
    const label = async supported => {
      const value = await ui.t('settings.providers.models.advanced.' + (supported ? 'supported' : 'unsupported'));
      return knownDefault && supported === defaultSupported
        ? await ui.t('settings.providers.models.advanced.imageInputDefault', { value }) : value;
    };
    await imageInput.scrollIntoViewIfNeeded();
    await imageInput.click();
    if (await page.getByRole('menuitemradio').count() !== 2) throw Error('Image input must have exactly two choices');
    await ui.capture('image-input-options');
    await page.getByRole('menuitemradio', { name: await label(false), exact: true }).click();
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
    await page.getByRole('menuitemradio', { name: await label(true), exact: true }).click();
    if (!(await imageInput.textContent()).includes(await ui.t('settings.providers.models.advanced.supported'))) throw Error('Image input true was not shown');
    await imageInput.click();
    await ui.capture('image-input-selected');
    await page.keyboard.press('Escape');
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
    const defaultCompaction = await ui.t('settings.providers.models.advanced.compaction.default', { pct: 90 });
    await page.waitForFunction(expected => document.querySelector('[data-model-compaction] button')?.textContent?.includes(expected), defaultCompaction);
    await compaction.scrollIntoViewIfNeeded();
    await ui.capture('default-compaction');
    await ui.capture('default-compaction-closeup', { locator: compaction });
  },
};
