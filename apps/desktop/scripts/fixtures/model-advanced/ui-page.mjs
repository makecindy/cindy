export default {
  name: 'model-advanced', entry:'./model-advanced-fixture.tsx',
  viewport:{width:1000,height:800},
  real:'ModelAdvancedDrawer, buildUnionRows, bundled per-engine reasoning metadata, preference writes, themes and translations',
  notCovered:'Account entitlement and live model calls; host context result and speed availability are fixture inputs',
  cases:{
    default:{about:'GPT-6 Astra with Codex Ultrafast entitlement'},
    'interface-reset':{about:'Explicit Kimi interface source and reset back to the current catalog default; in-memory save only'},
    narrow:{about:'Model compaction at phone width', viewport:{width:320,height:800}},
    sol:{about:'GPT-6.1 Sol with Codex Ultrafast entitlement'},
    'legacy-sol':{about:'GPT-6 Sol reasoning metadata'},
    unavailable:{about:'Account has not enabled Ultrafast'},
    'owner-repair':{about:'Same-owner generation change recovers an in-flight image capability save'},
  },
  async check(page,ui) {
    if (ui.case === 'interface-reset') {
      await page.getByText(await ui.t('settings.providers.models.advanced.protocol.sourceModel'), {exact:true}).waitFor();
      const button = page.getByRole('button', {name: `Codex · ${await ui.t('settings.providers.custom.fields.wireProtocol')}`, exact:true});
      if (!(await button.textContent()).includes('Chat Completions')) throw Error('Explicit interface label differs from route');
      await ui.capture('explicit-interface');
      await button.click();
      await page.getByRole('menuitemradio', {name: await ui.t('settings.providers.models.advanced.protocol.automatic'), exact:true}).waitFor();
      await ui.capture('interface-menu');
      await page.getByRole('menuitem', {name: await ui.t('settings.providers.models.advanced.protocol.restoreRoute'), exact:true}).click();
      await page.getByText(await ui.t('settings.providers.models.advanced.protocol.sourceCatalog'), {exact:true}).waitFor();
      const descriptionId = await page.getByRole('switch', {name: /Codex/}).getAttribute('aria-describedby');
      if (!descriptionId || !(await page.locator(`[id="${descriptionId}"]`).textContent()).includes('Responses')) {
        throw Error('Reset did not follow the catalog interface');
      }
      if (await button.count()) throw Error('The restored catalog interface should be a read-only label');
      await ui.capture('catalog-restored');
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
