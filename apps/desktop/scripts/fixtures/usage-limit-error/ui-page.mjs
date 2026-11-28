import assert from 'node:assert/strict';

const raw = "You've hit your session limit · resets 4:10pm (Asia/Shanghai)";
const summaryKey = {
  default: 'chat.errorBanner.usageLimitReached',
  narrow: 'chat.errorBanner.usageLimitReached',
  cancelled: 'chat.errorBanner.usageLimitReachedWithReset',
  fallback: 'chat.errorBanner.usageLimitReachedWithReset',
  tail: 'chat.errorBanner.usageLimitReachedWithReset',
  history: 'chat.errorBanner.usageLimitReached',
};

export default {
  name: 'usage-limit-error',
  entry: './usage-limit-error-fixture.tsx',
  viewport: { width: 720, height: 320 },
  real: 'ErrorBanner, ErrorTailErrorBanner, ErrorMessageCard, account usage-limit summary, automatic continuation notice and raw error disclosure',
  notCovered: 'Real account limits, reset-time resolution on the computer, the automatic continuation itself and cancelling it',
  cases: {
    default: { about: 'Waiting for the reset: the summary names the usage limit without expanding details' },
    fallback: { about: 'Details list the failed models while the summary still describes the last error' },
    cancelled: { about: 'No automatic continuation: the summary still names the limit and its expected reset' },
    tail: { about: 'Persisted error uses the same summary' },
    history: { about: 'Older error row in the message stream names the usage limit' },
    narrow: { about: 'Summary and actions wrap on a narrow display', viewport: { width: 320, height: 480 } },
  },
  async check(page, ui) {
    const withReset = summaryKey[ui.case].endsWith('WithReset');
    const summary = await ui.t(summaryKey[ui.case]);
    const visible = withReset
      ? page.getByText(summary.split('{{resetAt}}')[0], { exact: false })
      : page.getByText(summary, { exact: true });
    assert.ok(await visible.first().isVisible());
    assert.equal(await page.getByText(await ui.t('chat.errorBanner.replyFailed'), { exact: true }).count(), 0);
    const waiting = ui.case === 'default' || ui.case === 'narrow';
    assert.equal(
      await page.getByRole('button', { name: await ui.t('chat.errorBanner.usageLimitAutoContinueCancel'), exact: true }).count(),
      waiting ? 1 : 0,
    );
    assert.equal(await page.getByText(raw, { exact: true }).count(), 0);
    await page.getByRole('button', { name: await ui.t('chat.errorBanner.networkShowRaw'), exact: true }).click();
    if (ui.case === 'fallback') {
      const details = page.locator('pre').filter({ hasText: 'grok-4.7' });
      assert.ok(await details.isVisible());
      assert.ok((await details.textContent()).includes(`gpt-6.1-terra: ${raw}`));
    } else {
      assert.ok(await page.getByText(raw, { exact: true }).isVisible());
    }
  },
};
