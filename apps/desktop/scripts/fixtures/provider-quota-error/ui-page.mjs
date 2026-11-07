import assert from 'node:assert/strict';

export default {
  name: 'provider-quota-error',
  entry: './provider-quota-error-fixture.tsx',
  viewport: { width: 560, height: 400 },
  real: 'ErrorBanner, ErrorTailErrorBanner, localized provider quota summary and raw error disclosure',
  notCovered: 'Live API calls, provider billing, account balance changes and retry execution',
  cases: {
    default: { about: '#8705: custom provider balance error has an actionable summary' },
    gateway: { about: 'Positive control: a known Cindy source exposes the balance action by its accessible name' },
    'unknown-source': { about: 'Unknown source gets a quota summary without a Cindy recharge action' },
    tail: { about: 'Persisted error uses the same quota summary' },
    narrow: { about: 'Quota summary wraps on a narrow display', viewport: { width: 320, height: 480 } },
  },
  async check(page, ui) {
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
