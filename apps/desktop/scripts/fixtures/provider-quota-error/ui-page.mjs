import assert from 'node:assert/strict';

export default {
  name: 'provider-quota-error',
  entry: './provider-quota-error-fixture.tsx',
  viewport: { width: 560, height: 400 },
  real: 'ErrorBanner, ErrorTailErrorBanner, localized provider quota summary and raw error disclosure',
  notCovered: 'Live API calls, provider billing, account balance changes and retry execution',
  cases: {
    'shared-resume': { about: '#10187: rejected shared history offers context handoff, not unchanged retry' },
    'shared-resume-tail': { about: '#10187: persisted errors use the same recovery action' },
    'shared-resume-narrow': { about: '#10187: recovery guidance and action at 320 px', viewport: { width: 320, height: 480 } },
    subscription: { about: 'Bound subscription usage limit with a trusted reset time' },
    'subscription-history': { about: 'The same account limit in persisted history' },
    'subscription-narrow': { about: 'Account binding and recovery guidance at 320 px', viewport: { width: 320, height: 480 } },
    default: { about: '#8705: custom provider balance error has an actionable summary' },
    gateway: { about: 'Positive control: a known Cindy source exposes the balance action by its accessible name' },
    'unknown-source': { about: 'Unknown source gets a quota summary without a Cindy recharge action' },
    tail: { about: 'Persisted error uses the same quota summary' },
    narrow: { about: 'Quota summary wraps on a narrow display', viewport: { width: 320, height: 480 } },
  },
  async check(page, ui) {
    if (ui.case.startsWith('shared-resume')) {
      assert.ok(await page.getByText(await ui.t('chat.remoteError.REMOTE_AGENT_RESUME_UNAVAILABLE'), { exact: true }).isVisible());
      assert.equal(await page.getByRole('button', { name: await ui.t('chat.errorBanner.retry'), exact: true }).count(), 0);
      assert.equal(await page.getByText(await ui.t('chat.remoteError.REMOTE_AGENT_INVALID'), { exact: true }).count(), 0);
      await page.getByRole('button', { name: await ui.t('sharedTaskRecovery.choose'), exact: true }).click();
      assert.equal(await page.locator('html').getAttribute('data-recovery-chosen'), 'true');
      return;
    }
    if (ui.case.startsWith('subscription')) {
      const resetAt = await page.evaluate(() => window.__uiPage.t('chat.subscriptionAccountError.limitedUntil', {
        resetAt: new Intl.DateTimeFormat(document.documentElement.lang.replace(/-x-lzh$/, '') || 'en', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(1900000000000)),
      }));
      assert.ok(await page.getByText(resetAt, { exact: true }).isVisible());
      assert.equal(await page.getByText(await ui.t('chat.errorBanner.replyFailed'), { exact: true }).count(), 0);
      return;
    }
    const gateway = ui.case === 'gateway';
    assert.ok(await page.getByText(await ui.t(gateway ? 'chat.errorBanner.gatewayQuotaExhausted' : 'providerError.QUOTA_EXCEEDED'), { exact: true }).isVisible());
    assert.equal(await page.getByText(await ui.t('chat.errorBanner.replyFailed'), { exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: await ui.t('chat.errorBanner.viewBalance'), exact: true }).count(), gateway ? 1 : 0);
    const details = page.getByRole('button', { name: await ui.t('chat.errorBanner.networkShowRaw'), exact: true });
    assert.equal(await details.getAttribute('aria-expanded'), 'false');
    await details.click();
    assert.ok(await page.getByText('402: {"message":"OpenAIException - Insufficient Balance","type":"insufficient_balance_error"}', { exact: true }).isVisible());
  },
};
