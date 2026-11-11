import assert from 'node:assert/strict';

export default {
  name: 'provider-quota-error',
  entry: './provider-quota-error-fixture.tsx',
  viewport: { width: 560, height: 400 },
  real: 'ErrorBanner, ErrorTailErrorBanner, localized provider quota summary and raw error disclosure',
  notCovered: 'Live API calls, provider billing, account balance changes and retry execution',
  cases: {
    upstream: { about: '#7180: reported upstream resource-package error does not offer Cindy recharge' },
    'upstream-no-billing': { about: '#7180: upstream guidance remains visible without a billing callback' },
    default: { about: '#8705: custom provider balance error has an actionable summary' },
    gateway: { about: 'Positive control: a known Cindy source exposes the balance action by its accessible name' },
    'unknown-source': { about: 'Unknown source gets a quota summary without a Cindy recharge action' },
    tail: { about: 'Persisted error uses the same quota summary' },
    narrow: { about: 'Quota summary wraps on a narrow display', viewport: { width: 320, height: 480 } },
  },
  async check(page, ui) {
    const upstream = ui.case.startsWith('upstream');
    const gateway = ui.case === 'gateway';
    assert.ok(await page.getByText(await ui.t(upstream ? 'chat.errorBanner.gatewayUpstreamQuotaExhausted' : gateway ? 'chat.errorBanner.gatewayQuotaExhausted' : 'providerError.QUOTA_EXCEEDED'), { exact: true }).isVisible());
    assert.equal(await page.getByText(await ui.t('chat.errorBanner.replyFailed'), { exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: await ui.t('chat.errorBanner.viewBalance'), exact: true }).count(), gateway ? 1 : 0);
    const details = page.getByRole('button', { name: await ui.t('chat.errorBanner.networkShowRaw'), exact: true });
    assert.equal(await details.getAttribute('aria-expanded'), 'false');
    await details.click();
    assert.ok(await page.getByText(upstream ? '429 throttling_error provider_rate_limited: The upstream provider rate limit was exceeded. 余额不足或无可用资源包,请充值。' : '402: {"message":"OpenAIException - Insufficient Balance","type":"insufficient_balance_error"}', { exact: true }).isVisible());
  },
};
