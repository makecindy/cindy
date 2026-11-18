import assert from 'node:assert/strict';

export default {
  name: 'google-subscription-controls', entry: './fixture.tsx',
  viewport: { width: 560, height: 680 },
  real: 'ModelConfigFlyout, EffortSlider, GoogleSubscriptionUsageChip and QuotaHoverCard with production translations/themes',
  notCovered: 'Real authentication, ACP transport and whole-app persistence; fixture metadata mirrors the separately verified official 1.5.9 control receipts',
  stubs: { 'src/renderer/hooks/useProviders': `export const useProviders = () => ({ providers: [{ id: 'google-antigravity-subscription', access: { kind: 'subscription', product: 'Google AI Pro' } }] });` },
  cases: {
    default: { about: 'Hydrogen has four native thought levels, no Fast and unknown account quota' },
    flash: { about: 'Flash has exactly three native levels', data: { flash: true } },
    fixed: { about: 'Orchestrator explains fixed reasoning without a fake slider', data: { fixed: true } },
    narrow: { about: 'Controls and usage card at 320px', viewport: { width: 320, height: 680 } },
    quota: { about: 'Grouped account balances and reset windows at 320px', viewport: { width: 320, height: 680 }, data: { quota: true } },
  },
  async check(page, ui) {
    if (ui.data.fixed) assert.equal(await page.getByRole('slider').count(), 0);
    else {
      const slider = page.getByRole('slider');
      await slider.focus(); await page.keyboard.press('End');
      assert.equal(await page.getByTestId('selected-thought').textContent(), ui.data.flash ? 'high' : 'xhigh');
    }
    await ui.capture('model-controls');
    await page.getByRole('button', { name: await ui.t('googleSubscription.usage') }).click();
    const card = page.getByTestId('quota-hover-card');
    if (ui.data.quota) {
      await card.getByText(`Gemini Models · ${await ui.t('quotaCard.fiveHourLabel')}`).waitFor();
      await card.getByText(`Gemini Models · ${await ui.t('quotaCard.weeklyLabel')}`).waitFor();
      assert.ok((await card.textContent()).includes('75%'));
      assert.ok((await card.textContent()).includes('40%'));
    } else {
      await page.getByText(await ui.t('googleSubscription.quotaUnavailable')).waitFor();
      assert.ok(!(await card.textContent()).match(/\$0|100%|0%|∞/));
    }
    const box = await card.boundingBox();
    assert.ok(box && box.x >= -1 && box.x + box.width <= (await page.evaluate(() => innerWidth)) + 1);
    await ui.capture('usage');
  },
};
