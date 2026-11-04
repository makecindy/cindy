import assert from 'node:assert/strict';

export default {
  name: 'usage-cost-details',
  entry: './usage-cost-fixture.tsx',
  viewport: { width: 720, height: 760 },
  real: 'MessageActionBar, UsageCostPopover, UsageCostDetails, useUsageCostDetails and local transport',
  notCovered: 'Scenario billing data; no paid model request or remote device connection.',
  cases: {
    default: { about: 'One model in subscription and Cindy AI channels; two additional models' },
    narrow: { about: 'Same detail panel at 320 px', viewport: { width: 320, height: 760 } },
    legacy: { about: 'Older host has no breakdown; do not show zero', data: { legacy: true } },
  },
  async check(page, ui) {
    const trigger = page.getByRole('button').filter({ hasText: /1\.53/ });
    assert.match(await trigger.innerText(), /\+.*3\.34/);
    await trigger.hover();
    const panel = page.getByRole('dialog');
    await panel.waitFor();
    if (!ui.data.legacy) {
      await panel.getByText('seedance-2.0', { exact: true }).waitFor();
      assert.equal(await panel.getByText('gpt-6.1', { exact: true }).count(), 2);
    } else await panel.getByText(await ui.t('usageCost.unavailable'), { exact: true }).waitFor();
    await trigger.click();
    await page.mouse.move(1, 1);
    await page.waitForTimeout(350);
    assert.equal(await panel.isVisible(), true, 'Click pins the hover panel');
    await ui.capture('details', { locator: panel });
    await page.keyboard.press('Escape');
    await panel.waitFor({ state: 'hidden' });
    await trigger.focus();
    await page.keyboard.press('Enter');
    await panel.waitFor();
    await page.keyboard.press('Escape');
    await panel.waitFor({ state: 'hidden' });
  },
};
