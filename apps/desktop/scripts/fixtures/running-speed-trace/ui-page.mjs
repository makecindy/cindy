import assert from 'node:assert/strict';

export default {
  name: 'running-speed-trace',
  entry: './running-speed-trace-fixture.tsx',
  viewport: { width: 520, height: 320 },
  real: 'RunningTokenRatePopover, GenerationTraceChart',
  notCovered: 'Scenario speed history; no agent runs and no status updates arrive.',
  cases: {
    default: { about: 'Three finished requests: reasoning strokes under the speed curve', data: { requests: 3 } },
    long: { about: 'Sixty requests in view: strokes share the fixed width', data: { requests: 60 } },
    'no-reasoning': { about: 'Host reported no reasoning split: the chart as it was before', data: { requests: 3, unreported: true } },
  },
  async check(page, ui) {
    await page.getByRole('button').first().click();
    const panel = page.getByRole('dialog');
    await panel.waitFor();
    const strokes = await panel.getByTestId('thinking-stroke').count();
    const share = panel.getByText(await ui.t('chat.runningStatus.thinkingShare'), { exact: true });
    if (ui.data.unreported) {
      assert.equal(strokes, 0);
      assert.equal(await share.count(), 0);
    } else {
      assert.equal(strokes > 0 && strokes <= 28, true, `strokes: ${strokes}`);
      await share.waitFor();
      // The pointer picks a moment: a mark on the chart, and that moment's speed above it.
      const box = await panel.getByRole('img').boundingBox();
      await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
      await panel.getByTestId('trace-pick').waitFor();
      assert.match(await page.getByTestId('trace-readout').innerText(), /\d/);
      await ui.capture('picked-moment');
      // Regression #11543: at both ends the portal readout must stay inside the viewport.
      for (const ratio of [0.01, 0.99]) {
        await page.mouse.move(box.x + box.width * ratio, box.y + box.height * 0.5);
        await page.waitForFunction(() => {
          const readout = document.querySelector('[data-testid="trace-readout"]');
          if (!readout) return false;
          const rect = readout.getBoundingClientRect();
          return rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight;
        });
      }
      await page.mouse.move(2, 2);
      await page.getByTestId('trace-readout').waitFor({ state: 'detached' });
      assert.match(await share.locator('xpath=following-sibling::*[1]').innerText(), /^(<1|\d+)%$/);
    }
    await ui.capture('popover', { locator: panel });
  },
};
