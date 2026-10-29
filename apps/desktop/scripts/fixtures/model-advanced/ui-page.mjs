export default {
  name: 'model-advanced', entry:'./model-advanced-fixture.tsx',
  viewport:{width:1000,height:800},
  real:'ModelAdvancedDrawer, buildUnionRows, bundled per-engine reasoning metadata, preference writes, themes and translations',
  notCovered:'Account entitlement and live model calls; host context result and speed availability are fixture inputs',
  cases:{
    default:{about:'GPT-6 Astra with Codex Ultrafast entitlement'},
    narrow:{about:'Model compaction at phone width', viewport:{width:320,height:800}},
    sol:{about:'GPT-6.1 Sol with Codex Ultrafast entitlement'},
    'legacy-sol':{about:'GPT-6 Sol reasoning metadata'},
    unavailable:{about:'Account has not enabled Ultrafast'},
  },
  async check(page,ui) {
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
    const compaction = page.locator('[data-model-compaction]');
    await compaction.locator('summary').click();
    // 滑杆用键盘驱动（与 model-speed fixture 同一手法）：90 → 80 共十次 ArrowLeft。
    const thumb = compaction.getByRole('slider');
    await thumb.focus();
    await ui.capture('compaction-slider');
    for (let step = 0; step < 10; step += 1) {
      const before = await thumb.getAttribute('aria-valuenow');
      await thumb.press('ArrowLeft');
      // 等数值真的前进一步再按下一格，不靠固定时序赌写入快慢。
      await page.waitForFunction(
        (prev) => document.querySelector('[data-model-compaction] [role="slider"]')?.getAttribute('aria-valuenow') !== prev,
        before,
      );
    }
    await page.waitForFunction(() => document.querySelector('[data-model-compaction] span.tabular-nums')?.textContent?.trim() === '80%');
    await compaction.scrollIntoViewIfNeeded();
    await ui.capture('model-compaction');
    await ui.capture('model-compaction-closeup', { locator: compaction });
    await compaction.getByRole('button', { name: await ui.t('settings.providers.models.advanced.compaction.restoreAria'), exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-model-compaction] span.tabular-nums')?.textContent?.trim() === '90%');
    await compaction.scrollIntoViewIfNeeded();
    await ui.capture('default-compaction');
    await ui.capture('default-compaction-closeup', { locator: compaction });
  },
};
