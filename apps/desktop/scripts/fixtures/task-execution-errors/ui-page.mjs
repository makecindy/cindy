import assert from 'node:assert/strict';

export default {
  name: 'task-execution-errors',
  entry: './task-execution-errors-fixture.tsx',
  viewport: { width: 560, height: 440 },
  real: 'Live ErrorBanner, failed automation banner, historical error card, subagent error notice, ErrorNotice, localized details and redaction',
  notCovered: 'Live scheduler execution, host transport and new-task navigation; covered separately by targeted tests',
  cases: {
    default: { about: 'Historical automatic execution failure' },
    narrow: { about: 'Automatic execution failure at 320 px', viewport: { width: 320, height: 540 } },
    history: { about: 'Historical task execution error' },
    subagent: { about: 'Subagent execution error' },
    'resume-live': { about: '#10187: known resume refusal explains a usable recovery path and suppresses unchanged retry' },
    'resume-live-narrow': { about: '#10187: live refusal at 320 px', viewport: { width: 320, height: 540 } },
    'resume-history-narrow': { about: '#10187: persisted refusal at 320 px', viewport: { width: 320, height: 540 } },
  },
  async check(page, ui) {
    const show = page.getByRole('button', { name: await ui.t('chat.errorBanner.networkShowRaw'), exact: true });
    const diagnose = page.getByRole('button', { name: await ui.t('chat.errorBanner.diagnose'), exact: true });
    assert.equal(await show.getAttribute('aria-expanded'), 'false');
    assert.equal(await diagnose.count(), 0);
    const resume = ui.case.startsWith('resume-');
    if (resume) {
      assert.ok(await page.getByText(await ui.t('chat.remoteError.REMOTE_AGENT_RESUME_REJECTED'), { exact: true }).isVisible());
      assert.equal(await page.getByRole('button', { name: await ui.t('chat.errorBanner.retry'), exact: true }).count(), 0);
      assert.equal(await page.locator('[data-retry-count]').getAttribute('data-retry-count'), '0');
    }
    await show.click();
    if (resume) {
      assert.ok(await page.getByText(/this conversation cannot be resumed on this computer/).isVisible());
    } else {
      assert.ok(await page.getByText(/provider identity does not match/).isVisible());
      assert.equal(await page.getByText(/private-fixture-value/).count(), 0);
    }
    await diagnose.click();
    assert.equal(await page.locator('[data-diagnosis-count]').getAttribute('data-diagnosis-count'), '1');
  },
};
