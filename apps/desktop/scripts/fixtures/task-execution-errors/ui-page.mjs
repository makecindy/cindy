import assert from 'node:assert/strict';

export default {
  name: 'task-execution-errors',
  entry: './task-execution-errors-fixture.tsx',
  viewport: { width: 560, height: 440 },
  real: 'Failed automation banner, historical error card, subagent error notice, ErrorNotice, localized details and redaction',
  notCovered: 'Live scheduler execution, host transport and new-task navigation; covered separately by targeted tests',
  cases: {
    default: { about: 'Historical automatic execution failure' },
    narrow: { about: 'Automatic execution failure at 320 px', viewport: { width: 320, height: 540 } },
    history: { about: 'Historical task execution error' },
    subagent: { about: 'Subagent execution error' },
  },
  async check(page, ui) {
    const show = page.getByRole('button', { name: await ui.t('chat.errorBanner.networkShowRaw'), exact: true });
    const diagnose = page.getByRole('button', { name: await ui.t('chat.errorBanner.diagnose'), exact: true });
    assert.equal(await show.getAttribute('aria-expanded'), 'false');
    assert.equal(await diagnose.count(), 0);
    await show.click();
    assert.ok(await page.getByText(/provider identity does not match/).isVisible());
    assert.equal(await page.getByText(/private-fixture-value/).count(), 0);
    await diagnose.click();
    assert.equal(await page.locator('[data-diagnosis-count]').getAttribute('data-diagnosis-count'), '1');
  },
};
