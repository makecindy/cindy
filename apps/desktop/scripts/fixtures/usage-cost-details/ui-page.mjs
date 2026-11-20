import assert from 'node:assert/strict';

export default {
  name: 'usage-cost-details',
  entry: './usage-cost-fixture.tsx',
  viewport: { width: 720, height: 760 },
  real: 'MessageActionBar, UsageCostPopover, UsageCostDetails, TurnGenerationTrace, useUsageCostDetails and local transport',
  notCovered: 'Scenario billing data; no paid model request or remote device connection.',
  cases: {
    default: { about: 'One model in subscription and Cindy AI channels; two additional models' },
    narrow: { about: 'Same detail panel at 320 px', viewport: { width: 320, height: 760 } },
    legacy: { about: 'Older host has no breakdown; do not show zero', data: { legacy: true } },
    trace: { about: 'A three-request turn: its speed and reasoning per request above the details', data: { traceRequests: 3 } },
    'trace-long': { about: 'A 140-request turn drawn at the same width', data: { traceRequests: 140 } },
    'trace-narrow': { about: 'The 140-request turn at 320 px', data: { traceRequests: 140 }, viewport: { width: 320, height: 760 } },
    'trace-unreported': { about: 'Provider reports no reasoning split: the speed curve alone, no empty lower half', data: { traceRequests: 12, traceShape: 'unreported' } },
    'trace-strokes-only': { about: 'A turn too short for a speed curve: strokes without an empty band above', data: { traceRequests: 3, traceShape: 'strokes-only' } },
    'trace-empty': { about: 'Neither a curve nor reported reasoning: no chart, the panel as before', data: { traceRequests: 2, traceShape: 'empty' } },
    'trace-no-price': { about: 'No price for the model: the token count opens the same chart, without a cost section', data: { traceRequests: 12, noPrice: true } },
  },
  async check(page, ui) {
    if (ui.data.noPrice) {
      // Without a price the cell shows tokens; it opens the same chart and no cost section.
      const tokens = page.getByRole('button').filter({ hasText: /5\.7k/ });
      await tokens.click();
      const panel = page.getByRole('dialog');
      await panel.waitFor();
      await panel.getByTestId('turn-generation-trace').waitFor();
      assert.match(await panel.getByTestId('turn-thinking-share').innerText(), /(<1|\d+)%/);
      assert.equal(await panel.getByTestId('usage-cost-details').count(), 0, 'No cost section without a price');
      await ui.capture('details', { locator: panel });
      await page.keyboard.press('Escape');
      await panel.waitFor({ state: 'hidden' });
      return;
    }
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
    const shape = ui.data.traceShape ?? 'full';
    if (ui.data.traceRequests && shape === 'unreported') {
      const chart = panel.getByTestId('turn-generation-trace');
      assert.equal(await chart.getByTestId('thinking-stroke').count(), 0, 'No strokes without a reported split');
      const box = await chart.getByRole('img').boundingBox();
      assert.equal(box.height < 60, true, `Speed-only chart keeps no lower half: ${box.height}`);
    } else if (ui.data.traceRequests && shape === 'strokes-only') {
      const chart = panel.getByTestId('turn-generation-trace');
      assert.equal(await chart.getByTestId('thinking-stroke').count() > 0, true);
      const box = await chart.getByRole('img').boundingBox();
      assert.equal(box.height < 40, true, `Strokes-only chart keeps no empty band: ${box.height}`);
    } else if (ui.data.traceRequests && shape === 'full') {
      const chart = panel.getByTestId('turn-generation-trace');
      // One line for the whole turn: the share of its output that was reasoning, then the request count.
      assert.match(await chart.getByTestId('turn-thinking-share').innerText(), /(<1|\d+)%/, 'The caption leads with the reasoning share');
      assert.match(await chart.locator('div').last().innerText(), new RegExp(String(ui.data.traceRequests)), 'The caption gives the request count');
      assert.equal(await chart.getByTestId('thinking-stroke').count() <= 28, true, 'A turn of any length keeps to 28 strokes');
      // The pointer picks a moment: a mark on the chart, and that moment's speed above it.
      const box = await chart.getByRole('img').boundingBox();
      await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.5);
      await chart.getByTestId('trace-pick').waitFor();
      assert.match(await page.getByTestId('trace-readout').innerText(), /\d/);
      await ui.capture('picked-moment');
      // Leaving the chart for the caption under it clears the pick and keeps the panel open.
      await chart.locator('div').last().hover();
      await page.getByTestId('trace-readout').waitFor({ state: 'detached' });
    } else {
      assert.equal(await panel.getByTestId('turn-generation-trace').count(), 0, 'No chart without a stored trace');
    }
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
