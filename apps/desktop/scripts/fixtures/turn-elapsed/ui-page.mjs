import assert from 'node:assert/strict';
import teammateProcess from '../teammate-process/ui-page.mjs';

export default {
  name: 'turn-elapsed',
  entry: './fixture.tsx',
  viewport: { width: 720, height: 600 },
  stubs: teammateProcess.stubs,
  real: 'MessageStream, AssistantMessage, MessageActionBar, WorkGroupBlock, elapsed calculation, actual i18n and themes',
  notCovered: 'Synthetic timestamps reproduce #9806; no original private timeline, model run, persistence or native mobile UI.',
  cases: {
    default: { about: 'Whole request spans 1h 0m 30s; last work segment spans 7m 37s' },
    narrow: { about: 'Elapsed metadata wraps at 320px', viewport: { width: 320, height: 600 } },
    'missing-start': { about: 'Unloaded user boundary cannot produce whole-request elapsed', data: { missingStart: true } },
    island: { about: 'Disjoint history windows cannot produce whole-request elapsed', data: { island: true } },
  },
  async check(page, ui) {
    const reply = page.locator('[data-message-client-id="final"]');
    await reply.hover();
    const label = await ui.t('chat.messageActionBar.turnElapsed', {
      duration: await ui.t('usageDetails.durationHoursMinutes', { hours: 1, minutes: 0 }),
    });
    if (ui.data.missingStart || ui.data.island) {
      assert.equal(await page.getByText(label, { exact: true }).count(), 0);
      return;
    }
    const elapsed = page.getByText(label, { exact: true });
    await elapsed.waitFor();
    await ui.capture('both-clocks');
    await elapsed.hover();
    const description = await ui.t('chat.messageActionBar.turnElapsedDescription');
    const elapsedTip = page.getByRole('tooltip').filter({ hasText: description });
    await elapsedTip.waitFor();
    // Electron sizes the native window, so Playwright viewportSize() is null.
    // Radix's role=tooltip is a hidden accessibility copy; measure the visible popper.
    const bounds = await elapsedTip.evaluate(element => {
      const rect = element.closest('[data-radix-popper-content-wrapper]').getBoundingClientRect();
      return { left: rect.left, right: rect.right, viewportWidth: window.innerWidth };
    });
    assert.ok(bounds.left >= 0 && bounds.right <= bounds.viewportWidth,
      'Timing explanation must fit the viewport, including at 320px');
    await ui.capture('elapsed-scope');
    await page.mouse.move(1, 1);
    const segment = page.getByText(await ui.t('chat.workGroup.worked', { duration: '7m 37s' }), { exact: true });
    await segment.hover();
    await page.getByRole('tooltip').filter({ hasText: await ui.t('chat.workGroup.durationDescription') }).waitFor();
    await ui.capture('segment-scope');
  },
};
